/**
 * Authoritative match simulation.
 *
 * The only inputs are player intents and a timestep. Nothing in here touches the network, the clock or
 * the filesystem, which makes it testable headlessly and portable to a different transport later.
 */

import {
  WEAPONS,
  ITEMS,
  PLAYER,
  ZONE_START_RADIUS,
  ZONE_PHASES,
  MATCH,
} from './config.js';
import { SIM } from './config.js';
import { PHASE, SLOTS, clamp, clamp01, lerp, aimDir } from '../shared/protocol.js';
import { DEFAULT_AVATAR, HATS, avatarLook, sanitizeAvatar } from '../shared/avatar.js';
import {
  generateWorld,
  makeRng,
  resolveCircle,
  raycastWorld,
  rayBox,
  pickSpawns,
  pickLootSpots,
  randRange,
  pick,
  isCircleClear,
} from './world.js';

const EMPTY_INPUT = () => ({
  yaw: 0,
  pitch: 0,
  mx: 0,
  mz: 0,
  sprint: false,
  jump: false,
  fire: false,
});

export function createMatch(seed = Math.floor(Math.random() * 1e9), matchNumber = 0) {
  const match = {
    seed,
    matchNumber,
    world: generateWorld(seed),
    rng: makeRng((seed ^ 0x9e3779b9) >>> 0),
    players: new Map(),
    loot: [],
    nextLootId: 1,
    nextColor: 0,
    zone: null,
    phase: PHASE.LOBBY,
    timer: 0,
    time: 0,
    tick: 0,
    events: [],
    winner: null,
    lootSpawned: false,
  };
  match.zone = makeZone();
  return match;
}

function makeZone() {
  return {
    x: 0,
    z: 0,
    r: ZONE_START_RADIUS,
    tx: 0,
    tz: 0,
    tr: ZONE_START_RADIUS,
    from: { x: 0, z: 0, r: ZONE_START_RADIUS },
    mode: 'hold',
    timer: ZONE_PHASES[0].hold,
    index: 0,
    dps: ZONE_PHASES[0].dps,
  };
}

// ---------------------------------------------------------------- players

export function addPlayer(match, { id, name, bot = false, avatar = DEFAULT_AVATAR }) {
  if (match.players.size >= MATCH.maxPlayers) return null;
  // Avatars are validated here, not at the transport: nothing downstream can hold an illegal one.
  const look = avatarLook(avatar);
  const color = look.body;
  match.nextColor++;

  const spawn = findSpawn(match);
  const p = {
    id,
    name,
    bot,
    color,
    avatar: sanitizeAvatar(avatar),
    accent: look.accent,
    hat: HATS.findIndex((h) => h.id === look.hat),
    pos: { x: spawn.x, y: 0, z: spawn.z },
    vel: { x: 0, y: 0, z: 0 },
    yaw: spawn.yaw,
    pitch: 0,
    onGround: true,
    hp: PLAYER.maxHp,
    armor: 0,
    alive: true,
    kills: 0,
    damageDealt: 0,
    slots: new Array(SLOTS).fill(null),
    slot: 0,
    reserve: { pistol: 0, smg: 0, shotgun: 0, rifle: 0 },
    fireCd: 0,
    reload: null,
    spawnShield: 0,
    killerId: null,
    lastAttacker: null,
    input: EMPTY_INPUT(),
    pending: { interact: false, reload: false, slot: 0 },
    killStreak: 0,
    thinkTimer: 0,
    botState: null,
    joinedAt: match.time,
  };
  match.players.set(id, p);
  match.events.push({ type: 'join', id, name, bot });
  return p;
}

export function removePlayer(match, id) {
  const p = match.players.get(id);
  if (!p) return;
  if (p.alive) dropInventory(match, p, false);
  match.players.delete(id);
  match.events.push({ type: 'leave', id, name: p.name });
  if (match.phase === PHASE.LIVE) checkWin(match);
}

function findSpawn(match) {
  // Spread joins around the ring so nobody spawns stacked.
  for (let i = 0; i < 200; i++) {
    const angle = Math.random() * Math.PI * 2;
    const dist = Math.sqrt(Math.random()) * (match.world.half - 10);
    const x = Math.cos(angle) * dist;
    const z = Math.sin(angle) * dist;
    if (!isCircleClear(match.world.boxes, x, z, 1.6)) continue;
    let crowded = false;
    for (const other of match.players.values()) {
      if (!other.alive) continue;
      if ((other.pos.x - x) ** 2 + (other.pos.z - z) ** 2 < 64) {
        crowded = true;
        break;
      }
    }
    if (crowded) continue;
    return { x, z, yaw: Math.atan2(-x, -z) };
  }
  return { x: randRange(match.rng, -20, 20), z: randRange(match.rng, -20, 20), yaw: 0 };
}

export function getHeld(p) {
  return p.slots[p.slot] || null;
}

function weaponBox(p) {
  return {
    minX: p.pos.x - PLAYER.radius,
    maxX: p.pos.x + PLAYER.radius,
    minZ: p.pos.z - PLAYER.radius,
    maxZ: p.pos.z + PLAYER.radius,
    height: PLAYER.height,
  };
}

export function alivePlayers(match) {
  const out = [];
  for (const p of match.players.values()) if (p.alive) out.push(p);
  return out;
}

// ---------------------------------------------------------------- input

const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

export function setInput(match, id, raw) {
  const p = match.players.get(id);
  if (!p || !raw) return;
  // Tolerant of partial packets: anything missing keeps the player's previous value rather than
  // poisoning the sim with NaN.
  p.input.yaw = num(raw.yaw, p.input.yaw);
  p.input.pitch = num(raw.pitch, p.input.pitch);
  p.input.mx = clamp(num(raw.mx, 0), -1, 1);
  p.input.mz = clamp(num(raw.mz, 0), -1, 1);
  p.input.sprint = !!raw.sprint;
  p.input.jump = !!raw.jump;
  p.input.fire = !!raw.fire;
  // Edge-triggered actions are latched so a press can't fall between ticks.
  if (raw.interact) p.pending.interact = true;
  if (raw.reload) p.pending.reload = true;
  if (raw.slot) p.pending.slot = raw.slot;
}

// ---------------------------------------------------------------- ticking

export function step(match, dt) {
  match.time += dt;
  match.tick++;

  switch (match.phase) {
    case PHASE.LOBBY:
      if (humanCount(match) > 0) startCountdown(match);
      break;
    case PHASE.COUNTDOWN:
      match.timer -= dt;
      if (match.timer <= 0) startLive(match);
      break;
    case PHASE.LIVE:
      updateZone(match, dt);
      stepPlayers(match, dt);
      applyZoneDamage(match, dt);
      checkWin(match);
      break;
    case PHASE.OVER:
      match.timer -= dt;
      if (match.timer <= 0) resetMatch(match);
      break;
  }
}

function humanCount(match) {
  let n = 0;
  for (const p of match.players.values()) if (!p.bot) n++;
  return n;
}

export function botCount(match) {
  let n = 0;
  for (const p of match.players.values()) if (p.bot) n++;
  return n;
}

function startCountdown(match) {
  match.phase = PHASE.COUNTDOWN;
  match.timer = MATCH.countdown;
  match.events.push({ type: 'countdown', seconds: MATCH.countdown });
}

/** Fill out the lobby with bots; called by the room when the countdown starts. */
export function fillWithBots(match, addBot, target = MATCH.botsToFill) {
  let guard = 0;
  while (match.players.size < target && guard < 40) {
    if (!addBot()) break;
    guard++;
  }
}

function startLive(match) {
  match.phase = PHASE.LIVE;
  match.winner = null;
  match.events.push({ type: 'live' });

  if (!match.lootSpawned) {
    spawnLoot(match);
    match.lootSpawned = true;
  }

  const spawns = pickSpawns(match.world, match.rng, match.players.size + 2, MATCH.spawnMinDistance);
  let i = 0;
  for (const p of match.players.values()) {
    const s = spawns[i % spawns.length];
    i++;
    p.pos.x = s.x;
    p.pos.z = s.z;
    p.pos.y = 0;
    p.vel.x = p.vel.y = p.vel.z = 0;
    p.yaw = Math.atan2(-s.x, -s.z);
    p.pitch = 0;
    p.hp = PLAYER.maxHp;
    p.armor = 0;
    p.alive = true;
    p.kills = 0;
    p.damageDealt = 0;
    p.killerId = null;
    p.lastAttacker = null;
    p.slots = new Array(SLOTS).fill(null);
    p.slot = 0;
    p.reserve = { pistol: 0, smg: 0, shotgun: 0, rifle: 0 };
    p.reload = null;
    p.fireCd = 0;
    p.spawnShield = PLAYER.spawnShield;
    p.killStreak = 0;
  }
}

function resetMatch(match) {
  const humans = [...match.players.values()].filter((p) => !p.bot);
  match.players.clear();
  match.events.length = 0;
  match.world = generateWorld((match.seed = Math.floor(Math.random() * 1e9)));
  match.rng = makeRng((match.seed ^ 0x9e3779b9) >>> 0);
  match.loot.length = 0;
  match.nextLootId = 1;
  match.lootSpawned = false;
  match.zone = makeZone();
  match.winner = null;
  match.matchNumber++;
  match.phase = PHASE.LOBBY;
  match.timer = 0;
  for (const p of humans) {
    match.players.set(p.id, p);
    p.hp = PLAYER.maxHp;
    p.armor = 0;
    p.alive = true;
    p.kills = 0;
    p.killerId = null;
    p.slots = new Array(SLOTS).fill(null);
    p.slot = 0;
    p.reserve = { pistol: 0, smg: 0, shotgun: 0, rifle: 0 };
    p.spawnShield = 0;
    const s = findSpawn(match);
    p.pos = { x: s.x, y: 0, z: s.z };
    p.vel = { x: 0, y: 0, z: 0 };
    p.yaw = s.yaw;
    p.pitch = 0;
  }
  match.events.push({ type: 'matchReset', matchNumber: match.matchNumber });
}

// ---------------------------------------------------------------- zone

function updateZone(match, dt) {
  const z = match.zone;
  z.timer -= dt;

  if (z.mode === 'hold' && z.timer <= 0) {
    if (z.index >= ZONE_PHASES.length) {
      z.mode = 'final';
      z.timer = 999;
      return;
    }
    const ph = ZONE_PHASES[z.index];
    z.mode = 'close';
    z.timer = ph.close;
    z.from = { x: z.x, z: z.z, r: z.r };
    // New circle sits inside the old one.
    const maxOffset = Math.max(0, z.r - ph.radius) * 0.8;
    const a = Math.random() * Math.PI * 2;
    const d = Math.sqrt(Math.random()) * maxOffset;
    z.tx = z.x + Math.cos(a) * d;
    z.tz = z.z + Math.sin(a) * d;
    z.tr = ph.radius;
    match.events.push({ type: 'zoneClose', index: z.index + 1 });
  } else if (z.mode === 'close' && z.timer <= 0) {
    z.x = z.tx;
    z.z = z.tz;
    z.r = z.tr;
    z.dps = ZONE_PHASES[z.index].dps;
    z.index++;
    if (z.index < ZONE_PHASES.length) {
      z.mode = 'hold';
      z.timer = ZONE_PHASES[z.index].hold;
    } else {
      z.mode = 'final';
      z.timer = 999;
    }
  }

  if (z.mode === 'close') {
    const ph = ZONE_PHASES[z.index];
    const t = clamp01(1 - Math.max(0, z.timer) / ph.close);
    z.r = lerp(z.from.r, z.tr, t);
    z.x = lerp(z.from.x, z.tx, t);
    z.z = lerp(z.from.z, z.tz, t);
  }
}

function applyZoneDamage(match, dt) {
  const z = match.zone;
  if (z.dps <= 0) return;
  for (const p of match.players.values()) {
    if (!p.alive) continue;
    const d = Math.hypot(p.pos.x - z.x, p.pos.z - z.z);
    if (d <= z.r) continue;
    // Zone damage ignores armour and spawn shields; the ring always wins.
    p.hp -= z.dps * dt;
    p.lastDamageAt = match.time;
    if (p.hp <= 0) {
      p.hp = 0;
      killPlayer(match, p, null, 'zone', false);
    }
  }
}

// ---------------------------------------------------------------- players

function stepPlayers(match, dt) {
  for (const p of match.players.values()) {
    // Dead players don't simulate, but keep their aim gate for spectator cams.
    if (!p.alive) {
      p.pending.interact = false;
      p.pending.reload = false;
      p.pending.slot = 0;
      continue;
    }

    p.spawnShield = Math.max(0, p.spawnShield - dt);
    p.fireCd = Math.max(0, p.fireCd - dt);

    if (p.reload && match.time >= p.reload.endsAt) finishReload(p);

    if (p.pending.slot && p.pending.slot !== p.slot) {
      const target = p.pending.slot;
      if (p.slots[target]) {
        p.slot = target;
        p.reload = null;
        p.fireCd = Math.max(p.fireCd, 0.22);
      }
    }

    if (p.pending.reload) startReload(match, p);
    if (p.pending.interact) tryPickup(match, p);

    movePlayer(match, p, dt);

    // Firing an empty gun should always start the reload, even mid-cooldown.
    if (p.input.fire) {
      const held = getHeld(p);
      if (held && held.mag <= 0) startReload(match, p);
      else tryFire(match, p);
    }

    p.pending.interact = false;
    p.pending.reload = false;
    p.pending.slot = 0;
  }
}

function movePlayer(match, p, dt) {
  const inp = p.input;
  p.yaw = inp.yaw;
  p.pitch = clamp(inp.pitch, -1.45, 1.45);

  const sprinting = inp.sprint && !inp.fire;
  const speed = sprinting ? PLAYER.sprintSpeed : PLAYER.speed;

  const fx = -Math.sin(p.yaw);
  const fz = -Math.cos(p.yaw);
  const rx = Math.cos(p.yaw);
  const rz = -Math.sin(p.yaw);

  let wx = fx * inp.mz + rx * inp.mx;
  let wz = fz * inp.mz + rz * inp.mx;
  const len = Math.hypot(wx, wz);
  if (len > 1) {
    wx /= len;
    wz /= len;
  }

  const accel = p.pos.y <= 0.01 ? PLAYER.groundAccel : PLAYER.airAccel;
  const blend = Math.min(1, accel * dt);
  p.vel.x += (wx * speed - p.vel.x) * blend;
  p.vel.z += (wz * speed - p.vel.z) * blend;

  if (inp.jump && p.onGround) {
    p.vel.y = PLAYER.jumpSpeed;
    p.onGround = false;
  }
  p.vel.y -= PLAYER.gravity * dt;

  const nx = p.pos.x + p.vel.x * dt;
  const nz = p.pos.z + p.vel.z * dt;
  const resolved = resolveCircle(match.world, nx, nz, PLAYER.radius, p.pos.y);
  p.pos.x = resolved.x;
  p.pos.z = resolved.z;

  p.pos.y += p.vel.y * dt;
  if (p.pos.y <= 0) {
    p.pos.y = 0;
    p.vel.y = 0;
    p.onGround = true;
  } else {
    p.onGround = false;
  }
}

function startReload(match, p) {
  const held = getHeld(p);
  if (!held || p.reload) return;
  const def = WEAPONS[held.kind];
  if (held.mag >= def.mag) return;
  if (p.reserve[held.kind] <= 0) return;
  p.reload = { endsAt: match.time + def.reload, slot: p.slot, duration: def.reload };
}

function finishReload(p) {
  const held = getHeld(p);
  p.reload = null;
  if (!held) return;
  const def = WEAPONS[held.kind];
  const need = def.mag - held.mag;
  const take = Math.min(need, p.reserve[held.kind]);
  held.mag += take;
  p.reserve[held.kind] -= take;
}

// ---------------------------------------------------------------- combat

function tryFire(match, p) {
  const held = getHeld(p);
  if (!held || p.fireCd > 0 || p.reload || p.spawnShield > 0) return;
  const def = WEAPONS[held.kind];

  if (held.mag <= 0) {
    startReload(match, p);
    return;
  }

  held.mag -= 1;
  p.fireCd = 60 / def.rpm;

  const ox = p.pos.x;
  const oy = p.pos.y + PLAYER.eye;
  const oz = p.pos.z;
  const spreadRad = (def.spread * Math.PI) / 180;
  // Moving/shooting while airborne widens the cone a little.
  const moving = Math.hypot(p.vel.x, p.vel.z) > 1.5 ? 1.35 : 1;
  const air = p.onGround ? 1 : 1.6;
  // Bots play with the same mechanics but a slower, less precise trigger finger.
  const botPenalty = p.bot ? SIM.botSpreadPenalty : 1;

  for (let i = 0; i < def.pellets; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * spreadRad * moving * air * botPenalty;
    const yaw = p.yaw + Math.cos(a) * r;
    const pitch = clamp(p.pitch + Math.sin(a) * r, -1.5, 1.5);
    const dir = aimDir(yaw, pitch);

    const hit = traceShot(match, p, ox, oy, oz, dir, def.range);
    const ex = ox + dir.x * hit.t;
    const ey = oy + dir.y * hit.t;
    const ez = oz + dir.z * hit.t;

    match.events.push({
      type: 'shot',
      sx: round2(ox),
      sy: round2(oy),
      sz: round2(oz),
      ex: round2(ex),
      ey: round2(ey),
      ez: round2(ez),
      w: held.kind,
      by: p.id,
      hit: hit.victim ? 1 : 0,
    });

    if (hit.victim) {
      const headshot = hit.hitY - hit.victim.pos.y > PLAYER.height * 0.82;
      const dmg = def.dmg * (headshot ? def.head : 1);
      damagePlayer(match, hit.victim, dmg, p, held.kind, headshot);
    }
  }
}

function traceShot(match, shooter, ox, oy, oz, dir, range) {
  const wall = raycastWorld(match.world, ox, oy, oz, dir.x, dir.y, dir.z, range);
  let bestT = wall ? wall.t : range;
  let victim = null;
  let hitY = 0;

  for (const other of match.players.values()) {
    if (other === shooter || !other.alive) continue;
    const t = rayBox(ox, oy, oz, dir.x, dir.y, dir.z, weaponBox(other), bestT);
    if (t >= 0 && t < bestT) {
      bestT = t;
      victim = other;
      hitY = oy + dir.y * t;
    }
  }
  return { t: bestT, victim, hitY, wall };
}

function damagePlayer(match, target, amount, attacker, weaponKind, headshot) {
  if (!target.alive || target.spawnShield > 0) return;

  let remaining = amount;
  if (target.armor > 0) {
    const absorbed = Math.min(target.armor, amount * PLAYER.armorAbsorb);
    target.armor -= absorbed;
    remaining -= absorbed;
  }
  target.hp -= remaining;
  target.lastAttacker = attacker.id;
  attacker.damageDealt += amount;

  match.events.push({
    type: 'hit',
    id: target.id,
    by: attacker.id,
    dmg: Math.round(amount),
    head: headshot ? 1 : 0,
    x: round2(target.pos.x),
    y: round2(target.pos.y + 1.2),
    z: round2(target.pos.z),
  });

  if (target.hp <= 0) {
    target.hp = 0;
    killPlayer(match, target, attacker, weaponKind, headshot);
  }
}

function killPlayer(match, victim, killer, weaponKind, headshot) {
  if (!victim.alive) return;
  victim.alive = false;
  victim.killerId = killer ? killer.id : null;
  victim.reload = null;
  victim.spawnShield = 0;

  if (killer && killer !== victim) {
    killer.kills++;
    killer.killStreak++;
  }

  dropInventory(match, victim, true);

  match.events.push({
    type: 'kill',
    victim: victim.id,
    vname: victim.name,
    vcolor: victim.color,
    killer: killer ? killer.id : null,
    kname: killer ? killer.name : 'The circle',
    kcolor: killer ? killer.color : '#8ecae6',
    w: weaponKind,
    head: headshot ? 1 : 0,
  });
}

function dropInventory(match, p, scatter) {
  const spots = [];
  for (let i = 0; i < p.slots.length; i++) {
    const w = p.slots[i];
    if (!w) continue;
    const a = Math.random() * Math.PI * 2;
    const d = scatter ? 0.8 + Math.random() * 0.9 : 0;
    const x = p.pos.x + Math.cos(a) * d;
    const z = p.pos.z + Math.sin(a) * d;
    if (!isCircleClear(match.world.boxes, x, z, 0.7)) continue;
    if (spots.some((s) => (s.x - x) ** 2 + (s.z - z) ** 2 < 1.2)) continue;
    spots.push({ x, z });
    match.loot.push({
      id: match.nextLootId++,
      kind: 'weapon',
      weapon: w.kind,
      mag: w.mag,
      x,
      z,
    });
  }
  p.slots = new Array(SLOTS).fill(null);
  p.slot = 0;
}

// ---------------------------------------------------------------- loot

function spawnLoot(match) {
  const spots = pickLootSpots(match.world, match.rng, MATCH.lootCount);
  const rollWeapon = () => {
    const r = Math.random();
    if (r < 0.42) return 'pistol';
    if (r < 0.64) return 'smg';
    if (r < 0.82) return 'shotgun';
    return 'rifle';
  };

  for (const s of spots) {
    const r = Math.random();
    if (r < 0.44) {
      const kind = rollWeapon();
      match.loot.push({ id: match.nextLootId++, kind: 'weapon', weapon: kind, mag: WEAPONS[kind].mag, x: s.x, z: s.z });
    } else if (r < 0.72) {
      match.loot.push({ id: match.nextLootId++, kind: 'ammo', x: s.x, z: s.z });
    } else if (r < 0.89) {
      match.loot.push({ id: match.nextLootId++, kind: 'medkit', x: s.x, z: s.z });
    } else {
      match.loot.push({ id: match.nextLootId++, kind: 'armor', x: s.x, z: s.z });
    }
  }
}

function tryPickup(match, p) {
  let best = null;
  let bestD = MATCH.pickupRadius * MATCH.pickupRadius;
  for (const item of match.loot) {
    const d = (item.x - p.pos.x) ** 2 + (item.z - p.pos.z) ** 2;
    if (d < bestD) {
      bestD = d;
      best = item;
    }
  }
  if (!best) return;

  if (best.kind === 'weapon') {
    const kind = best.weapon;
    const def = WEAPONS[kind];
    const newWeapon = { kind, mag: typeof best.mag === 'number' ? best.mag : def.mag };

    let slot = p.slots.findIndex((s) => s === null);
    if (slot === -1) slot = p.slot;
    else p.slot = slot;

    const replaced = p.slots[slot];
    p.slots[slot] = newWeapon;
    p.reload = null;
    p.fireCd = Math.max(p.fireCd, 0.15);
    if (p.reserve[kind] === 0) p.reserve[kind] = def.reserve;

    if (replaced) {
      match.loot.push({
        id: match.nextLootId++,
        kind: 'weapon',
        weapon: replaced.kind,
        mag: replaced.mag,
        x: p.pos.x + (Math.random() - 0.5) * 1.2,
        z: p.pos.z + (Math.random() - 0.5) * 1.2,
      });
    }
    removeLoot(match, best);
    match.events.push({ type: 'pickup', id: p.id, kind: 'weapon', label: def.label });
    return;
  }

  if (best.kind === 'ammo') {
    const held = getHeld(p);
    const kind = held ? held.kind : 'pistol';
    const def = WEAPONS[kind];
    p.reserve[kind] += def.pickup;
    removeLoot(match, best);
    match.events.push({ type: 'pickup', id: p.id, kind: 'ammo', label: `+${def.pickup} ${def.label} ammo` });
    return;
  }

  if (best.kind === 'medkit') {
    if (p.hp >= PLAYER.maxHp) {
      if (!p.bot) match.events.push({ type: 'deny', id: p.id, reason: 'Health is full' });
      return;
    }
    p.hp = Math.min(PLAYER.maxHp, p.hp + ITEMS.medkit.heal);
    removeLoot(match, best);
    match.events.push({ type: 'pickup', id: p.id, kind: 'medkit', label: `Medkit +${ITEMS.medkit.heal}` });
    return;
  }

  if (best.kind === 'armor') {
    if (p.armor >= PLAYER.maxArmor) {
      if (!p.bot) match.events.push({ type: 'deny', id: p.id, reason: 'Armor is full' });
      return;
    }
    p.armor = Math.min(PLAYER.maxArmor, p.armor + ITEMS.armor.armor);
    removeLoot(match, best);
    match.events.push({ type: 'pickup', id: p.id, kind: 'armor', label: `Armor +${ITEMS.armor.armor}` });
  }
}

function removeLoot(match, item) {
  const i = match.loot.indexOf(item);
  if (i >= 0) match.loot.splice(i, 1);
}

// ---------------------------------------------------------------- win

function checkWin(match) {
  if (match.phase !== PHASE.LIVE) return;
  const alive = alivePlayers(match);
  if (alive.length > 1) return;

  const winner = alive[0] || null;
  match.phase = PHASE.OVER;
  match.timer = MATCH.overDuration;
  match.winner = winner
    ? { id: winner.id, name: winner.name, bot: winner.bot, kills: winner.kills, color: winner.color }
    : null;
  match.events.push({ type: 'over', winner: match.winner });
}

export function forceEndMatch(match) {
  if (match.phase === PHASE.LIVE) checkWin(match);
}

// ---------------------------------------------------------------- snapshot

const round2 = (v) => Math.round(v * 100) / 100;

/**
 * Build the shared part of a state packet. Kept compact: this is sent `SNAPSHOT_RATE` times a second
 * to every client.
 */
export function buildSnapshot(match) {
  const players = [];
  for (const p of match.players.values()) {
    const held = getHeld(p);
    players.push({
      id: p.id,
      n: p.name,
      b: p.bot ? 1 : 0,
      c: p.color,
      x: round2(p.pos.x),
      y: round2(p.pos.y),
      z: round2(p.pos.z),
      yaw: Math.round(p.yaw * 1000) / 1000,
      pitch: Math.round(p.pitch * 1000) / 1000,
      hp: Math.round(p.hp),
      ar: Math.round(p.armor),
      al: p.alive ? 1 : 0,
      k: p.kills,
      w: held ? held.kind : null,
      // Avatar: accent hex + hat index. `c` above is the body colour.
      ac: p.accent,
      h: p.hat,
      s: p.slot,
      sh: p.spawnShield > 0 ? 1 : 0,
      rel: p.reload ? Math.max(0, Math.round((p.reload.endsAt - match.time) * 100) / 100) : 0,
      mv: Math.hypot(p.vel.x, p.vel.z) > 1 ? 1 : 0,
      kil: p.killerId,
    });
  }

  const z = match.zone;
  return {
    t: 'state',
    tick: match.tick,
    time: round2(match.time),
    phase: match.phase,
    timer: Math.max(0, Math.round(match.timer * 10) / 10),
    players,
    loot: match.loot.map((l) => ({
      id: l.id,
      k: l.kind,
      w: l.weapon || null,
      x: round2(l.x),
      z: round2(l.z),
    })),
    zone: {
      x: round2(z.x),
      z: round2(z.z),
      r: round2(z.r),
      tx: round2(z.tx),
      tz: round2(z.tz),
      tr: round2(z.tr),
      mode: z.mode,
      timer: Math.max(0, Math.round(z.timer * 10) / 10),
      index: z.index,
      dps: z.dps,
    },
    winner: match.winner,
    alive: players.filter((p) => p.al).length,
    total: players.length,
    matchNumber: match.matchNumber,
    seed: match.seed,
    events: match.events,
  };
}

/** Per-player extras (own loadout and reload progress). */
export function buildSelf(match, id) {
  const p = match.players.get(id);
  if (!p) return null;
  const held = getHeld(p);
  return {
    hp: Math.round(p.hp),
    armor: Math.round(p.armor),
    alive: p.alive,
    slot: p.slot,
    slots: p.slots.map((s) => (s ? { kind: s.kind, mag: s.mag, max: WEAPONS[s.kind].mag } : null)),
    held: held ? held.kind : null,
    mag: held ? held.mag : 0,
    reserve: held ? p.reserve[held.kind] : 0,
    reserveAll: { ...p.reserve },
    reload: p.reload ? Math.max(0, (p.reload.endsAt - match.time) / p.reload.duration) : 0,
    reloading: !!p.reload,
    kills: p.kills,
    damageDealt: Math.round(p.damageDealt),
    killerId: p.killerId,
    shield: Math.round(p.spawnShield * 10) / 10,
  };
}

export function clearEvents(match) {
  match.events = [];
}
