/**
 * Transport and snapshot interpolation.
 *
 * The game sends full snapshots at 20 Hz. Rendering a remote player from the newest snapshot alone
 * would stutter, so we keep a short buffer and play it back a fixed delay behind the newest sample,
 * which is what makes other players glide instead of teleporting every 50 ms.
 *
 * A hosted server is always preferred. When none answers - e.g. the game is served from GitHub
 * Pages, which cannot run a WebSocket server - the connection falls back to an in-browser match
 * (local-server.js) that speaks the same protocol over a socket-shaped object.
 */

import { angleDelta } from '../shared/protocol.js';

const INTERP_DELAY = 0.11;
const OPEN = 1;

/**
 * True when the page is the static bundle: scripts/build-static.mjs stamps this meta tag into the
 * copy of index.html it publishes. Reading it is synchronous, so joining never waits on a probe
 * request - that probe used to add seconds to the first join on a slow connection.
 */
const STATIC_BUILD = (() => {
  try {
    return document.querySelector('meta[name="polyblast-mode"]')?.content === 'offline';
  } catch {
    return false;
  }
})();
/** How long to wait for a real server before deciding to play the match locally. */
const REMOTE_TIMEOUT = 2500;

function lerpAngle(a, b, t) {
  return a + angleDelta(a, b) * t;
}

export class Net {
  constructor() {
    this.ws = null;
    this.offline = false;
    this.id = null;
    // Start loading the in-page match now so a fallback (or a static build) joins instantly.
    this.localModule = import('./local-server.js').catch(() => null);
    this.config = null;
    this.you = null;
    this.entries = [];
    this.clock = 0;
    this.primed = false;
    this.newest = null;
    this.onState = null;
    this.onWelcome = null;
    this.onWorld = null;
    this.onClose = null;
    this.onEvents = null;
    this.latencyMs = 0;
  }

  /**
   * Join a match: a real server if one answers, otherwise a local one.
   * Resolves with the welcome message. `this.offline` says which happened.
   */
  async connect(name, avatar) {
    // A static build has no server to join, so do not waste a timeout on a socket that cannot exist.
    if (STATIC_BUILD) return this.connectLocal(name, avatar);
    try {
      return await this.connectRemote(name, avatar);
    } catch {
      // No server (it is down, or blocked): run the match in this tab instead.
      return this.connectLocal(name, avatar);
    }
  }

  async connectLocal(name, avatar) {
    const mod = (await this.localModule) || (await import('./local-server.js'));
    this.offline = true;
    return this.attach(mod.createLocalSocket(), name, 8000, avatar);
  }

  connectRemote(name, avatar) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}`;
    this.offline = false;
    return this.attach(new WebSocket(url), name, REMOTE_TIMEOUT, avatar);
  }

  /** Run the join handshake over any socket-shaped transport. */
  attach(ws, name, timeoutMs, avatar) {
    return new Promise((resolve, reject) => {
      let settled = false;
      this.ws = ws;

      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          reject(new Error('Server did not answer. Is it running?'));
        }
      }, timeoutMs);

      ws.onopen = () => {
        ws.send(JSON.stringify({ t: 'join', name, avatar }));
      };

      ws.onmessage = (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (msg.t === 'welcome') {
          this.id = msg.id;
          this.config = msg.config;
          this.you = msg.you;
          this.onWelcome?.(msg);
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            resolve(msg);
          }
          return;
        }
        if (msg.t === 'state') {
          this.push(msg);
          this.you = msg.you;
          this.onState?.(msg);
          if (msg.events?.length) this.onEvents?.(msg.events);
          return;
        }
        if (msg.t === 'world') {
          this.onWorld?.(msg.world);
          return;
        }
        if (msg.t === 'error') {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            reject(new Error(msg.reason || 'Server refused the connection'));
          }
        }
      };

      ws.onerror = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error('Could not reach the server'));
        }
      };

      ws.onclose = () => {
        clearTimeout(timeout);
        this.onClose?.();
      };

      // A local socket has no network event to wait for: open it once handlers are wired.
      if (ws.readyState === 0 && typeof ws.open === 'function') ws.open();
    });
  }

  push(state) {
    this.newest = state;
    this.entries.push({ t: state.time, s: state });
    if (this.entries.length > 40) this.entries.shift();
    if (!this.primed) {
      this.clock = state.time;
      this.primed = true;
    }
  }

  /** Advance the playback clock. Called once per frame. */
  advance(dt) {
    if (!this.primed || !this.newest) return;
    const target = this.newest.time - INTERP_DELAY;
    const err = target - this.clock;
    // Speed the clock up when we are behind, slow it down when ahead.
    const speed = 1 + Math.max(-0.35, Math.min(0.35, err * 2.5));
    this.clock += dt * speed;
    if (this.clock > this.newest.time) this.clock = this.newest.time;
    const oldest = this.entries[0];
    if (oldest && this.clock < oldest.t) this.clock = oldest.t;
    // Drop entries we have played past, keeping one behind the clock.
    while (this.entries.length > 3 && this.entries[1].t < this.clock - 0.5) this.entries.shift();
  }

  /** Interpolated view of one player at the current playback time, or null. */
  sample(id) {
    const entries = this.entries;
    if (!entries.length) return null;

    let before = null;
    let after = null;
    for (const e of entries) {
      const p = e.s.players.find((pl) => pl.id === id);
      if (!p) continue;
      if (e.t <= this.clock) before = { t: e.t, p };
      else if (!after) after = { t: e.t, p };
    }
    if (!before && after) return after.p;
    if (before && !after) return before.p;
    if (!before || !after) return null;

    const span = after.t - before.t;
    const t = span > 0 ? Math.min(1, Math.max(0, (this.clock - before.t) / span)) : 1;
    const a = before.p;
    const b = after.p;
    return {
      ...b,
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      z: a.z + (b.z - a.z) * t,
      yaw: lerpAngle(a.yaw, b.yaw, t),
      pitch: a.pitch + (b.pitch - a.pitch) * t,
      // Discrete fields come from the older sample so effects don't flicker ahead of position.
      hp: a.hp,
      ar: a.ar,
      al: a.al,
    };
  }

  send(input) {
    if (this.ws?.readyState !== OPEN) return;
    this.ws.send(JSON.stringify({ t: 'input', ...input }));
  }

  close() {
    this.ws?.close();
    this.ws = null;
  }
}
