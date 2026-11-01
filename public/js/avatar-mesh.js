/**
 * Low-poly character built from primitives.
 *
 * Shared by the world renderer (other players) and the lobby's character editor preview, so what you
 * pick in the editor is exactly what other people see. Everything is boxes, spheres, cones and a
 * torus: no textures, no models, consistent with the rest of the game.
 *
 * The group's origin sits at the feet, which is what the snapshot position means.
 */

import * as THREE from 'three';

const HIP = 0.86;
const SHOULDER = 1.3;
const HEAD_Y = 1.62;

function standard(color, extra = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.62, metalness: 0.06, flatShading: true, ...extra });
}

/**
 * @param {{ body: string, accent: string, hat: string }} look
 * @returns {{ group: THREE.Group, gun: THREE.Mesh, bodyMaterial: THREE.Material }}
 */
export function createAvatar(look) {
  const bodyColor = new THREE.Color(look.body || '#ff6b6b');
  const accentColor = new THREE.Color(look.accent || '#0d1420');

  const group = new THREE.Group();
  const bodyMaterial = standard(bodyColor);
  const accentMaterial = standard(accentColor);
  const darkMaterial = standard(0x2a3444, { metalness: 0.25, roughness: 0.7 });

  // ---- legs
  for (const side of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.17, HIP, 0.19), accentMaterial);
    leg.position.set(side * 0.12, HIP / 2, 0);
    group.add(leg);
    const boot = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.12, 0.26), darkMaterial);
    boot.position.set(side * 0.12, 0.06, -0.03);
    group.add(boot);
  }

  // ---- torso: a chamfered box reads as a vest at distance
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.27, 0.46, 4, 10), bodyMaterial);
  torso.position.y = HIP + 0.32;
  group.add(torso);

  const belt = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.1, 0.32), accentMaterial);
  belt.position.y = HIP + 0.02;
  group.add(belt);

  // ---- arms
  for (const side of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.085, 0.34, 3, 8), bodyMaterial);
    arm.position.set(side * 0.34, SHOULDER - 0.14, 0);
    arm.rotation.z = side * 0.12;
    group.add(arm);
  }

  // ---- head
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 10), bodyMaterial);
  head.position.y = HEAD_Y;
  group.add(head);

  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.27, 0.085, 0.07), accentMaterial);
  visor.position.set(0, HEAD_Y + 0.02, -0.17);
  group.add(visor);

  // ---- hat
  addHat(group, look.hat, accentMaterial, bodyMaterial);

  // ---- where a weapon is held, so the renderer can swap gun shapes in
  const gunMount = new THREE.Group();
  gunMount.position.set(0.24, SHOULDER - 0.12, -0.34);
  const gun = new THREE.Mesh(
    new THREE.BoxGeometry(0.09, 0.11, 0.46),
    new THREE.MeshStandardMaterial({ color: 0x2a3444, roughness: 0.7 }),
  );
  gunMount.add(gun);
  group.add(gunMount);

  return { group, gun, bodyMaterial };
}

function addHat(group, hat, accentMaterial, bodyMaterial) {
  if (!hat || hat === 'none') return;

  if (hat === 'cap') {
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.215, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), accentMaterial);
    dome.position.y = HEAD_Y + 0.05;
    dome.scale.y = 0.85;
    group.add(dome);
    const brim = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.04, 0.22), accentMaterial);
    brim.position.set(0, HEAD_Y + 0.06, -0.2);
    group.add(brim);
    return;
  }

  if (hat === 'helmet') {
    const shell = new THREE.Mesh(new THREE.SphereGeometry(0.235, 12, 10), accentMaterial);
    shell.position.y = HEAD_Y + 0.03;
    shell.scale.set(1, 0.82, 1);
    group.add(shell);
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.3, 0.42), bodyMaterial);
    stripe.position.y = HEAD_Y + 0.09;
    group.add(stripe);
    return;
  }

  if (hat === 'horns') {
    for (const side of [-1, 1]) {
      const horn = new THREE.Mesh(new THREE.ConeGeometry(0.055, 0.26, 6), accentMaterial);
      horn.position.set(side * 0.14, HEAD_Y + 0.26, 0);
      horn.rotation.z = side * -0.42;
      group.add(horn);
    }
    return;
  }

  if (hat === 'halo') {
    const halo = new THREE.Mesh(
      new THREE.TorusGeometry(0.19, 0.028, 6, 16),
      standard(accentMaterial.color, { emissive: accentMaterial.color.clone().multiplyScalar(0.6), roughness: 0.4 }),
    );
    halo.position.y = HEAD_Y + 0.38;
    halo.rotation.x = Math.PI / 2;
    group.add(halo);
    return;
  }

  if (hat === 'antenna') {
    const stalk = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.3, 6), accentMaterial);
    stalk.position.set(0, HEAD_Y + 0.32, 0);
    group.add(stalk);
    const bulb = new THREE.Mesh(
      new THREE.SphereGeometry(0.055, 8, 6),
      standard(accentMaterial.color, { emissive: accentMaterial.color.clone().multiplyScalar(0.7) }),
    );
    bulb.position.set(0, HEAD_Y + 0.49, 0);
    group.add(bulb);
  }
}
