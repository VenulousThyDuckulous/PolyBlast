/**
 * World generation, collision and raycasting.
 *
 * Deliberately free of Node APIs and timers: this module (with sim.js and bots.js) is what would move
 * into a Durable Object if the game were hosted later. Everything here is seeded and deterministic
 * except for `random()`, which is only used for loot rolls.
 */

export const BOX_COLORS = {
  ground: '#1d2437',
  wall: '#2f3b52',
  wallAccent: '#3d4a64',
  buildingA: '#39445c',
  buildingB: '#333e55',
  buildingC: '#4a3f57',
  container: '#3b5566',
  crate: '#6b5738',
};

/** Deterministic 32-bit PRNG (mulberry32). */
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const randRange = (rng, lo, hi) => lo + rng() * (hi - lo);
const randInt = (rng, lo, hi) => Math.floor(randRange(rng, lo, hi + 0.999999));
const pick = (rng, arr) => arr[Math.min(arr.length - 1, Math.floor(rng() * arr.length))];

/**
 * All solid geometry is an axis-aligned box sitting on the ground plane.
 * Storing min/max in XZ plus a height keeps collision, raycasting and rendering trivial.
 */
function addBox(boxes, x0, z0, x1, z1, height, color, kind = 'wall') {
  const b = {
    minX: Math.min(x0, x1),
    maxX: Math.max(x0, x1),
    minZ: Math.min(z0, z1),
    maxZ: Math.max(z0, z1),
    height,
    color,
    kind,
  };
  if (b.maxX - b.minX < 0.25 || b.maxZ - b.minZ < 0.25) return null;
  boxes.push(b);
  return b;
}

/** A wall running along one axis, optionally with a doorway gap punched through it. */
function addWall(boxes, horizontal, fixed, from, to, thickness, height, color, gap) {
  if (!gap) {
    if (horizontal) addBox(boxes, from, fixed - thickness / 2, to, fixed + thickness / 2, height, color, 'building');
    else addBox(boxes, fixed - thickness / 2, from, fixed + thickness / 2, to, height, color, 'building');
    return;
  }
  const gapStart = gap.center - gap.width / 2;
  const gapEnd = gap.center + gap.width / 2;
  const segments = [
    [from, Math.max(from, gapStart)],
    [Math.min(to, gapEnd), to],
  ];
  for (const [a, b] of segments) {
    if (b - a < 0.4) continue;
    if (horizontal) addBox(boxes, a, fixed - thickness / 2, b, fixed + thickness / 2, height, color, 'building');
    else addBox(boxes, fixed - thickness / 2, a, fixed + thickness / 2, b, height, color, 'building');
  }
}

function addBuilding(boxes, rng, cx, cz, w, d, height, color) {
  const t = 0.75;
  const x0 = cx - w / 2;
  const x1 = cx + w / 2;
  const z0 = cz - d / 2;
  const z1 = cz + d / 2;
  const doorSide = randInt(rng, 0, 3);
  const gapWidth = Math.min(5, Math.min(w, d) * 0.45);

  // 0 = north (-Z), 1 = south (+Z), 2 = west (-X), 3 = east (+X)
  const gapFor = (side) => (side === doorSide ? { center: (side < 2 ? cx : cz) + randRange(rng, -1.5, 1.5), width: gapWidth } : null);

  addWall(boxes, true, z0, x0, x1, t, height, color, gapFor(0));
  addWall(boxes, true, z1, x0, x1, t, height, color, gapFor(1));
  addWall(boxes, false, x0, z0, z1, t, height, color, gapFor(2));
  addWall(boxes, false, x1, z0, z1, t, height, color, gapFor(3));

  // Interior clutter so rooms aren't empty shoeboxes.
  if (rng() < 0.55 && w > 9 && d > 9) {
    const iw = randRange(rng, 1.6, 2.6);
    addBox(
      boxes,
      cx + randRange(rng, -w / 4, w / 4) - iw / 2,
      cz + randRange(rng, -d / 4, d / 4) - iw / 2,
      cx + randRange(rng, -w / 4, w / 4) + iw / 2,
      cz + randRange(rng, -d / 4, d / 4) + iw / 2,
      randRange(rng, 1.1, 2.2),
      BOX_COLORS.crate,
      'crate',
    );
  }
}

/**
 * Build the arena: boundary walls, a ring of buildings and containers, and scattered crates.
 * Buildings avoid the very centre so the final circle is an open, hectic knife fight.
 */
export function generateWorld(seed, half = 80) {
  const rng = makeRng(seed);
  const boxes = [];
  const wallH = 8;

  // Boundary walls (thick, and tall enough that you cannot see over them).
  addBox(boxes, -half - 2, -half - 2, half + 2, -half, wallH, BOX_COLORS.wall, 'boundary');
  addBox(boxes, -half - 2, half, half + 2, half + 2, wallH, BOX_COLORS.wall, 'boundary');
  addBox(boxes, -half - 2, -half, -half, half, wallH, BOX_COLORS.wall, 'boundary');
  addBox(boxes, half, -half, half + 2, half, wallH, BOX_COLORS.wall, 'boundary');

  const buildingColors = [BOX_COLORS.buildingA, BOX_COLORS.buildingB, BOX_COLORS.buildingC];
  const placed = [];
  const fits = (x, z, w, d, spacing) =>
    placed.every((p) => Math.abs(p.x - x) > (p.w + w) / 2 + spacing || Math.abs(p.z - z) > (p.d + d) / 2 + spacing);

  // 9 attempts at buildings, placed in the ring between the centre and the wall.
  for (let i = 0; i < 22 && placed.length < 9; i++) {
    const angle = rng() * Math.PI * 2;
    const dist = randRange(rng, 18, half - 16);
    const w = randRange(rng, 11, 19);
    const d = randRange(rng, 11, 19);
    const cx = Math.cos(angle) * dist;
    const cz = Math.sin(angle) * dist;
    if (Math.abs(cx) + w / 2 > half - 6 || Math.abs(cz) + d / 2 > half - 6) continue;
    if (!fits(cx, cz, w, d, 5)) continue;
    placed.push({ x: cx, z: cz, w, d });
    addBuilding(boxes, rng, cx, cz, w, d, randRange(rng, 3.4, 5.6), pick(rng, buildingColors));
  }

  // Shipping containers: long sight-line breakers.
  for (let i = 0; i < 6; i++) {
    const angle = rng() * Math.PI * 2;
    const dist = randRange(rng, 12, half - 12);
    const cx = Math.cos(angle) * dist;
    const cz = Math.sin(angle) * dist;
    const long = randRange(rng, 7, 11);
    const short = randRange(rng, 2.2, 3.0);
    const horizontal = rng() < 0.5;
    const w = horizontal ? long : short;
    const d = horizontal ? short : long;
    if (!fits(cx, cz, w, d, 2.5)) continue;
    placed.push({ x: cx, z: cz, w, d });
    addBox(boxes, cx - w / 2, cz - d / 2, cx + w / 2, cz + d / 2, randRange(rng, 2.4, 3.2), BOX_COLORS.container, 'container');
  }

  // Scattered crates for cover and jump-free peek cover.
  for (let i = 0; i < 28; i++) {
    const angle = rng() * Math.PI * 2;
    const dist = randRange(rng, 4, half - 6);
    const cx = Math.cos(angle) * dist;
    const cz = Math.sin(angle) * dist;
    const size = randRange(rng, 1.5, 3.2);
    if (!isCircleClear(boxes, cx, cz, size * 0.9)) continue;
    addBox(boxes, cx - size / 2, cz - size / 2, cx + size / 2, cz + size / 2, randRange(rng, 1.0, 2.4), BOX_COLORS.crate, 'crate');
  }

  return { seed, half, boxes, center: { x: 0, z: 0 } };
}

/** True when a circle of `radius` at (x,z) does not overlap any box. */
export function isCircleClear(boxes, x, z, radius) {
  for (const b of boxes) {
    const cx = Math.max(b.minX, Math.min(x, b.maxX));
    const cz = Math.max(b.minZ, Math.min(z, b.maxZ));
    const dx = x - cx;
    const dz = z - cz;
    if (dx * dx + dz * dz < radius * radius) return false;
  }
  return true;
}

/**
 * Push a circle out of any box it overlaps and keep it inside the arena.
 * Returns the corrected position; mutating caller state is left to the sim.
 */
export function resolveCircle(world, x, z, radius, feetY = 0) {
  const limit = world.half - radius;
  let px = Math.max(-limit, Math.min(x, limit));
  let pz = Math.max(-limit, Math.min(z, limit));

  // Two passes so a corner between two boxes settles instead of jittering.
  for (let pass = 0; pass < 2; pass++) {
    for (const b of world.boxes) {
      // Airborne over a low crate? Then it isn't in your way.
      if (feetY >= b.height - 0.02) continue;
      if (px + radius <= b.minX || px - radius >= b.maxX) continue;
      if (pz + radius <= b.minZ || pz - radius >= b.maxZ) continue;
      const cx = Math.max(b.minX, Math.min(px, b.maxX));
      const cz = Math.max(b.minZ, Math.min(pz, b.maxZ));
      let dx = px - cx;
      let dz = pz - cz;
      let d2 = dx * dx + dz * dz;
      if (d2 >= radius * radius) continue;
      if (d2 < 1e-8) {
        // Centre is inside the box: push out along the shallowest axis.
        const pushLeft = px - b.minX + radius;
        const pushRight = b.maxX - px + radius;
        const pushUp = pz - b.minZ + radius;
        const pushDown = b.maxZ - pz + radius;
        const m = Math.min(pushLeft, pushRight, pushUp, pushDown);
        if (m === pushLeft) px = b.minX - radius;
        else if (m === pushRight) px = b.maxX + radius;
        else if (m === pushUp) pz = b.minZ - radius;
        else pz = b.maxZ + radius;
        continue;
      }
      const d = Math.sqrt(d2);
      px = cx + (dx / d) * radius;
      pz = cz + (dz / d) * radius;
    }
  }

  px = Math.max(-limit, Math.min(px, limit));
  pz = Math.max(-limit, Math.min(pz, limit));
  return { x: px, z: pz };
}

/**
 * Slab ray/box test. Returns the entry distance along the ray, or -1 for a miss.
 * Rays that start inside the box return 0.
 */
export function rayBox(ox, oy, oz, dx, dy, dz, box, maxT) {
  let tmin = 0;
  let tmax = maxT;

  // X slab
  if (Math.abs(dx) < 1e-8) {
    if (ox < box.minX || ox > box.maxX) return -1;
  } else {
    let t1 = (box.minX - ox) / dx;
    let t2 = (box.maxX - ox) / dx;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return -1;
  }

  // Y slab (boxes sit on the ground)
  if (Math.abs(dy) < 1e-8) {
    if (oy < 0 || oy > box.height) return -1;
  } else {
    let t1 = (0 - oy) / dy;
    let t2 = (box.height - oy) / dy;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return -1;
  }

  // Z slab
  if (Math.abs(dz) < 1e-8) {
    if (oz < box.minZ || oz > box.maxZ) return -1;
  } else {
    let t1 = (box.minZ - oz) / dz;
    let t2 = (box.maxZ - oz) / dz;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return -1;
  }

  return tmin;
}

/** Nearest wall hit along a ray, or null. */
export function raycastWorld(world, ox, oy, oz, dx, dy, dz, maxT = 200) {
  let bestT = maxT;
  let bestBox = null;
  for (const b of world.boxes) {
    const t = rayBox(ox, oy, oz, dx, dy, dz, b, bestT);
    if (t >= 0 && t < bestT) {
      bestT = t;
      bestBox = b;
    }
  }
  return bestBox ? { t: bestT, box: bestBox, x: ox + dx * bestT, y: oy + dy * bestT, z: oz + dz * bestT } : null;
}

/** True when two points can see each other (used by bots and the zone indicators). */
export function hasLineOfSight(world, ax, ay, az, bx, by, bz) {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-6) return true;
  const hit = raycastWorld(world, ax, ay, az, dx / len, dy / len, dz / len, len);
  return !hit;
}

/** Pick `count` spawn points spread around the arena, away from walls and each other. */
export function pickSpawns(world, rng, count, minDistance = 18) {
  const points = [];
  const clearance = 1.4;
  let guard = 0;
  while (points.length < count && guard < count * 400) {
    guard++;
    const angle = rng() * Math.PI * 2;
    const dist = Math.sqrt(rng()) * (world.half - 8);
    const x = Math.cos(angle) * dist;
    const z = Math.sin(angle) * dist;
    if (!isCircleClear(world.boxes, x, z, clearance)) continue;
    if (points.some((p) => (p.x - x) ** 2 + (p.z - z) ** 2 < minDistance * minDistance)) continue;
    points.push({ x, z });
  }
  // Fallback if the arena is unusually cramped.
  while (points.length < count) points.push({ x: randRange(rng, -10, 10), z: randRange(rng, -10, 10) });
  return points;
}

/** Scatter loot around the map, biased away from the exact centre. */
export function pickLootSpots(world, rng, count) {
  const spots = [];
  let guard = 0;
  while (spots.length < count && guard < count * 200) {
    guard++;
    const angle = rng() * Math.PI * 2;
    const dist = randRange(rng, 5, world.half - 5);
    const x = Math.cos(angle) * dist;
    const z = Math.sin(angle) * dist;
    if (!isCircleClear(world.boxes, x, z, 1.0)) continue;
    if (spots.some((p) => (p.x - x) ** 2 + (p.z - z) ** 2 < 12)) continue;
    spots.push({ x, z });
  }
  return spots;
}

export { randRange, randInt, pick };
