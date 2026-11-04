/**
 * Headless checks for PolyBlast. No browser, no canvas: drives the same sim the server runs, then
 * opens a real WebSocket connection to a spawned server to prove the transport wires up.
 *
 *   npm test
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

import {
  createMatch,
  addPlayer,
  setInput,
  step,
  buildSnapshot,
  buildSelf,
  fillWithBots,
  botCount,
  alivePlayers,
  weaponBox,
} from '../server/sim.js';
import { updateBots } from '../server/bots.js';
import { TICK_DT, PLAYER, WEAPONS } from '../server/config.js';
import { PHASE } from '../shared/protocol.js';
import { generateWorld, isCircleClear, raycastWorld, resolveCircle } from '../server/world.js';

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message}`);
  }
}

function advance(match, seconds) {
  const steps = Math.round(seconds / TICK_DT);
  for (let i = 0; i < steps; i++) {
    updateBots(match, TICK_DT);
    step(match, TICK_DT);
  }
}

/** A world that is nothing but the arena walls, so tests aren't at the mercy of map generation. */
function openWorld() {
  const world = generateWorld(1234);
  world.boxes = world.boxes.filter((b) => b.kind === 'boundary');
  return world;
}

function makeLiveMatch(count = 2) {
  const match = createMatch(4242);
  match.world = openWorld();
  match.players.clear();
  for (let i = 0; i < count; i++) {
    addPlayer(match, { id: `p${i}`, name: `P${i}`, bot: false });
  }
  // Lobby -> countdown -> live.
  advance(match, 6);
  assert.equal(match.phase, PHASE.LIVE, 'match should be live');
  for (const p of match.players.values()) {
    p.pos.x = 0;
    p.pos.z = 0;
    p.spawnShield = 0;
    p.hp = PLAYER.maxHp;
  }
  return match;
}

function givePistol(p) {
  p.slots[0] = { kind: 'pistol', mag: 12 };
  p.slot = 0;
  p.reserve.pistol = 24;
  p.fireCd = 0;
  p.reload = null;
}

console.log('\nworld');

test('generates solid geometry inside the arena bounds', () => {
  const world = generateWorld(7);
  assert.ok(world.boxes.length > 20, `expected many boxes, got ${world.boxes.length}`);
  for (const b of world.boxes) {
    assert.ok(b.maxX > b.minX && b.maxZ > b.minZ, 'box has positive extent');
    assert.ok(b.height > 0, 'box has height');
    assert.ok(b.minX >= -world.half - 3 && b.maxX <= world.half + 3, 'box stays in arena');
  }
});

test('circles are pushed out of solid geometry', () => {
  const world = generateWorld(99);
  assert.equal(world.boxes.length > 0, true);
  const blocked = world.boxes[5];
  const r = 0.45;
  const inside = resolveCircle(world, (blocked.minX + blocked.maxX) / 2, (blocked.minZ + blocked.maxZ) / 2, r);
  // A resolved centre must sit at least its radius away from the box's surface.
  const nx = Math.max(blocked.minX, Math.min(inside.x, blocked.maxX));
  const nz = Math.max(blocked.minZ, Math.min(inside.z, blocked.maxZ));
  const gap = Math.hypot(inside.x - nx, inside.z - nz);
  assert.ok(gap >= r - 0.02, `circle should be pushed clear of the box, gap=${gap.toFixed(3)}`);
});

test('raycast reports a hit distance to a wall', () => {
  const world = { half: 80, boxes: [{ minX: -5, maxX: 5, minZ: -20, maxZ: -19, height: 4 }] };
  const hit = raycastWorld(world, 0, 1, 0, 0, 0, -1, 100);
  assert.ok(hit, 'ray should hit the wall');
  assert.ok(Math.abs(hit.t - 19) < 0.001, `expected t≈19, got ${hit.t}`);
  const miss = raycastWorld(world, 0, 1, 0, 0, 0, 1, 100);
  assert.equal(miss, null, 'ray going the other way misses');
});

console.log('\nmovement');

test('walking forward moves the player and reports it in a snapshot', () => {
  const match = makeLiveMatch(2);
  const p = match.players.get('p0');
  p.pos = { x: 0, y: 0, z: 20 };
  setInput(match, 'p0', { yaw: 0, pitch: 0, mx: 0, mz: 1, sprint: false });
  advance(match, 0.5);
  assert.ok(p.pos.z < 19, `should move toward -Z, z=${p.pos.z}`);
  const snap = buildSnapshot(match);
  const me = snap.players.find((s) => s.id === 'p0');
  assert.ok(me, 'player present in snapshot');
  assert.equal(me.z, Math.round(p.pos.z * 100) / 100);
});

test('sprint is faster than a walk', () => {
  const match = makeLiveMatch(2);
  const p = match.players.get('p0');
  p.pos = { x: 0, y: 0, z: 40 };
  setInput(match, 'p0', { yaw: 0, pitch: 0, mx: 0, mz: 1 });
  advance(match, 0.4);
  const walked = 40 - p.pos.z;

  p.pos = { x: 0, y: 0, z: 40 };
  p.vel = { x: 0, y: 0, z: 0 };
  setInput(match, 'p0', { yaw: 0, pitch: 0, mx: 0, mz: 1, sprint: true });
  advance(match, 0.4);
  const ran = 40 - p.pos.z;
  assert.ok(ran > walked, `sprint (${ran.toFixed(2)}) should beat walk (${walked.toFixed(2)})`);
});

test('sprinting burns stamina, and an empty bar stops the sprint', () => {
  const match = makeLiveMatch(2);
  const p = match.players.get('p0');
  p.pos = { x: 0, y: 0, z: 40 };
  setInput(match, 'p0', { yaw: 0, pitch: 0, mx: 0, mz: 1, sprint: true });
  advance(match, 0.6);
  assert.ok(p.stamina < PLAYER.staminaMax, `stamina should drain, ${p.stamina}`);
  assert.equal(p.sprinting, true, 'sprint running');

  // Keep the key down: the sprint has to give out on its own.
  let emptiedAt = -1;
  for (let i = 0; i < 400 && emptiedAt < 0; i++) {
    advance(match, 0.05);
    if (p.stamina <= 0.01) emptiedAt = i;
  }
  assert.ok(emptiedAt > 0, 'stamina ran out while sprinting');
  assert.equal(p.sprinting, false, 'cannot keep sprinting on an empty bar');

  // Still holding the key must not restart the sprint (no stuttering between speeds).
  advance(match, 0.4);
  assert.equal(p.sprinting, false, 'holding the key does not restart an exhausted sprint');

  // Letting go and waiting brings it back.
  setInput(match, 'p0', { yaw: 0, pitch: 0, mx: 0, mz: 0, sprint: false });
  advance(match, 2.5);
  assert.ok(p.stamina > PLAYER.staminaSprintMin, `stamina regenerated, ${p.stamina}`);
});

test('a slide launches faster than a sprint and drops the hitbox', () => {
  const match = makeLiveMatch(2);
  const p = match.players.get('p0');
  p.pos = { x: 0, y: 0, z: 40 };
  setInput(match, 'p0', { yaw: 0, pitch: 0, mx: 0, mz: 1, sprint: true });
  advance(match, 0.8);
  assert.equal(p.sprinting, true, 'sprinting before the slide');
  const runSpeed = Math.hypot(p.vel.x, p.vel.z);

  setInput(match, 'p0', { yaw: 0, pitch: 0, mx: 0, mz: 1, sprint: false, slide: true });
  advance(match, 0.05);
  assert.ok(p.slide, 'slide started');
  const slideSpeed = Math.hypot(p.vel.x, p.vel.z);
  assert.ok(slideSpeed > runSpeed, `slide (${slideSpeed.toFixed(2)}) should launch faster than a run (${runSpeed.toFixed(2)})`);
  assert.ok(weaponBox(p).height < PLAYER.height, 'hitbox is lower while sliding');
  assert.equal(buildSnapshot(match).players.find((s) => s.id === 'p0').sl, 1, 'snapshot flags the slide');
});

test('slides are capped in duration and cannot be chained', () => {
  const match = makeLiveMatch(2);
  const p = match.players.get('p0');
  p.pos = { x: 0, y: 0, z: 40 };
  setInput(match, 'p0', { yaw: 0, pitch: 0, mx: 0, mz: 1, sprint: true });
  advance(match, 0.8);
  setInput(match, 'p0', { yaw: 0, pitch: 0, mx: 0, mz: 1, sprint: true, slide: true });
  advance(match, 0.05);
  assert.ok(p.slide, 'first slide running');

  // Holding the key does not extend it.
  advance(match, PLAYER.slideDuration + 0.1);
  assert.equal(p.slide, null, 'slide ends on its own');
  assert.ok(p.slideCd > 0, 'cooldown is running');

  // Still holding the key: it must not start another slide on its own.
  setInput(match, 'p0', { yaw: 0, pitch: 0, mx: 0, mz: 1, sprint: true, slide: true });
  advance(match, 0.3);
  assert.equal(p.slide, null, 'holding the key does not chain another slide');

  // Releasing and pressing again once the cooldown has run out is allowed.
  setInput(match, 'p0', { yaw: 0, pitch: 0, mx: 0, mz: 1, sprint: true, slide: false });
  advance(match, 1.2);
  setInput(match, 'p0', { yaw: 0, pitch: 0, mx: 0, mz: 1, sprint: true, slide: true });
  advance(match, 0.1);
  assert.ok(p.slide, 'a fresh press slides again after the cooldown');
});

test('a slide will not launch from walking speed, only from a sprint', () => {
  const match = makeLiveMatch(2);
  const p = match.players.get('p0');
  p.pos = { x: 0, y: 0, z: 40 };
  setInput(match, 'p0', { yaw: 0, pitch: 0, mx: 0, mz: 1, sprint: false });
  advance(match, 1);
  const walkSpeed = Math.hypot(p.vel.x, p.vel.z);
  assert.ok(
    walkSpeed < PLAYER.slideMinSpeed,
    `a walk (${walkSpeed.toFixed(2)}) must stay under slideMinSpeed (${PLAYER.slideMinSpeed})`,
  );

  // Holding slide at walking speed does nothing at all: this is what made the touch button feel
  // broken, because the phone had no way to reach sprint speed.
  setInput(match, 'p0', { yaw: 0, pitch: 0, mx: 0, mz: 1, sprint: false, slide: true });
  advance(match, 0.1);
  assert.equal(p.slide, null, 'no slide from a walk, however long the button is held');

  // Sprinting on the same held button - which is what the touch screen now reports - launches it.
  setInput(match, 'p0', { yaw: 0, pitch: 0, mx: 0, mz: 1, sprint: true, slide: true });
  advance(match, 0.15);
  assert.ok(p.slide, 'sprint plus slide launches');
});

test('the number keys select the slot they are labelled with', () => {
  const match = makeLiveMatch(2);
  const p = match.players.get('p0');
  givePistol(p);
  p.slots[1] = { kind: 'smg', mag: 32 };
  p.slots[2] = { kind: 'knife', mag: 0 };

  setInput(match, 'p0', { slot: 2 });
  advance(match, 0.1);
  assert.equal(p.slot, 1, 'key 2 picks the second slot');
  setInput(match, 'p0', { slot: 3 });
  advance(match, 0.1);
  assert.equal(p.slot, 2, 'key 3 draws the knife');
  setInput(match, 'p0', { slot: 1 });
  advance(match, 0.1);
  assert.equal(p.slot, 0, 'key 1 picks the first slot');
});

test('walls stop movement', () => {
  const match = makeLiveMatch(2);
  match.world.boxes.push({ minX: -6, maxX: 6, minZ: 9, maxZ: 10, height: 4, kind: 'wall' });
  const p = match.players.get('p0');
  p.pos = { x: 0, y: 0, z: 20 };
  setInput(match, 'p0', { yaw: 0, pitch: 0, mx: 0, mz: 1, sprint: true });
  advance(match, 3);
  assert.ok(p.pos.z > 10.3, `player should stop in front of the wall, z=${p.pos.z.toFixed(2)}`);
});

test('jump leaves the ground and lands again', () => {
  const match = makeLiveMatch(2);
  const p = match.players.get('p0');
  setInput(match, 'p0', { yaw: 0, pitch: 0, mx: 0, mz: 0, jump: true });
  advance(match, 0.15);
  assert.ok(p.pos.y > 0.2, `should be airborne, y=${p.pos.y.toFixed(2)}`);
  setInput(match, 'p0', { yaw: 0, pitch: 0, mx: 0, mz: 0, jump: false });
  advance(match, 1.5);
  assert.equal(p.pos.y, 0, 'lands back on the ground');
});

console.log('\ncombat');

test('a shot at a player in front deals damage', () => {
  const match = makeLiveMatch(2);
  const shooter = match.players.get('p0');
  const victim = match.players.get('p1');
  shooter.pos = { x: 0, y: 0, z: 0 };
  victim.pos = { x: 0, y: 0, z: -8 };
  givePistol(shooter);
  setInput(match, 'p0', { yaw: 0, pitch: 0, fire: true });
  advance(match, 0.2);
  assert.ok(victim.hp < PLAYER.maxHp, `victim should be hurt, hp=${victim.hp}`);
  const snap = buildSnapshot(match);
  const shots = snap.events.filter((e) => e.type === 'shot');
  assert.ok(shots.length >= 1, 'a tracer event was emitted');
  assert.ok(buildSelf(match, 'p0').mag < 12, 'shot consumed ammo');
});

test('walls block bullets', () => {
  const match = makeLiveMatch(2);
  const shooter = match.players.get('p0');
  const victim = match.players.get('p1');
  shooter.pos = { x: 0, y: 0, z: 0 };
  victim.pos = { x: 0, y: 0, z: -8 };
  match.world.boxes.push({ minX: -4, maxX: 4, minZ: -4, maxZ: -3, height: 4, kind: 'wall' });
  givePistol(shooter);
  setInput(match, 'p0', { yaw: 0, pitch: 0, fire: true });
  advance(match, 0.3);
  assert.equal(victim.hp, PLAYER.maxHp, 'cover should protect the victim');
});

test('headshots deal more damage than body shots', () => {
  // Eye height is 1.62 and the head band starts at 0.82 * 1.8 = 1.48, so a flat shot at chest
  // distance is a headshot; aiming down at the torso is not.
  const shoot = (pitch) => {
    const match = makeLiveMatch(2);
    const shooter = match.players.get('p0');
    const victim = match.players.get('p1');
    shooter.pos = { x: 0, y: 0, z: 0 };
    victim.pos = { x: 0, y: 0, z: -6 };
    givePistol(shooter);
    setInput(match, 'p0', { yaw: 0, pitch, mx: 0, mz: 0, fire: true });
    advance(match, 0.05);
    return PLAYER.maxHp - victim.hp;
  };
  const head = shoot(0);
  const body = shoot(-0.1);
  assert.ok(body > 0 && head > 0, `both shots connected (body ${body}, head ${head})`);
  assert.ok(head > body * 1.5, `headshot ${head} should beat body ${body}`);
});

test('armor absorbs part of the damage', () => {
  const match = makeLiveMatch(2);
  const shooter = match.players.get('p0');
  const victim = match.players.get('p1');
  shooter.pos = { x: 0, y: 0, z: 0 };
  victim.pos = { x: 0, y: 0, z: -6 };
  victim.armor = 50;
  givePistol(shooter);
  setInput(match, 'p0', { yaw: 0, pitch: 0, fire: true });
  advance(match, 0.1);
  assert.ok(victim.armor < 50, 'armor took a hit');
  assert.ok(victim.hp > PLAYER.maxHp - 22, 'health lost less than raw damage');
});

test('killing the last opponent ends the match and reports the winner', () => {
  const match = makeLiveMatch(2);
  const shooter = match.players.get('p0');
  const victim = match.players.get('p1');
  match.world.boxes = match.world.boxes.filter((b) => b.kind === 'boundary');
  shooter.pos = { x: 0, y: 0, z: 0 };
  victim.pos = { x: 0, y: 0, z: -4 };
  givePistol(shooter);

  for (let i = 0; i < 200 && match.phase === PHASE.LIVE; i++) {
    victim.pos = { x: 0, y: 0, z: -4 };
    setInput(match, 'p0', { yaw: 0, pitch: 0, fire: true });
    advance(match, 0.05);
  }

  assert.equal(match.phase, PHASE.OVER, 'match should be over');
  assert.ok(match.winner, 'has a winner');
  assert.equal(match.winner.id, 'p0');
  assert.equal(victim.alive, false);
  assert.equal(shooter.kills, 1);
  const killEvent = buildSnapshot(match).events.find((e) => e.type === 'kill');
  assert.ok(killEvent, 'kill event for the feed');
});

console.log('\nmelee');

/** Line the two players up: attacker at the origin facing -Z, victim straight ahead. */
function faceOff(gap = 1.3) {
  const match = makeLiveMatch(2);
  const attacker = match.players.get('p0');
  const victim = match.players.get('p1');
  attacker.pos = { x: 0, y: 0, z: 0 };
  victim.pos = { x: 0, y: 0, z: -gap };
  attacker.yaw = 0;
  attacker.pitch = 0;
  attacker.vel = { x: 0, y: 0, z: 0 };
  victim.vel = { x: 0, y: 0, z: 0 };
  victim.yaw = 0; // facing -Z, i.e. away from the attacker
  attacker.slot = 2; // knife
  attacker.fireCd = 0;
  return { match, attacker, victim };
}

test('the knife is carried in its own slot and needs no ammo', () => {
  const { match, attacker } = faceOff();
  assert.equal(attacker.slots.length, 3, 'two gun slots plus melee');
  assert.equal(attacker.slots[2].kind, 'knife');
  setInput(match, 'p0', { yaw: 0, pitch: 0, fire: true });
  advance(match, 0.5);
  assert.equal(attacker.reload, null, 'a knife never reloads');
  assert.equal(attacker.slots[2].mag, 0, 'and never spends ammo');
});

test('a knife swing damages what is in front of it, once per cooldown', () => {
  const { match, attacker, victim } = faceOff(1.3);
  // Facing the attacker, so this exercises the plain melee hit rather than the takedown below.
  victim.yaw = Math.PI;
  const before = victim.hp;
  setInput(match, 'p0', { yaw: 0, pitch: 0, fire: true });
  advance(match, 0.1);
  assert.ok(victim.hp < before, `knife should connect, hp=${victim.hp}`);
  const afterFirst = victim.hp;
  assert.ok(afterFirst > 0, 'one swing is not a kill from full health');

  advance(match, 0.2);
  assert.equal(victim.hp, afterFirst, 'the cooldown blocks a second hit in the same window');

  advance(match, 0.5);
  assert.ok(victim.hp < afterFirst, 'once the cooldown ends the next swing lands');
});

test('the knife cannot reach past its range', () => {
  const { match, victim } = faceOff(4.5);
  const before = victim.hp;
  setInput(match, 'p0', { yaw: 0, pitch: 0, fire: true });
  advance(match, 0.5);
  assert.equal(victim.hp, before, 'swinging at air deals no damage');
});

test('picking up guns never displaces the knife', () => {
  const match = makeLiveMatch(2);
  const p = match.players.get('p0');
  p.pos = { x: 0, y: 0, z: 0 };
  for (const [i, kind] of ['rifle', 'smg'].entries()) {
    match.loot.push({ id: 500 + i, kind: 'weapon', weapon: kind, mag: 10, x: 0.2, z: 0 });
    setInput(match, 'p0', { interact: true });
    advance(match, 0.1);
  }
  assert.equal(p.slots.filter((s, i) => i < 2 && s).length, 2, 'both gun slots filled');
  assert.equal(p.slots[2].kind, 'knife', 'the knife is still in the melee slot');
});

test('a knife in the back of an unaware opponent is an instant takedown', () => {
  const { match, victim } = faceOff(1.2);
  setInput(match, 'p0', { yaw: 0, pitch: 0, fire: true });
  advance(match, 0.05);
  assert.equal(victim.alive, false, 'takedown eliminates instantly');
  const finisher = buildSnapshot(match).events.find((e) => e.type === 'finisher');
  assert.ok(finisher, 'finisher event for the HUD');
  assert.equal(finisher.by, 'p0');
  assert.equal(finisher.id, 'p1');
});

test('facing the attacker turns a takedown back into a normal hit', () => {
  const { match, victim } = faceOff(1.3);
  victim.yaw = Math.PI; // now looking straight at the attacker
  setInput(match, 'p0', { yaw: 0, pitch: 0, fire: true });
  advance(match, 0.1);
  assert.equal(victim.alive, true, 'no takedown from the front');
  assert.ok(victim.hp < PLAYER.maxHp, 'but the swing still hurts');
});

test('an opponent who just shot you does not count as unaware', () => {
  const { match, attacker, victim } = faceOff(1.3);
  // The victim fired at the attacker a moment ago: aware, even with their back turned.
  victim.lastAttackId = attacker.id;
  victim.lastFireAt = match.time;
  setInput(match, 'p0', { yaw: 0, pitch: 0, fire: true });
  advance(match, 0.1);
  assert.equal(victim.alive, true, 'no instant takedown on someone already fighting you');
  assert.ok(victim.hp < PLAYER.maxHp, 'normal knife damage instead');
});

test('the self packet carries stamina, slide and melee state', () => {
  const { match } = faceOff(1.3);
  const self = buildSelf(match, 'p0');
  assert.equal(self.staminaMax, PLAYER.staminaMax);
  assert.equal(typeof self.stamina, 'number');
  assert.equal(self.melee, true, 'knife reads as melee');
  assert.equal(self.sliding, false);
  assert.ok(self.slots.length === 3);
});

console.log('\nloot');

test('walking onto a weapon and pressing E equips it', () => {
  const match = makeLiveMatch(2);
  const p = match.players.get('p0');
  p.pos = { x: 0, y: 0, z: 0 };
  match.loot.push({ id: 999, kind: 'weapon', weapon: 'rifle', mag: 10, x: 0.4, z: 0.2 });
  setInput(match, 'p0', { yaw: 0, pitch: 0, interact: true });
  advance(match, 0.1);
  assert.ok(p.slots[0], 'weapon equipped');
  assert.equal(p.slots[0].kind, 'rifle');
  assert.ok(p.reserve.rifle > 0, 'starting reserve granted');
  assert.equal(match.loot.some((l) => l.id === 999), false, 'loot removed from world');
});

test('medkit heals and armor plate adds armor', () => {
  const match = makeLiveMatch(2);
  const p = match.players.get('p0');
  p.pos = { x: 0, y: 0, z: 0 };
  p.hp = 30;
  match.loot.push({ id: 1, kind: 'medkit', x: 0, z: 0 });
  setInput(match, 'p0', { interact: true });
  advance(match, 0.1);
  assert.ok(p.hp > 30, `medkit healed, hp=${p.hp}`);

  match.loot.push({ id: 2, kind: 'armor', x: 0, z: 0 });
  setInput(match, 'p0', { interact: true });
  advance(match, 0.1);
  assert.ok(p.armor > 0, 'armor applied');
});

test('ammo crate tops up the held weapon reserve', () => {
  const match = makeLiveMatch(2);
  const p = match.players.get('p0');
  p.pos = { x: 0, y: 0, z: 0 };
  givePistol(p);
  const before = p.reserve.pistol;
  match.loot.push({ id: 3, kind: 'ammo', x: 0, z: 0 });
  setInput(match, 'p0', { interact: true });
  advance(match, 0.1);
  assert.ok(p.reserve.pistol > before, 'reserve increased');
});

test('empty magazine triggers a reload that refills from reserve', () => {
  const match = makeLiveMatch(2);
  const p = match.players.get('p0');
  p.pos = { x: 0, y: 0, z: 0 };
  givePistol(p);
  p.slots[0].mag = 1;
  p.reserve.pistol = 10;
  setInput(match, 'p0', { fire: true });
  advance(match, 0.3);
  assert.equal(p.slots[0].mag, 0, 'magazine emptied');
  assert.ok(p.reload, 'reload started');
  // Stop shooting so the refilled magazine stays full while the reload finishes.
  setInput(match, 'p0', { fire: false });
  advance(match, 1.6);
  // Only 10 rounds were in reserve, so the 12-round magazine refills to 10 and empties the reserve.
  assert.equal(p.slots[0].mag, 10, 'magazine refilled from reserve');
  assert.equal(p.reserve.pistol, 0, 'reserve consumed');
});

console.log('\nsniper and scoping');

/** A duel with a sniper in the shooter's hands, aimed level at the victim's chest. */
function sniperDuel({ gap = 60 } = {}) {
  const match = makeLiveMatch(2);
  match.world.boxes = match.world.boxes.filter((b) => b.kind === 'boundary');
  // Freeze the ring: none of these checks should be polluted by zone damage mid-volley.
  match.zone.timer = 9999;
  const shooter = match.players.get('p0');
  const victim = match.players.get('p1');
  shooter.pos = { x: 0, y: 0, z: 0 };
  victim.pos = { x: 0, y: 0, z: -gap };
  shooter.yaw = 0;
  shooter.pitch = 0;
  shooter.vel = { x: 0, y: 0, z: 0 };
  victim.vel = { x: 0, y: 0, z: 0 };
  shooter.slots[0] = { kind: 'sniper', mag: WEAPONS.sniper.mag };
  shooter.slot = 0;
  shooter.reserve.sniper = 200;
  shooter.fireCd = 0;
  shooter.reload = null;
  shooter.spawnShield = 0;
  // Plenty of health so a long volley measures spread rather than ending the match.
  victim.hp = 5000;
  return { match, shooter, victim, gap };
}

/** Fire `shots` separate rounds, counting how many connected. */
function sniperVolley(match, shooter, victim, { scope, shots, gap }) {
  const pitch = Math.atan2(1.0 - PLAYER.eye, gap);
  let hits = 0;
  let before = victim.hp;
  for (let shot = 0; shot < shots; shot++) {
    // Isolate spread from reload timing by handing each round a full magazine.
    shooter.slots[0].mag = WEAPONS.sniper.mag;
    shooter.reload = null;
    const start = match.time;
    while (match.time - start < 1.6) {
      setInput(match, shooter.id, { yaw: 0, pitch, mx: 0, mz: 0, fire: true, scope });
      advance(match, 0.05);
      if (victim.hp < before) {
        hits++;
        before = victim.hp;
        break;
      }
    }
    setInput(match, shooter.id, { yaw: 0, pitch, fire: false, scope });
    advance(match, 0.05);
  }
  return hits;
}

test('the sniper is only accurate through its scope', () => {
  assert.equal(WEAPONS.sniper.scope, true, 'the sniper has an optic');
  assert.ok(
    WEAPONS.sniper.scopeSpread < WEAPONS.sniper.spread,
    `scoped cone (${WEAPONS.sniper.scopeSpread}) must be tighter than hip fire (${WEAPONS.sniper.spread})`,
  );

  const hip = sniperDuel({ gap: 45 });
  const hipHits = sniperVolley(hip.match, hip.shooter, hip.victim, { scope: false, shots: 10, gap: 45 });
  assert.ok(hipHits < 10, `hip fire should miss at 45m, got ${hipHits}/10`);

  const scoped = sniperDuel({ gap: 45 });
  const scopedHits = sniperVolley(scoped.match, scoped.shooter, scoped.victim, {
    scope: true,
    shots: 4,
    gap: 45,
  });
  assert.equal(scopedHits, 4, `scoped fire should land every round, got ${scopedHits}/4`);
});

test('scoping slows you to a walk and rules out sprinting', () => {
  const { match, shooter } = sniperDuel({ gap: 20 });
  setInput(match, 'p0', { yaw: 0, pitch: 0, mx: 0, mz: 1, sprint: true, scope: true });
  advance(match, 1.2);
  const speed = Math.hypot(shooter.vel.x, shooter.vel.z);
  assert.equal(shooter.scoped, true, 'the optic is up');
  assert.equal(shooter.sprinting, false, 'a scoped rifle cannot be sprinted with');
  assert.ok(
    speed < PLAYER.speed * 0.6,
    `scoped speed ${speed.toFixed(2)} should be well under a walk (${PLAYER.speed})`,
  );
});

test('only a weapon with an optic can scope', () => {
  const match = makeLiveMatch(2);
  const p = match.players.get('p0');
  givePistol(p);
  setInput(match, 'p0', { yaw: 0, pitch: 0, scope: true });
  advance(match, 0.1);
  assert.equal(p.scoped, false, 'a pistol has no optic');
  assert.equal(buildSelf(match, 'p0').scoped, false);
});

test('a scoped sniper headshot is a one-shot kill', () => {
  const { match, victim } = sniperDuel({ gap: 8 });
  victim.hp = PLAYER.maxHp;
  setInput(match, 'p0', { yaw: 0, pitch: 0, fire: true, scope: true });
  advance(match, 0.15);
  assert.equal(victim.alive, false, 'a level shot at 8m hits the head and kills');
  const kill = buildSnapshot(match).events.find((e) => e.type === 'kill');
  assert.ok(kill, 'kill event for the feed');
  assert.equal(kill.head, 1, 'credited as a headshot');
});

test('the snapshot and self packet report the scope state', () => {
  const { match } = sniperDuel({ gap: 20 });
  setInput(match, 'p0', { yaw: 0, pitch: 0, scope: true });
  advance(match, 0.1);
  const me = buildSnapshot(match).players.find((p) => p.id === 'p0');
  assert.equal(me.sc, 1, 'other clients see a scoped player');
  assert.equal(buildSelf(match, 'p0').scoped, true);
});

console.log('\nzone and match flow');

test('the zone closes over time', () => {
  const match = makeLiveMatch(2);
  const startR = match.zone.r;
  advance(match, 20);
  assert.equal(match.zone.mode, 'hold', 'first hold phase');
  advance(match, 12);
  assert.ok(match.zone.r < startR, `ring should be smaller, r=${match.zone.r.toFixed(1)}`);
});

test('being outside the ring costs health', () => {
  const match = makeLiveMatch(2);
  const p = match.players.get('p0');
  match.players.get('p1').pos = { x: 0, y: 0, z: 0 };
  p.pos = { x: 70, y: 0, z: 70 }; // outside the starting circle
  const before = p.hp;
  advance(match, 2);
  assert.ok(p.hp < before, `zone damage applied, hp=${p.hp}`);
});

test('bots fill the lobby and are not counted as humans', () => {
  const match = createMatch(11);
  addPlayer(match, { id: 'h1', name: 'Human', bot: false });
  fillWithBots(match, () => !!addPlayer(match, { id: `b${Math.random()}`, name: 'Bot', bot: true }), 6);
  assert.ok(botCount(match) >= 5, `bots added, got ${botCount(match)}`);
  assert.equal(alivePlayers(match).length, match.players.size);
});

test('a match reset regenerates the map and preserves humans', () => {
  const match = makeLiveMatch(2);
  const seedBefore = match.seed;
  const shooter = match.players.get('p0');
  const victim = match.players.get('p1');
  shooter.pos = { x: 0, y: 0, z: 0 };
  victim.pos = { x: 0, y: 0, z: -4 };
  givePistol(shooter);
  for (let i = 0; i < 200 && match.phase === PHASE.LIVE; i++) {
    victim.pos = { x: 0, y: 0, z: -4 };
    setInput(match, 'p0', { yaw: 0, pitch: 0, fire: true });
    advance(match, 0.05);
  }
  assert.equal(match.phase, PHASE.OVER);
  advance(match, 7);
  assert.notEqual(match.seed, seedBefore, 'new map seed');
  assert.ok(match.players.has('p0') && match.players.has('p1'), 'humans kept');
  assert.ok(match.phase === PHASE.LOBBY || match.phase === PHASE.COUNTDOWN, `new match starting, phase=${match.phase}`);
});

console.log('\nbots');

test('bots arm themselves, move and eventually hurt each other', () => {
  const match = createMatch(2024);
  match.players.clear();
  // A human in the lobby is what starts the countdown.
  addPlayer(match, { id: 'spectator-free', name: 'Human', bot: false });
  for (let i = 0; i < 6; i++) {
    addPlayer(match, { id: `b${i}`, name: `Bot${i}`, bot: true });
  }
  advance(match, 6); // countdown -> live
  assert.equal(match.phase, PHASE.LIVE);

  const startPositions = [...match.players.values()].map((p) => ({ x: p.pos.x, z: p.pos.z }));
  advance(match, 12);

  let moved = 0;
  let armed = 0;
  [...match.players.values()].forEach((p, i) => {
    if (Math.hypot(p.pos.x - startPositions[i].x, p.pos.z - startPositions[i].z) > 2) moved++;
    if (p.slots.some(Boolean)) armed++;
  });
  assert.ok(moved >= 3, `bots should move around, ${moved}/6 moved`);
  assert.ok(armed >= 3, `bots should find weapons, ${armed}/6 armed`);

  // Run long enough for fights to break out.
  advance(match, 60);
  const hurtOrDead = [...match.players.values()].filter((p) => !p.alive || p.hp < PLAYER.maxHp).length;
  const shots = match.tick;
  assert.ok(shots > 0);
  assert.ok(hurtOrDead >= 1 || match.phase === PHASE.OVER, 'bots fight each other');
});

test('bots stay inside the closing ring', () => {
  const match = createMatch(555);
  match.players.clear();
  addPlayer(match, { id: 'human', name: 'Human', bot: false });
  for (let i = 0; i < 5; i++) addPlayer(match, { id: `b${i}`, name: `Bot${i}`, bot: true });
  advance(match, 6);
  advance(match, 45);
  const z = match.zone;
  const outside = [...match.players.values()].filter(
    (p) => p.alive && Math.hypot(p.pos.x - z.x, p.pos.z - z.z) > z.r + 8,
  );
  assert.ok(outside.length <= 2, `most bots should be rotating in, ${outside.length} far outside`);
});

console.log('\ntransport');

await testAsync('a real client can join over websocket and receives state', async () => {
  const port = 3900 + Math.floor(Math.random() * 90);
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout.on('data', (d) => {
    serverLog += d.toString();
  });
  child.stderr.on('data', (d) => {
    serverLog += d.toString();
  });

  try {
    // Wait for the port to accept connections.
    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 8000;
      const attempt = () => {
        if (serverLog.includes('running at')) return resolve();
        if (Date.now() > deadline) return reject(new Error(`server did not start:\n${serverLog}`));
        setTimeout(attempt, 60);
      };
      attempt();
    });

    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    const messages = [];
    ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
    ws.send(JSON.stringify({ t: 'join', name: 'TestClient' }));

    const welcome = await waitFor(messages, (m) => m.t === 'welcome', 4000, 'welcome');
    assert.ok(welcome.id, 'welcome carries a player id');
    assert.ok(welcome.config.weapons.pistol, 'welcome carries the weapon table');
    assert.equal(welcome.state.phase, PHASE.LOBBY);

    // Joining starts the countdown and fills the lobby with bots.
    const countdown = await waitFor(messages, (m) => m.t === 'state' && m.phase === PHASE.COUNTDOWN, 4000, 'countdown');
    assert.ok(countdown.players.length >= 2, 'bots are added to the lobby');
    assert.ok(countdown.players.some((p) => p.n === 'TestClient'), 'our player is in the state');

    const live = await waitFor(messages, (m) => m.t === 'state' && m.phase === PHASE.LIVE, 9000, 'live');
    assert.ok(live.you, 'live state carries our own loadout');

    // Movement should show up in a later snapshot once the match is live.
    const mine = () => messages.filter((m) => m.t === 'state').at(-1).players.find((p) => p.n === 'TestClient');
    const startZ = mine().z;
    ws.send(JSON.stringify({ t: 'input', yaw: 0, pitch: 0, mx: 0, mz: -1, sprint: true }));
    await waitFor(messages, () => mine() && Math.abs(mine().z - startZ) > 0.5, 4000, 'movement');

    ws.close();
  } catch (err) {
    throw new Error(`${err.message}\n--- server output ---\n${serverLog}`);
  } finally {
    child.kill();
  }
});

function waitFor(messages, predicate, timeoutMs, label = 'message') {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      const found = messages.find((m) => {
        try {
          return predicate(m);
        } catch {
          return false;
        }
      });
      if (found) return resolve(found);
      if (Date.now() - started > timeoutMs) {
        const last = messages.at(-1);
        return reject(
          new Error(
            `timed out waiting for ${label} after ${timeoutMs}ms; ${messages.length} messages, last: ${
              last ? JSON.stringify(last).slice(0, 200) : 'none'
            }`,
          ),
        );
      }
      setTimeout(poll, 30);
    };
    poll();
  });
}

// ------------------------------------------------------------------ summary

console.log('');
if (failures.length) {
  console.log(`${passed} passed, ${failures.length} failed\n`);
  for (const f of failures) {
    console.log(`--- ${f.name}\n${f.err.stack}\n`);
  }
  process.exit(1);
}
console.log(`${passed} passed\n`);
process.exit(0);
