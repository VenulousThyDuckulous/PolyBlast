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
  MELEE,
  ZONE_START_RADIUS,
  ZONE_PHASES,
  MATCH,
} from './config.js';
import { SIM } from './config.js';
import { PHASE, SLOTS, MELEE_SLOT, GUN_SLOTS, clamp, clamp01, lerp, aimDir, angleDelta } from '../shared/protocol.js';
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
  slide: false,
});

/** Two gun slots and a knife that is always in the third. */
function freshSlots() {
  const slots = new Array(SLOTS).fill(null);
  slots[MELEE_SLOT] = { kind: 'knife', mag: 0 };
  return slots;
}

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
    slots: freshSlots(),
    slot: 0,
    reserve: { pistol: 0, smg: 0, shotgun: 0, rifle: 0, knife: 0 },
    fireCd: 0,
    reload: null,
    spawnShield: 0,
    killerId: null,
    lastAttacker: null,
    input: EMPTY_INPUT(),
    pending: { interact: false, reload: false, slot: 0 },
    killStreak: 0,
    // ---- movement state
    stamina: PLAYER.staminaMax,
    staminaDelay: 0,
    sprinting: false,
    sprintLock: false,
    slide: null,
    slideCd: 0,
    slideLock: false,
    // ---- combat bookkeeping used by the stealth finisher
    lastFireAt: -99,
    lastAttackId: null,
    finisherAt: -99,
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

/** Hitbox used for shots against a player. Exported so the tests can check the slide profile. */
export function weaponBox(p) {
  return {
    minX: p.pos.x - PLAYER.radius,
    maxX: p.pos.x + PLAYER.radius,
    minZ: p.pos.z - PLAYER.radius,
    maxZ: p.pos.z + PLAYER.radius,
    // Sliding genuinely shrinks the target: shots aimed at a standing chest sail over.
    height: p.slide ? PLAYER.slideHeight : PLAYER.height,
  };
}

/** Eye height, which drops with the hitbox while sliding. */
function eyeHeight(p) {
  return p.slide ? PLAYER.slideEye : PLAYER.eye;
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
  p.input.slide = !!raw.slide;
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
    p.slots = freshSlots();
    p.slot = 0;
    p.reserve = { pistol: 0, smg: 0, shotgun: 0, rifle: 0, knife: 0 };
    p.reload = null;
    p.fireCd = 0;
    p.spawnShield = PLAYER.spawnShield;
    p.killStreak = 0;
    p.stamina = PLAYER.staminaMax;
    p.staminaDelay = 0;
    p.sprinting = false;
    p.sprintLock = false;
    p.slide = null;
    p.slideCd = 0;
    p.slideLock = false;
    p.lastFireAt = -99;
    p.lastAttackId = null;
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
    p.slots = freshSlots();
    p.slot = 0;
    p.reserve = { pistol: 0, smg: 0, shotgun: 0, rifle: 0, knife: 0 };
    p.spawnShield = 0;
    p.stamina = PLAYER.staminaMax;
    p.sprinting = false;
    p.sprintLock = false;
    p.slide = null;
    p.slideCd = 0;
    p.slideLock = false;
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

    // Slot ids travel as 1-based numbers (what the HUD and the number keys say) and are indexes here.
    if (p.pending.slot) {
      const target = p.pending.slot - 1;
      if (target !== p.slot && p.slots[target]) {
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
      // Firing breaks the slide but keeps the speed it generated, so slide -> shoot flows.
      endSlide(p);
      const held = getHeld(p);
      if (held && !WEAPONS[held.kind].melee && held.mag <= 0) startReload(match, p);
      else tryFire(match, p);
    }

    p.pending.interact = false;
    p.pending.reload = false;
    p.pending.slot = 0;
  }
}

/** End a slide. The lock means the same held key cannot start another one: press again to slide. */
function endSlide(p) {
  if (!p.slide) return;
  p.slide = null;
  p.slideLock = true;
}

/** Kick off a slide: a burst of momentum along the current heading, paid for with stamina. */
function startSlide(match, p) {
  const speed = Math.hypot(p.vel.x, p.vel.z);
  const hasVelocity = speed > 0.001;
  p.slide = {
    endsAt: match.time + PLAYER.slideDuration,
    duration: PLAYER.slideDuration,
    dx: hasVelocity ? p.vel.x / speed : -Math.sin(p.yaw),
    dz: hasVelocity ? p.vel.z / speed : -Math.cos(p.yaw),
    speed: Math.max(PLAYER.slideSpeed, speed),
  };
  p.stamina = Math.max(0, p.stamina - PLAYER.slideStamina);
  p.staminaDelay = PLAYER.staminaRegenDelay;
  // Cooldown covers the slide itself plus the recovery window, so it cannot be chained forever.
  p.slideCd = PLAYER.slideDuration + PLAYER.slideCooldown;
  match.events.push({ type: 'slide', id: p.id, x: round2(p.pos.x), z: round2(p.pos.z) });
}

function movePlayer(match, p, dt) {
  const inp = p.input;
  p.yaw = inp.yaw;
  p.pitch = clamp(inp.pitch, -1.45, 1.45);

  p.slideCd = Math.max(0, p.slideCd - dt);
  p.staminaDelay = Math.max(0, p.staminaDelay - dt);
  if (!inp.slide) p.slideLock = false;

  const speedNow = Math.hypot(p.vel.x, p.vel.z);
  const wantsMove = Math.hypot(inp.mx, inp.mz) > 0.1;

  // ---- slide -------------------------------------------------------------
  if (p.slide && (match.time >= p.slide.endsAt || (inp.jump && p.onGround))) endSlide(p);
  if (
    !p.slide &&
    !p.slideLock &&
    inp.slide &&
    p.onGround &&
    p.slideCd <= 0 &&
    !inp.fire &&
    p.stamina >= PLAYER.slideStamina &&
    speedNow >= PLAYER.slideMinSpeed
  ) {
    startSlide(match, p);
  }

  // ---- sprint ------------------------------------------------------------
  // Starting a sprint needs headroom on the bar; continuing one only needs stamina left. Running
  // dry also latches until the key is released, so a held Shift cannot stutter between speeds.
  if (!inp.sprint) p.sprintLock = false;
  else if (p.stamina <= 0) p.sprintLock = true;
  const canSustain =
    !p.sprintLock && (p.sprinting ? p.stamina > 0 : p.stamina > PLAYER.staminaSprintMin);
  const sprinting = !p.slide && inp.sprint && wantsMove && !inp.fire && canSustain;
  p.sprinting = sprinting;
  if (sprinting) {
    p.stamina = Math.max(0, p.stamina - PLAYER.staminaDrain * dt);
    p.staminaDelay = PLAYER.staminaRegenDelay;
  } else if (!p.slide && p.staminaDelay <= 0) {
    p.stamina = Math.min(PLAYER.staminaMax, p.stamina + PLAYER.staminaRegen * dt);
  }

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

  if (p.slide) {
    // A slide keeps the momentum it was launched with; steering is a light touch, not free turning.
    const t = clamp01(1 - (p.slide.endsAt - match.time) / p.slide.duration);
    if (len > 0.1) {
      const current = Math.atan2(-p.slide.dx, -p.slide.dz);
      const desired = Math.atan2(-wx, -wz);
      const turned = current + clamp(angleDelta(current, desired), -PLAYER.slideTurn * dt, PLAYER.slideTurn * dt);
      p.slide.dx = -Math.sin(turned);
      p.slide.dz = -Math.cos(turned);
    }
    const target = lerp(p.slide.speed, PLAYER.slideEndSpeed, t);
    p.vel.x = p.slide.dx * target;
    p.vel.z = p.slide.dz * target;
  } else {
    // Smooth ramp on the way in, smooth braking on the way out.
    const targetSpeed = sprinting ? PLAYER.sprintSpeed : PLAYER.speed;
    const accel = p.pos.y <= 0.01
      ? wantsMove
        ? sprinting
          ? PLAYER.sprintAccel
          : PLAYER.groundAccel
        : PLAYER.groundFriction
      : PLAYER.airAccel;
    const blend = Math.min(1, accel * dt);
    p.vel.x += (wx * targetSpeed - p.vel.x) * blend;
    p.vel.z += (wz * targetSpeed - p.vel.z) * blend;
  }

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

  // Melee shares the trigger with guns but skips ammo, spread and reload entirely.
  if (def.melee) {
    meleeSwing(match, p, def);
    return;
  }

  if (held.mag <= 0) {
    startReload(match, p);
    return;
  }

  held.mag -= 1;
  p.fireCd = 60 / def.rpm;
  p.lastFireAt = match.time;

  const ox = p.pos.x;
  const oy = p.pos.y + eyeHeight(p);
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

// ---------------------------------------------------------------- melee

/**
 * Nearest player inside the knife's short arc, ignoring anyone behind a wall.
 * A knife is a swing, not a ray, so the arc is generous compared with a bullet's cone.
 */
function traceMelee(match, p) {
  const def = WEAPONS.knife;
  const eye = p.pos.y + eyeHeight(p);
  let best = null;
  let bestD = Infinity;

  for (const other of match.players.values()) {
    if (other === p || !other.alive) continue;
    const dx = other.pos.x - p.pos.x;
    const dz = other.pos.z - p.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.001 || d > def.range + PLAYER.radius) continue;
    if (Math.abs(other.pos.y - p.pos.y) > 1.9) continue;
    // Roughly in front of the crosshair (about a 115 degree arc).
    if (Math.abs(angleDelta(p.yaw, Math.atan2(-dx, -dz))) > 1.0) continue;
    // A blade does not reach through geometry.
    const wall = raycastWorld(match.world, p.pos.x, eye, p.pos.z, dx / d, 0, dz / d, d);
    if (wall && wall.t < d - 0.25) continue;
    if (d < bestD) {
      bestD = d;
      best = other;
    }
  }
  return best;
}

/**
 * The stealth takedown: attacker directly behind the victim, close enough, and the victim has not
 * engaged them (no recent shot at them, and no lock-on for bots).
 */
function canFinish(match, attacker, victim) {
  if (!victim.alive || victim.spawnShield > 0) return false;
  const dx = attacker.pos.x - victim.pos.x;
  const dz = attacker.pos.z - victim.pos.z;
  const d = Math.hypot(dx, dz);
  if (d > MELEE.finisherRange || d < 0.001) return false;

  // Behind them: the victim's forward vector must point away from the attacker.
  const fx = -Math.sin(victim.yaw);
  const fz = -Math.cos(victim.yaw);
  if (((dx / d) * fx + (dz / d) * fz) > MELEE.finisherRearDot) return false;

  // Unaware: they have not fired at this attacker recently.
  if (victim.lastAttackId === attacker.id && match.time - victim.lastFireAt < MELEE.finisherAwareSeconds) return false;
  // A bot that is tracking the attacker knows where they are, whatever its aim is doing.
  if (victim.bot && victim.botState && victim.botState.targetId === attacker.id) return false;

  return true;
}

function meleeSwing(match, p, def) {
  p.fireCd = 60 / def.rpm;
  p.lastFireAt = match.time;

  const victim = traceMelee(match, p);
  const eye = p.pos.y + eyeHeight(p);
  const dir = aimDir(p.yaw, p.pitch);
  const reach = victim
    ? Math.min(def.range, Math.hypot(victim.pos.x - p.pos.x, victim.pos.z - p.pos.z))
    : def.range;

  if (victim && canFinish(match, p, victim)) {
    finisher(match, p, victim);
    return;
  }

  match.events.push({
    type: 'melee',
    id: p.id,
    hit: victim ? 1 : 0,
    sx: round2(p.pos.x),
    sy: round2(eye),
    sz: round2(p.pos.z),
    ex: round2(p.pos.x + dir.x * reach),
    ey: round2(eye + dir.y * reach),
    ez: round2(p.pos.z + dir.z * reach),
  });

  if (victim) damagePlayer(match, victim, def.dmg, p, 'knife', false);
}

/** Arcade takedown: instant, silent, and over in a frame - no gore, just a tag. */
function finisher(match, attacker, victim) {
  attacker.finisherAt = match.time;
  attacker.stamina = Math.min(PLAYER.staminaMax, attacker.stamina + MELEE.finisherStamina);
  match.events.push({
    type: 'finisher',
    by: attacker.id,
    id: victim.id,
    kname: attacker.name,
    kcolor: attacker.color,
    vname: victim.name,
    vcolor: victim.color,
    x: round2(victim.pos.x),
    y: round2(victim.pos.y),
    z: round2(victim.pos.z),
  });
  killPlayer(match, victim, attacker, 'finisher', false);
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
  // Remembering who you shot (and when) is what makes someone count as aware of you.
  attacker.lastAttackId = target.id;
  attacker.lastFireAt = match.time;

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
  victim.hp = 0;
  victim.killerId = killer ? killer.id : null;
  victim.reload = null;
  victim.spawnShield = 0;
  victim.slide = null;
  victim.slideLock = true;
  victim.sprinting = false;
  victim.input.fire = false;
  victim.input.slide = false;

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
    // The knife is never dropped: it is part of the player, not their loot.
    if (i === MELEE_SLOT) continue;
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
  p.slots = freshSlots();
  p.slot = MELEE_SLOT;
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

    // Guns only ever fill the two gun slots; the fixed melee slot is never replaced.
    let slot = p.slots.findIndex((s, i) => i < GUN_SLOTS && s === null);
    if (slot === -1) slot = p.slot < GUN_SLOTS ? p.slot : 0;
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
    // With the knife out, ammo goes to the gun in the other slot instead of vanishing.
    const held = getHeld(p);
    let kind = held && !WEAPONS[held.kind].melee ? held.kind : null;
    if (!kind) {
      const gun = p.slots.find((s, i) => i < GUN_SLOTS && s);
      kind = gun ? gun.kind : 'pistol';
    }
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
      // Sliding players are visibly low, which is also the cue that they are harder to hit.
      sl: p.slide ? 1 : 0,
      sp: p.sprinting ? 1 : 0,
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
    // ---- movement feedback
    stamina: Math.round(p.stamina),
    staminaMax: PLAYER.staminaMax,
    sprinting: p.sprinting,
    sliding: !!p.slide,
    slideCd: Math.round(p.slideCd * 100) / 100,
    melee: !!held && !!WEAPONS[held.kind].melee,
  };
}

export function clearEvents(match) {
  match.events = [];
}
