/**
 * In-browser match runner.
 *
 * GitHub Pages (and any static host) serves files but runs no code, so there is no WebSocket server
 * to join. The simulation was kept free of Node APIs for exactly this reason, so the whole match can
 * run inside the page instead: this module mirrors what server/index.js does over sockets - join,
 * input, tick, snapshot - but talks to the client through a socket-shaped object that never touches
 * the network.
 *
 * `Net` cannot tell the difference, so offline play uses the identical client code path as real
 * multiplayer. A hosted server is always preferred when one answers.
 */

import { MSG, PHASE, sanitizeInput } from '../shared/protocol.js';
import {
  TICK_RATE,
  TICK_DT,
  SNAPSHOT_RATE,
  ARENA_HALF,
  WEAPONS,
  ZONE_PHASES,
  ZONE_START_RADIUS,
  PLAYER,
  MATCH,
  BOT_NAMES,
} from '../server/config.js';
import {
  createMatch,
  addPlayer,
  removePlayer,
  setInput,
  step,
  buildSnapshot,
  buildSelf,
  clearEvents,
  fillWithBots,
  botCount,
} from '../server/sim.js';
import { updateBots } from '../server/bots.js';

/** Mirrors enough of the WebSocket interface for Net to accept it unchanged. */
class LocalSocket {
  constructor(server) {
    this.OPEN = 1;
    this.readyState = 0;
    this.server = server;
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
  }

  send(raw) {
    this.server.receive(this, raw);
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.server.detach(this);
    this.onclose?.();
  }

  /** Called by the server once the client side has finished wiring its handlers. */
  open() {
    this.readyState = 1;
    this.onopen?.();
  }

  deliver(msg) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

export class LocalMatch {
  constructor() {
    this.match = createMatch();
    this.nextId = 1;
    this.socket = null;
    this.humanId = null;
    this.running = false;

    this.frame = 0;
    this.simAccumulator = 0;
    this.snapshotTimer = 0;
    this.lastTime = 0;
    this.broadcastSeed = null;
  }

  /** One match per page: reloading gets a fresh map, rejoining does not. */
  static shared() {
    return (LocalMatch._shared ??= new LocalMatch());
  }

  createSocket() {
    const socket = new LocalSocket(this);
    // The client wires its handlers first, then calls open() to fire the handshake.
    return socket;
  }

  // ---------------------------------------------------------------- transport

  receive(socket, raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    if (msg.t === MSG.JOIN) {
      if (socket === this.socket) return;
      const name = typeof msg.name === 'string' ? msg.name.trim().slice(0, 14) || 'Player' : 'Player';
      if (!this.addHuman(socket, name)) {
        socket.deliver({ t: 'error', reason: 'The match is full' });
      }
      return;
    }

    if (msg.t === MSG.INPUT) {
      if (socket !== this.socket) return;
      const clean = sanitizeInput(msg);
      if (clean) setInput(this.match, this.humanId, clean);
    }
  }

  addHuman(socket, name) {
    const id = `p${this.nextId++}`;
    const p = addPlayer(this.match, { id, name, bot: false });
    if (!p) return false;

    if (this.match.phase === PHASE.LIVE) p.spawnShield = PLAYER.spawnShield;
    if (this.match.phase === PHASE.OVER) p.alive = false;

    this.socket = socket;
    this.humanId = id;
    this.start();

    socket.deliver({
      t: MSG.WELCOME,
      id,
      config: {
        tickRate: TICK_RATE,
        snapshotRate: SNAPSHOT_RATE,
        arenaHalf: ARENA_HALF,
        player: PLAYER,
        match: {
          countdown: MATCH.countdown,
          overDuration: MATCH.overDuration,
          pickupRadius: MATCH.pickupRadius,
        },
        weapons: WEAPONS,
        zonePhases: ZONE_PHASES,
        zoneStartRadius: ZONE_START_RADIUS,
      },
      world: this.match.world,
      state: buildSnapshot(this.match),
      you: buildSelf(this.match, id),
    });
    return true;
  }

  detach(socket) {
    if (socket !== this.socket) return;
    const id = this.humanId;
    this.socket = null;
    this.humanId = null;
    if (id) removePlayer(this.match, id);
    // Nobody is watching the bots fight, so the next drop starts from a clean lobby on a new map.
    this.stop();
    this.match = createMatch();
    this.broadcastSeed = null;
    this.frame = 0;
  }

  // ------------------------------------------------------------------- clock

  start() {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.simAccumulator = 0;
    this.snapshotTimer = 0;
    this.frame = requestAnimationFrame(this.tick);
  }

  stop() {
    this.running = false;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  tick = (now) => {
    if (!this.running) return;
    const elapsed = Math.min(0.25, Math.max(0, (now - this.lastTime) / 1000));
    this.lastTime = now;

    this.simAccumulator += elapsed;
    let guard = 0;
    while (this.simAccumulator >= TICK_DT && guard++ < 8) {
      updateBots(this.match, TICK_DT);
      step(this.match, TICK_DT);
      this.simAccumulator -= TICK_DT;
    }
    if (this.match.phase === PHASE.COUNTDOWN) fillWithBots(this.match, () => this.addBot());

    this.snapshotTimer += elapsed;
    while (this.snapshotTimer >= 1 / SNAPSHOT_RATE) {
      this.snapshotTimer -= 1 / SNAPSHOT_RATE;
      this.broadcast();
    }

    this.frame = requestAnimationFrame(this.tick);
  };

  addBot() {
    if (botCount(this.match) >= 12) return false;
    const used = new Set([...this.match.players.values()].map((p) => p.name));
    const name = BOT_NAMES.find((n) => !used.has(n));
    if (!name) return false;
    return !!addPlayer(this.match, { id: `b${this.nextId++}`, name, bot: true });
  }

  broadcast() {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) {
      clearEvents(this.match);
      return;
    }

    // The map only changes between matches, so it goes out once instead of in every snapshot.
    if (this.broadcastSeed !== this.match.seed) {
      this.broadcastSeed = this.match.seed;
      socket.deliver({ t: 'world', world: this.match.world });
    }

    socket.deliver({ ...buildSnapshot(this.match), you: buildSelf(this.match, this.humanId) });
    clearEvents(this.match);
  }
}

/** Join an offline match and hand back a socket Net can use. */
export function createLocalSocket() {
  return LocalMatch.shared().createSocket();
}
