/**
 * Low-poly weapon models, built from primitives.
 *
 * Two consumers: the first-person viewmodel (one cached instance per kind) and the gun in another
 * player's hands (one instance per player, disposed with them). Both use the same shapes, so the
 * silhouette you see in your hands is the one opponents see on you.
 *
 * Convention: the grip sits at the origin, the barrel points down -Z, +Y is up. `muzzle` is the local
 * point the flash appears at, and `length` is how far the barrel reaches.
 */

import * as THREE from 'three';

const DARK = 0x222b39;
const GRIP = 0x2b3444;

/** Accent colour per weapon, matched to the HUD and the loot beam. */
export const WEAPON_COLORS = {
  pistol: 0xffd166,
  smg: 0x7ae582,
  shotgun: 0xff8b6b,
  rifle: 0x8ecae6,
  sniper: 0xc7a8ff,
  knife: 0xdfe7f2,
};

function material(color, extra = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.35, flatShading: true, ...extra });
}

function box(size, mat, pos = [0, 0, 0], rot = [0, 0, 0]) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), mat);
  mesh.position.set(pos[0], pos[1], pos[2]);
  mesh.rotation.set(rot[0], rot[1], rot[2]);
  return mesh;
}

/** A cylinder lying along Z, which is how every barrel in here is oriented. */
function tube(radius, length, mat, pos, segments = 10) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, segments), mat);
  mesh.position.set(pos[0], pos[1], pos[2]);
  mesh.rotation.x = Math.PI / 2;
  return mesh;
}

function cone(radius, length, mat, pos) {
  const mesh = new THREE.Mesh(new THREE.ConeGeometry(radius, length, 6), mat);
  mesh.position.set(pos[0], pos[1], pos[2]);
  mesh.rotation.x = -Math.PI / 2;
  return mesh;
}

/** Optic glass: unlit, so the lens reads even when the scope is pointed away from the sun. */
function glass(radius) {
  return new THREE.Mesh(
    new THREE.CircleGeometry(radius, 12),
    new THREE.MeshBasicMaterial({ color: 0x9fd8ff, transparent: true, opacity: 0.5 }),
  );
}

/**
 * @param {string} kind weapon id, or 'unarmed'
 * @returns {{ group: THREE.Group, muzzle: THREE.Vector3, length: number }}
 */
export function createWeaponModel(kind) {
  const group = new THREE.Group();
  const accent = new THREE.Color(WEAPON_COLORS[kind] ?? 0x8fa3bb);
  const body = material(accent.getHex());
  const dark = material(DARK, { roughness: 0.75, metalness: 0.25 });
  const grip = material(GRIP, { roughness: 0.85, metalness: 0.08 });
  const steel = material(0xb9c8da, { roughness: 0.35, metalness: 0.6 });
  let muzzle = new THREE.Vector3(0, 0.02, -0.3);
  let length = 0.3;

  if (kind === 'pistol') {
    group.add(box([0.072, 0.075, 0.3], body, [0, 0.035, -0.1]));
    group.add(box([0.062, 0.055, 0.16], dark, [0, -0.015, -0.03]));
    group.add(box([0.058, 0.16, 0.085], grip, [0, -0.115, 0.055], [0.2, 0, 0]));
    // Trigger guard and a rear sight the eye can find.
    group.add(box([0.04, 0.016, 0.08], dark, [0, -0.045, 0.005]));
    group.add(box([0.05, 0.018, 0.016], steel, [0, 0.078, 0.02]));
    group.add(tube(0.016, 0.06, steel, [0, 0.035, -0.26]));
    muzzle = new THREE.Vector3(0, 0.035, -0.3);
    length = 0.34;
  } else if (kind === 'smg') {
    group.add(box([0.078, 0.1, 0.3], body, [0, 0, -0.1]));
    group.add(box([0.058, 0.058, 0.16], dark, [0, -0.005, -0.3]));
    group.add(tube(0.017, 0.14, steel, [0, 0.005, -0.4]));
    // Angled magazine, pistol grip, folded stock.
    group.add(box([0.046, 0.16, 0.07], dark, [0, -0.12, -0.12], [-0.18, 0, 0]));
    group.add(box([0.05, 0.14, 0.075], grip, [0, -0.1, 0.05], [0.22, 0, 0]));
    group.add(box([0.03, 0.045, 0.16], dark, [0, 0.005, 0.15]));
    // Red dot: a little rail, a lens ring, and the dot itself.
    group.add(box([0.04, 0.05, 0.07], dark, [0, 0.08, -0.06]));
    const dot = glass(0.013);
    dot.position.set(0, 0.085, -0.1);
    group.add(dot);
    muzzle = new THREE.Vector3(0, 0.005, -0.47);
    length = 0.5;
  } else if (kind === 'shotgun') {
    group.add(box([0.082, 0.1, 0.24], body, [0, 0, -0.08]));
    group.add(tube(0.026, 0.52, steel, [0, 0.042, -0.44]));
    // Tube magazine under the barrel, with the pump around it.
    group.add(tube(0.021, 0.44, dark, [0, -0.002, -0.4]));
    group.add(box([0.072, 0.07, 0.16], grip, [0, -0.004, -0.33]));
    group.add(box([0.058, 0.085, 0.22], dark, [0, -0.03, 0.15], [0.06, 0, 0]));
    group.add(box([0.05, 0.12, 0.07], grip, [0, -0.085, 0.04], [0.24, 0, 0]));
    muzzle = new THREE.Vector3(0, 0.042, -0.7);
    length = 0.72;
  } else if (kind === 'rifle') {
    group.add(box([0.078, 0.095, 0.36], body, [0, 0, -0.12]));
    group.add(box([0.052, 0.058, 0.26], dark, [0, 0.012, -0.4]));
    group.add(tube(0.015, 0.34, steel, [0, 0.028, -0.56]));
    group.add(box([0.044, 0.14, 0.085], dark, [0, -0.1, -0.06], [0.24, 0, 0]));
    group.add(box([0.05, 0.13, 0.07], grip, [0, -0.095, 0.06], [0.24, 0, 0]));
    group.add(box([0.055, 0.075, 0.2], dark, [0, -0.005, 0.19]));
    // Small optic on a rail: enough to read as "this one is for distance".
    group.add(box([0.036, 0.03, 0.16], dark, [0, 0.075, -0.14]));
    const lens = glass(0.016);
    lens.position.set(0, 0.085, -0.22);
    group.add(lens);
    muzzle = new THREE.Vector3(0, 0.028, -0.73);
    length = 0.78;
  } else if (kind === 'sniper') {
    group.add(box([0.07, 0.088, 0.4], body, [0, 0, -0.14]));
    // Long fluted barrel and a muzzle brake, which is what makes it readable at range.
    group.add(tube(0.014, 0.56, steel, [0, 0.03, -0.62]));
    group.add(tube(0.026, 0.09, dark, [0, 0.03, -0.92]));
    group.add(box([0.05, 0.062, 0.24], dark, [0, 0.022, -0.42]));
    // Scope: tube, two rings, bell, lens.
    group.add(tube(0.03, 0.3, dark, [0, 0.115, -0.16], 12));
    group.add(box([0.03, 0.05, 0.03], steel, [0, 0.08, -0.04]));
    group.add(box([0.03, 0.05, 0.03], steel, [0, 0.08, -0.28]));
    group.add(tube(0.04, 0.05, dark, [0, 0.115, -0.33], 12));
    const lens = glass(0.035);
    lens.position.set(0, 0.115, -0.355);
    group.add(lens);
    // Bolt handle, magazine, stock with a cheek rest.
    group.add(box([0.05, 0.02, 0.02], steel, [0.055, 0.01, -0.03]));
    group.add(box([0.045, 0.1, 0.09], dark, [0, -0.08, -0.02]));
    group.add(box([0.05, 0.13, 0.09], grip, [0, -0.09, 0.08], [0.22, 0, 0]));
    group.add(box([0.056, 0.075, 0.28], body, [0, -0.01, 0.26]));
    group.add(box([0.05, 0.03, 0.12], grip, [0, 0.045, 0.22]));
    // Folded bipod legs.
    group.add(box([0.012, 0.012, 0.2], dark, [0.04, -0.04, -0.5], [0, 0, 0.3]));
    group.add(box([0.012, 0.012, 0.2], dark, [-0.04, -0.04, -0.5], [0, 0, -0.3]));
    muzzle = new THREE.Vector3(0, 0.03, -0.97);
    length = 1.0;
  } else if (kind === 'knife') {
    group.add(box([0.012, 0.07, 0.28], steel, [0, 0.02, -0.15]));
    group.add(cone(0.042, 0.11, steel, [0, 0.02, -0.33]));
    group.add(box([0.1, 0.022, 0.022], dark, [0, 0, 0.0]));
    group.add(box([0.032, 0.038, 0.13], grip, [0, -0.004, 0.07]));
    group.add(box([0.036, 0.042, 0.02], dark, [0, -0.004, 0.145]));
    muzzle = new THREE.Vector3(0, 0.02, -0.34);
    length = 0.34;
  }

  return { group, muzzle, length };
}

/** Free a model built for a single player. Cached viewmodel models are never disposed. */
export function disposeWeaponModel(group) {
  group.traverse((o) => {
    o.geometry?.dispose?.();
    o.material?.dispose?.();
  });
}
