/**
 * HTTP + WebSocket transport for Last Circle.
 *
 * This is the only file that knows about Node, sockets or the clock. The game itself lives in
 * sim.js/world.js/bots.js, which is what makes a later move to a hosted Durable Object a transport
 * swap rather than a rewrite.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';

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
} from './config.js';
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
} from './sim.js';
import { updateBots } from './bots.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT) || 3000;

// ------------------------------------------------------------------ static files

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Static roots, most specific first. `vendor` exposes the installed three.js build without a bundler,
 * and `server` is importable from the page because the offline match runs the same sim modules.
 */
const STATIC_ROOTS = [
  { prefix: '/vendor/three/', dir: path.join(ROOT, 'node_modules', 'three', 'build') },
  { prefix: '/shared/', dir: path.join(ROOT, 'shared') },
  { prefix: '/server/', dir: path.join(ROOT, 'server') },
  { prefix: '/', dir: path.join(ROOT, 'public') },
];

function resolveStatic(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  const rel = clean === '/' ? '/index.html' : clean;
  for (const { prefix, dir } of STATIC_ROOTS) {
    if (!rel.startsWith(prefix)) continue;
    const rest = rel.slice(prefix.length);
    const full = path.resolve(dir, rest);
    // Guard against path traversal.
    if (!full.startsWith(path.resolve(dir) + path.sep) && full !== path.resolve(dir)) continue;
    return full;
  }
  return null;
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end('Method not allowed');
    return;
  }
  const file = resolveStatic(req.url || '/');
  if (!file) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
});

// ------------------------------------------------------------------ match state

let match = createMatch();

const clients = new Map(); // ws -> { id }
let nextId = 1;

function sanitizeName(raw, fallback) {
  if (typeof raw !== 'string') return fallback;
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 14);
  return cleaned || fallback;
}

function addHuman(ws, name) {
  const id = `p${nextId++}`;
  const p = addPlayer(match, { id, name, bot: false });
  if (!p) return null;
  if (match.phase === PHASE.LIVE) p.spawnShield = PLAYER.spawnShield;
  if (match.phase === PHASE.OVER) p.alive = false;

  clients.set(ws, { id });
  ws.send(
    JSON.stringify({
      t: MSG.WELCOME,
      id,
      config: {
        tickRate: TICK_RATE,
        snapshotRate: SNAPSHOT_RATE,
        arenaHalf: ARENA_HALF,
        player: PLAYER,
        match: { countdown: MATCH.countdown, overDuration: MATCH.overDuration, pickupRadius: MATCH.pickupRadius },
        weapons: WEAPONS,
        zonePhases: ZONE_PHASES,
        zoneStartRadius: ZONE_START_RADIUS,
      },
      world: match.world,
      state: buildSnapshot(match),
      you: buildSelf(match, id),
    }),
  );
  log(`${name} joined (${match.players.size} players, phase ${match.phase})`);
  return p;
}

/** True when nobody is actually watching: then the match is not worth continuing. */
function noHumans() {
  for (const p of match.players.values()) if (!p.bot) return false;
  return true;
}

function addBot() {
  if (botCount(match) >= 12) return false;
  const used = new Set([...match.players.values()].map((p) => p.name));
  const name = BOT_NAMES.find((n) => !used.has(n));
  if (!name) return false;
  const id = `b${nextId++}`;
  const p = addPlayer(match, { id, name, bot: true });
  return !!p;
}

function log(...args) {
  console.log(`[last-circle]`, ...args);
}

// ------------------------------------------------------------------ websocket

const wss = new WebSocketServer({ server, maxPayload: 8 * 1024 });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    if (msg.t === MSG.JOIN) {
      if (clients.has(ws)) return;
      const fallback = `Player ${nextId}`;
      if (!addHuman(ws, sanitizeName(msg.name, fallback))) {
        ws.send(JSON.stringify({ t: 'error', reason: 'Server is full' }));
        ws.close();
      }
      return;
    }

    if (msg.t === MSG.INPUT) {
      const session = clients.get(ws);
      if (!session) return;
      const clean = sanitizeInput(msg);
      if (clean) setInput(match, session.id, clean);
    }
  });

  ws.on('close', () => {
    const session = clients.get(ws);
    if (!session) return;
    clients.delete(ws);
    const p = match.players.get(session.id);
    removePlayer(match, session.id);
    if (p) log(`${p.name} left (${match.players.size} players)`);

    // Nobody left to watch the bots fight: start a clean lobby so the next player drops fresh.
    if (noHumans()) {
      match = createMatch();
      log('last human left - resetting to a fresh lobby');
    }
  });

  ws.on('error', () => {});
});

// ------------------------------------------------------------------ loops

let heartbeat = null;
let tickTimer = null;
let snapshotTimer = null;
let simAccumulator = 0;
let lastTick = process.hrtime.bigint();
let broadcastSeed = null;

function startLoops() {
  heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        /* ignore */
      }
    }
  }, 15000);

  simAccumulator = 0;
  lastTick = process.hrtime.bigint();
  tickTimer = setInterval(() => {
    const now = process.hrtime.bigint();
    const elapsed = Number(now - lastTick) / 1e9;
    lastTick = now;
    // Cap catch-up so a stalled process can't fast-forward the whole match.
    simAccumulator = Math.min(simAccumulator + elapsed, 0.25);

    while (simAccumulator >= TICK_DT) {
      updateBots(match, TICK_DT);
      step(match, TICK_DT);
      simAccumulator -= TICK_DT;
    }

    if (match.phase === PHASE.COUNTDOWN) fillWithBots(match, addBot);
  }, 1000 / TICK_RATE);

  snapshotTimer = setInterval(() => {
    if (clients.size === 0) {
      clearEvents(match);
      return;
    }

    // The map only changes between matches, so it is sent once instead of inside every snapshot.
    if (broadcastSeed !== match.seed) {
      broadcastSeed = match.seed;
      const payload = JSON.stringify({ t: 'world', world: match.world });
      for (const ws of clients.keys()) {
        if (ws.readyState === ws.OPEN) {
          try {
            ws.send(payload);
          } catch {
            /* ignore */
          }
        }
      }
    }

    const base = buildSnapshot(match);
    for (const [ws, session] of clients) {
      if (ws.readyState !== ws.OPEN) continue;
      const self = buildSelf(match, session.id);
      try {
        ws.send(JSON.stringify({ ...base, you: self }));
      } catch {
        /* client vanished; close handler cleans up */
      }
    }
    clearEvents(match);
  }, 1000 / SNAPSHOT_RATE);
}

// ------------------------------------------------------------------ boot

function lanAddresses() {
  const out = [];
  for (const name of Object.keys(os.networkInterfaces())) {
    for (const net of os.networkInterfaces()[name] || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

/**
 * Bind the HTTP + WebSocket server and start simulating. Resolves once the port is actually
 * listening, so an embedding host (Electron) can safely point a window at it.
 *
 * Pass `port: 0` for an ephemeral port; the resolved object carries the one that was chosen.
 */
export function startServer(port = PORT) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      const actual = server.address().port;
      startLoops();
      log(`Last Circle running at http://localhost:${actual}`);
      for (const ip of lanAddresses()) log(`  LAN:    http://${ip}:${actual}`);
      log(`  arena:  ${ARENA_HALF * 2}x${ARENA_HALF * 2}, ${match.world.boxes.length} solid boxes, seed ${match.seed}`);
      resolve({ port: actual, url: `http://localhost:${actual}`, close: stopServer });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port);
  });
}

/** Stop simulating and release the port. Safe to call when not listening. */
export function stopServer() {
  clearInterval(heartbeat);
  clearInterval(tickTimer);
  clearInterval(snapshotTimer);
  heartbeat = tickTimer = snapshotTimer = null;
  for (const ws of wss.clients) ws.terminate();
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
    // `close()` only stops new connections; idle keep-alive sockets would otherwise keep it (and an
    // embedding app) waiting. Dropping them makes shutdown immediate.
    server.closeAllConnections?.();
  });
}

/** Only act as a standalone process when this file is the entry point, not when imported. */
const enteredDirectly = (() => {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(arg)).href;
  } catch {
    return false;
  }
})();

if (enteredDirectly) {
  const shutdown = () => {
    stopServer().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  startServer(PORT).catch((err) => {
    console.error(`[last-circle] could not start on port ${PORT}: ${err.message}`);
    process.exit(1);
  });
}

export { match };
