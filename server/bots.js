/**
 * Bot decision making.
 *
 * Bots aim and move through exactly the same input struct a human client sends, so the sim cannot
 * tell them apart beyond a flag. Their goal priority is: get a gun, stay in the circle, fight what
 * they can see, top up health when it's safe.
 */

import { PLAYER, WEAPONS, SIM } from './config.js';
import { angleDelta, clamp } from '../shared/protocol.js';
import { hasLineOfSight, raycastWorld } from './world.js';

const dist2d = (a, b) => Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z);

/** Cheap bell-ish curve in [-1, 1]; lumpy aim instead of a uniform box of misses. */
const bell = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;

function freshState() {
  return {
    targetId: null,
    seenFor: 0,
    lostFor: 0,
    strafeDir: Math.random() < 0.5 ? -1 : 1,
    strafeTimer: 0,
    avoidSign: 0,
    avoidTimer: 0,
    goal: null,
    wanderTimer: 0,
    reaction: 0,
    burstLeft: 0,
    burstCd: 0,
  };
}

/** World-space direction expressed in the bot's own movement frame. */
function localMove(yaw, dx, dz) {
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const rx = Math.cos(yaw);
  const rz = -Math.sin(yaw);
  return {
    mx: clamp(dx * rx + dz * rz, -1, 1),
    mz: clamp(dx * fx + dz * fz, -1, 1),
  };
}

function aimAt(p, x, y, z, error) {
  const ox = p.pos.x;
  const oy = p.pos.y + PLAYER.eye;
  const oz = p.pos.z;
  const dx = x - ox;
  const dy = y - oy;
  const dz = z - oz;
  const flat = Math.hypot(dx, dz);
  const yaw = Math.atan2(-dx, -dz);
  const pitch = Math.atan2(dy, Math.max(0.001, flat));
  return { yaw: yaw + error.yaw, pitch: clamp(pitch + error.pitch, -1.2, 1.2) };
}

/** Look for solid geometry directly ahead so the bot can steer around it. */
function blockedAhead(match, p, yaw, distance = 3.2) {
  const ox = p.pos.x;
  const oy = p.pos.y + 0.9;
  const oz = p.pos.z;
  const dx = -Math.sin(yaw);
  const dz = -Math.cos(yaw);
  const hit = raycastWorld(match.world, ox, oy, oz, dx, 0, dz, distance);
  return !!hit;
}

function nearestLoot(match, p, filter) {
  let best = null;
  let bestD = Infinity;
  for (const item of match.loot) {
    if (filter && !filter(item)) continue;
    const d = (item.x - p.pos.x) ** 2 + (item.z - p.pos.z) ** 2;
    if (d < bestD) {
      bestD = d;
      best = item;
    }
  }
  return best;
}

function pickTarget(match, p, state) {
  let best = null;
  let bestScore = Infinity;
  for (const other of match.players.values()) {
    if (other === p || !other.alive) continue;
    const d = dist2d(p, other);
    if (d > SIM.botViewRange) continue;
    // Bots are not omniscient: outside arm's reach they only see what is in their view cone.
    if (d > SIM.botHearing) {
      const toTarget = Math.atan2(-(other.pos.x - p.pos.x), -(other.pos.z - p.pos.z));
      if (Math.abs(angleDelta(p.yaw, toTarget)) > SIM.botFov / 2) continue;
    }
    const visible = hasLineOfSight(
      match.world,
      p.pos.x,
      p.pos.y + PLAYER.eye,
      p.pos.z,
      other.pos.x,
      other.pos.y + 1.0,
      other.pos.z,
    );
    if (!visible) continue;
    // Prefer close targets, and the one we already shot at.
    const score = d - (other.id === state.targetId ? 8 : 0) + (other.bot ? 4 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = other;
    }
  }
  return best;
}

function moveTowardsGoal(match, p, state, goal) {
  let dx = goal.x - p.pos.x;
  let dz = goal.z - p.pos.z;
  const d = Math.hypot(dx, dz);
  if (d < 0.5) return { mx: 0, mz: 0 };
  dx /= d;
  dz /= d;

  // Wall sliding: probe a few headings and take the first that's open.
  if (blockedAhead(match, p, Math.atan2(-dx, -dz))) {
    if (state.avoidTimer <= 0) {
      state.avoidSign = Math.random() < 0.5 ? -1 : 1;
      state.avoidTimer = 0.6;
    }
    for (const sign of [state.avoidSign, -state.avoidSign]) {
      const a = Math.atan2(-dx, -dz) + sign * 0.9;
      const tx = -Math.sin(a);
      const tz = -Math.cos(a);
      if (!blockedAhead(match, p, a)) {
        dx = tx;
        dz = tz;
        break;
      }
    }
  }
  return localMove(p.yaw, dx, dz);
}

export function updateBots(match, dt) {
  for (const p of match.players.values()) {
    if (!p.bot) continue;
    if (!p.alive) {
      p.input.fire = false;
      p.input.mx = 0;
      p.input.mz = 0;
      continue;
    }
    if (!p.botState) p.botState = freshState();
    const state = p.botState;
    state.avoidTimer = Math.max(0, state.avoidTimer - dt);
    state.burstCd = Math.max(0, state.burstCd - dt);
    state.wanderTimer -= dt;
    state.strafeTimer -= dt;

    p.thinkTimer -= dt;
    if (p.thinkTimer > 0) continue;
    p.thinkTimer = SIM.botThink + Math.random() * 0.06;

    think(match, p, state, dt);
  }
}

function think(match, p, state, dt) {
  const held = p.slots[p.slot] || null;
  const armed = !!held && (held.mag > 0 || p.reserve[held.kind] > 0);
  const z = match.zone;

  const target = pickTarget(match, p, state);
  if (target) {
    state.targetId = target.id;
    state.seenFor += SIM.botThink;
    state.lostFor = 0;
  } else {
    state.targetId = null;
    state.seenFor = 0;
    state.lostFor += SIM.botThink;
  }

  // --- unarmed: find a gun -------------------------------------------------
  if (!armed) {
    p.input.fire = false;
    const gun = nearestLoot(match, p, (it) => it.kind === 'weapon');
    if (gun) {
      const d = Math.hypot(gun.x - p.pos.x, gun.z - p.pos.z);
      if (d < 1.6) {
        p.pending.interact = true;
        p.input.mx = 0;
        p.input.mz = 0;
      } else {
        const mv = moveTowardsGoal(match, p, state, gun);
        p.input.mx = mv.mx;
        p.input.mz = mv.mz;
        p.input.sprint = d > 12;
        const aim = aimAt(p, gun.x, 0.6, gun.z, { yaw: 0, pitch: 0 });
        p.input.yaw = approachAngle(p.input.yaw, aim.yaw, 4.5 * SIM.botThink);
        p.input.pitch = aim.pitch;
      }
    } else {
      moveToZone(match, p, state, z);
    }
    return;
  }

  // --- grab helpful loot we are standing on --------------------------------
  const near = nearestLoot(
    match,
    p,
    (it) =>
      (it.kind === 'ammo' && p.reserve[held.kind] < WEAPONS[held.kind].pickup) ||
      (it.kind === 'medkit' && p.hp < PLAYER.maxHp - 25) ||
      (it.kind === 'armor' && p.armor < PLAYER.maxArmor - 10) ||
      (it.kind === 'weapon' && p.slots.filter(Boolean).length < 2),
  );
  if (near) {
    const d = Math.hypot(near.x - p.pos.x, near.z - p.pos.z);
    if (d < 1.5) {
      p.pending.interact = true;
      p.input.mx = 0;
      p.input.mz = 0;
      if (!target) return;
    } else if (!target && d < 25) {
      const mv = moveTowardsGoal(match, p, state, near);
      p.input.mx = mv.mx;
      p.input.mz = mv.mz;
      p.input.sprint = d > 10;
      return;
    }
  }

  // --- reload when it's quiet ---------------------------------------------
  if (held.mag <= 0) p.pending.reload = true;
  else if (!target && held.mag < WEAPONS[held.kind].mag * 0.5) p.pending.reload = true;

  // --- fight ---------------------------------------------------------------
  if (target) {
    const d = dist2d(p, target);
    const def = WEAPONS[held.kind];
    // Accuracy degrades with range and with how fast the target is moving, so a running target at
    // distance is genuinely hard to hit rather than automatically punished.
    const targetSpeed = Math.hypot(target.vel.x, target.vel.z);
    const jitter = SIM.botAimError * (0.55 + d / 45) * (1 + Math.min(targetSpeed, 9) * 0.09);
    const error = { yaw: bell() * jitter, pitch: bell() * jitter * 0.6 };
    const aim = aimAt(p, target.pos.x, target.pos.y + 1.05, target.pos.z, error);
    p.input.yaw = approachAngle(p.input.yaw, aim.yaw, 7 * SIM.botThink);
    p.input.pitch = aim.pitch;

    state.reaction = Math.max(0, state.reaction - SIM.botThink);
    if (state.reaction <= 0 && state.seenFor < SIM.botReaction) {
      state.reaction = SIM.botReaction;
    }

    // Fire in short bursts, with a real reaction delay before the first shot.
    if (state.burstLeft <= 0 && state.burstCd <= 0) state.burstLeft = SIM.botBurstShots;
    const aligned = Math.abs(angleDelta(p.input.yaw, aim.yaw)) < 0.075;
    const canShoot =
      aligned &&
      state.burstLeft > 0 &&
      p.reload === null &&
      held.mag > 0 &&
      state.seenFor > SIM.botReaction;
    p.input.fire = canShoot && d < def.range * 0.9;
    if (p.input.fire) {
      state.burstLeft--;
      if (state.burstLeft <= 0) state.burstCd = SIM.botBurstPause * (0.8 + Math.random() * 0.6);
    }

    // Strafe and keep a sensible engagement distance.
    if (state.strafeTimer <= 0) {
      state.strafeDir *= -1;
      state.strafeTimer = 0.5 + Math.random() * 0.9;
    }
    const ideal = def.id === 'shotgun' ? 7 : def.id === 'rifle' ? 26 : 12;
    let dx = 0;
    let dz = 0;
    if (d < ideal - 3) {
      dx = p.pos.x - target.pos.x;
      dz = p.pos.z - target.pos.z;
    } else if (d > ideal + 6) {
      dx = target.pos.x - p.pos.x;
      dz = target.pos.z - p.pos.z;
    }
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;
    // Add the strafe component perpendicular to the aim direction.
    const px = -Math.cos(p.input.yaw) * state.strafeDir;
    const pz = Math.sin(p.input.yaw) * state.strafeDir;
    const mv = localMove(p.input.yaw, dx * 0.85 + px * 0.75, dz * 0.85 + pz * 0.75);
    p.input.mx = mv.mx;
    p.input.mz = mv.mz;
    p.input.sprint = false;
    p.input.jump = false;
    return;
  }

  moveToZone(match, p, state, z);
}

/** Head for the circle, or wander inside it when safe. */
function moveToZone(match, p, state, z) {
  const d = Math.hypot(p.pos.x - z.x, p.pos.z - z.z);
  const hurt = p.hp < 55;

  // Outside, or comfortably close to the edge of the ring: run in.
  if (d > z.r - 6) {
    const inward = { x: z.x, z: z.z };
    const mv = moveTowardsGoal(match, p, state, inward);
    p.input.mx = mv.mx;
    p.input.mz = mv.mz;
    p.input.sprint = d > z.r - 4 || hurt === false;
    p.input.fire = false;
    const aim = aimAt(p, z.x, 0.6, z.z, { yaw: 0, pitch: 0 });
    p.input.yaw = approachAngle(p.input.yaw, aim.yaw, 3.4 * SIM.botThink);
    p.input.pitch = aim.pitch;
    return;
  }

  if (state.wanderTimer <= 0 || !state.goal) {
    state.wanderTimer = 3 + Math.random() * 4;
    const a = Math.random() * Math.PI * 2;
    const r = Math.random() * Math.max(2, z.r * 0.5);
    state.goal = { x: z.x + Math.cos(a) * r, z: z.z + Math.sin(a) * r };
  }
  const mv = moveTowardsGoal(match, p, state, state.goal);
  p.input.mx = mv.mx;
  p.input.mz = mv.mz;
  p.input.sprint = Math.random() < 0.3;
  if (state.wanderTimer < 1) {
    // Idle scan so bots look alive.
    p.input.yaw += (Math.random() - 0.5) * 0.2;
  }
}

function approachAngle(current, desired, maxStep) {
  const d = angleDelta(current, desired);
  if (Math.abs(d) <= maxStep) return desired;
  return current + Math.sign(d) * maxStep;
}
