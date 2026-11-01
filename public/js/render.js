/**
 * Three.js presentation layer. No game rules live here: it consumes an already-interpolated view
 * produced by main.js and turns it into meshes, effects and camera placement.
 */

import * as THREE from 'three';

import { HATS } from '../shared/avatar.js';
import { createAvatar } from './avatar-mesh.js';

const EYE = 1.62;
const ZONE_HEIGHT = 26;
const TRACER_MAX = 96;
const SPARK_MAX = 24;

const WEAPON_LOOK = {
  pistol: { color: 0xffd166, length: 0.34, thick: 0.1 },
  smg: { color: 0x7ae582, length: 0.5, thick: 0.12 },
  shotgun: { color: 0xff8b6b, length: 0.62, thick: 0.15 },
  rifle: { color: 0x8ecae6, length: 0.7, thick: 0.11 },
  unarmed: { color: 0x8fa3bb, length: 0.2, thick: 0.08 },
};

const LOOT_LOOK = {
  weapon: { color: 0xffd166, size: [0.15, 0.15, 0.7] },
  ammo: { color: 0xffb703, size: [0.3, 0.24, 0.3] },
  medkit: { color: 0xff5d8f, size: [0.36, 0.36, 0.36] },
  armor: { color: 0x8ecae6, size: [0.44, 0.56, 0.09] },
};

function softCircleTexture() {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function labelTexture(text, color) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.font = 'bold 58px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 10;
  ctx.strokeStyle = 'rgba(5,8,14,0.85)';
  ctx.strokeText(text, 256, 64);
  ctx.fillStyle = color || '#ffffff';
  ctx.fillText(text, 256, 64);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.time = 0;
    this.shake = 0;
    // Recoil amount. Must not be called `kick`: that name is the method below, and an own property
    // in the constructor shadows the prototype method.
    this.recoil = 0;
    this.players = new Map();
    this.loot = new Map();
    this.tracers = [];
    this.sparks = [];
    this.selfId = null;
    this.worldSeed = null;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x0b0f17, 1);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0f1622);
    this.scene.fog = new THREE.Fog(0x0f1622, 45, 165);

    this.camera = new THREE.PerspectiveCamera(78, 1, 0.05, 320);
    this.scene.add(this.camera);

    const hemi = new THREE.HemisphereLight(0x9dc0e6, 0x1a2130, 1.05);
    this.scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffe9c4, 1.35);
    dir.position.set(45, 70, 25);
    this.scene.add(dir);
    const fill = new THREE.DirectionalLight(0x6f8fbf, 0.35);
    fill.position.set(-40, 30, -35);
    this.scene.add(fill);

    this.groundMat = new THREE.MeshStandardMaterial({ color: 0x1b2334, roughness: 1, metalness: 0 });
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(360, 360), this.groundMat);
    this.ground.rotation.x = -Math.PI / 2;
    this.scene.add(this.ground);

    this.grid = new THREE.GridHelper(320, 128, 0x2c3a52, 0x222c3d);
    this.grid.position.y = 0.014;
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.5;
    this.scene.add(this.grid);

    this.worldGroup = new THREE.Group();
    this.scene.add(this.worldGroup);

    this.buildBackdrop();
    this.buildZone();
    this.buildTracers();
    this.buildSparks();
    this.buildViewmodel();

    this.materialCache = new Map();
    this.lootMaterialCache = new Map();
  }

  // ------------------------------------------------------------------ setup

  buildBackdrop() {
    // A ring of distant low-poly mesas so the horizon isn't an empty void.
    const geo = new THREE.ConeGeometry(1, 1, 5);
    const mat = new THREE.MeshStandardMaterial({ color: 0x1b2638, roughness: 1, flatShading: true });
    const group = new THREE.Group();
    for (let i = 0; i < 22; i++) {
      const a = (i / 22) * Math.PI * 2 + Math.random() * 0.2;
      const r = 135 + Math.random() * 45;
      const h = 16 + Math.random() * 34;
      const w = 14 + Math.random() * 22;
      const m = new THREE.Mesh(geo, mat);
      m.position.set(Math.cos(a) * r, h / 2 - 2, Math.sin(a) * r);
      m.scale.set(w, h, w);
      group.add(m);
    }
    this.scene.add(group);
  }

  buildZone() {
    const wallMat = new THREE.MeshBasicMaterial({
      color: 0x58c7ff,
      transparent: true,
      opacity: 0.1,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.zoneWall = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 72, 1, true), wallMat);
    this.zoneWall.position.y = ZONE_HEIGHT / 2;
    this.zoneWall.renderOrder = 2;
    this.scene.add(this.zoneWall);

    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x58c7ff,
      transparent: true,
      opacity: 0.55,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.zoneRing = new THREE.Mesh(new THREE.RingGeometry(0.975, 1, 96), ringMat);
    this.zoneRing.rotation.x = -Math.PI / 2;
    this.zoneRing.position.y = 0.05;
    this.scene.add(this.zoneRing);

    const nextMat = new THREE.MeshBasicMaterial({
      color: 0xdfe9f5,
      transparent: true,
      opacity: 0.22,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.nextRing = new THREE.Mesh(new THREE.RingGeometry(0.988, 1, 80), nextMat);
    this.nextRing.rotation.x = -Math.PI / 2;
    this.nextRing.position.y = 0.06;
    this.scene.add(this.nextRing);
  }

  buildTracers() {
    this.tracerGeo = new THREE.BufferGeometry();
    this.tracerPositions = new Float32Array(TRACER_MAX * 2 * 3);
    this.tracerColors = new Float32Array(TRACER_MAX * 2 * 3);
    this.tracerGeo.setAttribute('position', new THREE.BufferAttribute(this.tracerPositions, 3));
    this.tracerGeo.setAttribute('color', new THREE.BufferAttribute(this.tracerColors, 3));
    this.tracerGeo.setDrawRange(0, 0);
    const mat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.tracerMesh = new THREE.LineSegments(this.tracerGeo, mat);
    this.tracerMesh.frustumCulled = false;
    this.scene.add(this.tracerMesh);
    this.sparkTex = softCircleTexture();
  }

  buildSparks() {
    this.sparkPool = [];
    for (let i = 0; i < SPARK_MAX; i++) {
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: this.sparkTex,
          color: 0xffd9a0,
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      sprite.visible = false;
      sprite.scale.setScalar(0.4);
      this.scene.add(sprite);
      this.sparkPool.push({ sprite, life: 0, max: 0.18 });
    }
  }

  buildViewmodel() {
    this.viewmodel = new THREE.Group();
    this.gunGroup = new THREE.Group();

    this.gunMaterial = new THREE.MeshStandardMaterial({ color: 0x8fa3bb, roughness: 0.55, metalness: 0.3 });
    this.gunDark = new THREE.MeshStandardMaterial({ color: 0x2a3444, roughness: 0.8, metalness: 0.2 });

    this.gunBody = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.105, 0.5), this.gunMaterial);
    this.gunBody.position.set(0, 0, -0.22);
    this.gunGroup.add(this.gunBody);

    this.gunBarrel = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.34), this.gunDark);
    this.gunBarrel.position.set(0, 0.012, -0.6);
    this.gunGroup.add(this.gunBarrel);

    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.17, 0.1), this.gunDark);
    grip.position.set(0, -0.12, 0.03);
    grip.rotation.x = 0.16;
    this.gunGroup.add(grip);

    const sight = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.045, 0.1), this.gunDark);
    sight.position.set(0, 0.08, -0.18);
    this.gunGroup.add(sight);

    this.gunGroup.position.set(0.23, -0.19, -0.3);
    this.gunGroup.rotation.y = 0.05;
    this.viewmodel.add(this.gunGroup);

    this.muzzle = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.sparkTex,
        color: 0xffe6a0,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.muzzle.position.set(0, 0.02, -0.78);
    this.muzzle.scale.setScalar(0.45);
    this.muzzle.visible = false;
    this.gunGroup.add(this.muzzle);
    this.muzzleTimer = 0;

    this.camera.add(this.viewmodel);
  }

  // ------------------------------------------------------------------ world

  setWorld(world) {
    if (!world || this.worldSeed === world.seed) return;
    this.worldSeed = world.seed;

    while (this.worldGroup.children.length) {
      const child = this.worldGroup.children.pop();
      child.geometry?.dispose?.();
    }
    // Loot ids restart every match, so stale pickups must go or they'd inherit new ids.
    for (const [, entry] of this.loot) {
      this.scene.remove(entry.group);
      entry.group.traverse((o) => {
        o.geometry?.dispose?.();
        o.material?.dispose?.();
      });
    }
    this.loot.clear();

    const unit = new THREE.BoxGeometry(1, 1, 1);
    for (const box of world.boxes) {
      const w = box.maxX - box.minX;
      const d = box.maxZ - box.minZ;
      const h = box.height;
      const mat = this.boxMaterial(box.color, box.kind);
      const mesh = new THREE.Mesh(unit, mat);
      mesh.scale.set(w, h, d);
      mesh.position.set((box.minX + box.maxX) / 2, h / 2, (box.minZ + box.maxZ) / 2);
      this.worldGroup.add(mesh);
    }
  }

  boxMaterial(color, kind) {
    const key = `${color}:${kind}`;
    if (this.materialCache.has(key)) return this.materialCache.get(key);
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(color),
      roughness: kind === 'container' ? 0.6 : 0.92,
      metalness: kind === 'container' ? 0.25 : 0.02,
      flatShading: true,
    });
    this.materialCache.set(key, mat);
    return mat;
  }

  // ------------------------------------------------------------------ players

  playerMesh(p) {
    // Rebuild when the avatar changes; otherwise keep the existing body.
    const key = `${p.c}|${p.ac}|${p.h}`;
    let entry = this.players.get(p.id);
    if (entry && entry.key === key) return entry;
    if (entry) {
      this.disposePlayer(p.id);
      entry = null;
    }

    const group = new THREE.Group();
    const built = createAvatar({ body: p.c, accent: p.ac, hat: HATS[p.h]?.id || 'none' });
    group.add(built.group);
    const gun = built.gun;

    const shadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.5, 16),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.26, depthWrite: false }),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.02;
    group.add(shadow);

    const shield = new THREE.Mesh(
      new THREE.SphereGeometry(1.05, 14, 10),
      new THREE.MeshBasicMaterial({
        color: 0x7cc7f5,
        transparent: true,
        opacity: 0.14,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    shield.position.y = 0.95;
    shield.visible = false;
    group.add(shield);

    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: labelTexture(p.n, p.c),
        transparent: true,
        depthWrite: false,
        // Occluded by geometry: names drawn through walls gave away everyone's position.
        depthTest: true,
      }),
    );
    sprite.scale.set(2.2, 0.55, 1);
    sprite.position.y = 2.28;
    group.add(sprite);

    this.scene.add(group);
    entry = { group, shield, sprite, gun, key, name: p.n, visible: true };
    this.players.set(p.id, entry);
    return entry;
  }

  /** Remove one player's meshes and free their GPU resources. */
  disposePlayer(id) {
    const entry = this.players.get(id);
    if (!entry) return;
    this.scene.remove(entry.group);
    entry.group.traverse((o) => {
      o.geometry?.dispose?.();
      if (o.material) {
        o.material.map?.dispose?.();
        o.material.dispose?.();
      }
    });
    this.players.delete(id);
  }

  // ------------------------------------------------------------------ effects

  addTracer(from, to, color = 0xffe0a0) {
    this.tracers.push({
      ax: from.x,
      ay: from.y,
      az: from.z,
      bx: to.x,
      by: to.y,
      bz: to.z,
      life: 0.085,
      max: 0.085,
      color: new THREE.Color(color),
    });
    if (this.tracers.length > TRACER_MAX) this.tracers.shift();
  }

  addSpark(x, y, z, color = 0xffd9a0) {
    const slot = this.sparkPool.find((s) => s.life <= 0) || this.sparkPool[0];
    slot.sprite.position.set(x, y, z);
    slot.sprite.material.color.setHex(color);
    slot.sprite.visible = true;
    slot.life = slot.max;
    slot.sprite.scale.setScalar(0.5);
  }

  kick(n = 1) {
    this.recoil = Math.min(1.4, this.recoil + 0.5 * n);
    this.muzzle.visible = true;
    this.muzzleTimer = 0.05;
  }

  addShake(n = 0.3) {
    this.shake = Math.min(1, this.shake + n);
  }

  // ------------------------------------------------------------------ frame

  update(view, dt) {
    this.time += dt;
    this.selfId = view.me.id;

    this.updateCamera(view, dt);
    this.updatePlayers(view, dt);
    this.updateLoot(view);
    this.updateZone(view, dt);
    this.updateTracers(dt);
    this.updateSparks(dt);
    this.updateViewmodel(view, dt);
  }

  updateCamera(view, dt) {
    const me = view.me;
    if (me.alive) {
      this.camera.position.set(me.x, me.y + EYE, me.z);
      this.camera.rotation.set(me.pitch, me.yaw, 0, 'YXZ');
      this.viewmodel.visible = true;
    } else {
      this.viewmodel.visible = false;
      const killer = view.players.find((p) => p.id === view.spectateId && p.alive);
      if (killer) {
        const fx = -Math.sin(killer.yaw);
        const fz = -Math.cos(killer.yaw);
        this.camera.position.set(killer.x - fx * 4.2, killer.y + 3.0, killer.z - fz * 4.2);
        this.camera.lookAt(killer.x, killer.y + 1.2, killer.z);
      } else {
        const a = this.time * 0.12;
        const r = Math.max(16, view.zone.r * 0.55);
        this.camera.position.set(view.zone.x + Math.cos(a) * r, 26, view.zone.z + Math.sin(a) * r);
        this.camera.lookAt(view.zone.x, 0, view.zone.z);
      }
    }

    // Damage shake, decaying fast.
    this.shake = Math.max(0, this.shake - dt * 1.8);
    if (this.shake > 0.001) {
      const s = this.shake * 0.02;
      this.camera.rotation.x += (Math.random() - 0.5) * s;
      this.camera.rotation.y += (Math.random() - 0.5) * s;
      this.camera.rotation.z = (Math.random() - 0.5) * s * 0.6;
    }
  }

  updatePlayers(view) {
    const seen = new Set();
    for (const p of view.players) {
      if (p.id === this.selfId) continue;
      seen.add(p.id);
      const entry = this.playerMesh(p);
      // Snapshots flag liveness as `al`; using `alive` here left every other player invisible.
      entry.group.visible = !!p.al;
      if (!p.al) continue;
      entry.group.position.set(p.x, p.y, p.z);
      entry.group.rotation.y = p.yaw;
      entry.shield.visible = !!p.sh && p.al;
      // Straight above someone standing in your face the name tag fills half the screen.
      const near = (p.x - view.me.x) ** 2 + (p.z - view.me.z) ** 2 < 2.4 * 2.4;
      entry.sprite.visible = !near;
      // Gun length hints at what they're holding.
      const look = WEAPON_LOOK[p.w || 'unarmed'];
      entry.gun.scale.z = (look.length / 0.46) * 1.0;
      entry.gun.material.color.setHex(look.color);
    }
    for (const id of [...this.players.keys()]) {
      if (!seen.has(id)) this.disposePlayer(id);
    }
  }

  updateLoot(view) {
    const seen = new Set();
    for (const item of view.loot) {
      seen.add(item.id);
      let entry = this.loot.get(item.id);
      if (!entry) {
        const look = LOOT_LOOK[item.k] || LOOT_LOOK.ammo;
        const color = item.k === 'weapon' && item.w
          ? new THREE.Color(WEAPON_LOOK[item.w]?.color ?? 0xffd166)
          : new THREE.Color(look.color);
        const geo = new THREE.BoxGeometry(...look.size);
        const mat = new THREE.MeshStandardMaterial({
          color,
          emissive: color.clone().multiplyScalar(0.35),
          roughness: 0.5,
          metalness: 0.2,
          flatShading: true,
        });
        const mesh = new THREE.Mesh(geo, mat);

        const beam = new THREE.Mesh(
          new THREE.CylinderGeometry(0.055, 0.055, 2.6, 6, 1, true),
          new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity: 0.16,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            side: THREE.DoubleSide,
          }),
        );
        beam.position.y = 1.3;

        const group = new THREE.Group();
        group.add(mesh);
        group.add(beam);
        group.position.set(item.x, 0.6, item.z);
        this.scene.add(group);
        entry = { group, mesh, phase: Math.random() * Math.PI * 2 };
        this.loot.set(item.id, entry);
      }
      entry.group.position.set(item.x, 0.62 + Math.sin(this.time * 1.8 + entry.phase) * 0.07, item.z);
      entry.mesh.rotation.y = this.time * 1.1 + entry.phase;
    }
    for (const [id, entry] of this.loot) {
      if (seen.has(id)) continue;
      this.scene.remove(entry.group);
      entry.group.traverse((o) => {
        o.geometry?.dispose?.();
        o.material?.dispose?.();
      });
      this.loot.delete(id);
    }
  }

  updateZone(view) {
    const z = view.zone;
    this.zoneWall.position.set(z.x, ZONE_HEIGHT / 2, z.z);
    this.zoneWall.scale.set(z.r, ZONE_HEIGHT, z.r);
    this.zoneRing.position.set(z.x, 0.05, z.z);
    this.zoneRing.scale.setScalar(z.r);

    const closing = z.mode === 'close';
    const final = z.mode === 'final';
    const wallColor = final ? 0xff5d6c : closing ? 0xffb457 : 0x58c7ff;
    this.zoneWall.material.color.setHex(wallColor);
    this.zoneRing.material.color.setHex(wallColor);
    this.zoneWall.material.opacity = closing || final ? 0.16 : 0.1;

    // Show where the next circle will be while it's closing.
    const showNext = closing && z.tr < z.r - 0.5;
    this.nextRing.visible = showNext;
    if (showNext) {
      this.nextRing.position.set(z.tx, 0.06, z.tz);
      this.nextRing.scale.setScalar(z.tr);
    }
  }

  updateTracers(dt) {
    if (!this.tracers.length) {
      this.tracerGeo.setDrawRange(0, 0);
      return;
    }
    const pos = this.tracerPositions;
    const col = this.tracerColors;
    let i = 0;
    const survivors = [];
    for (const tr of this.tracers) {
      tr.life -= dt;
      if (tr.life <= 0) continue;
      survivors.push(tr);
      if (i >= TRACER_MAX) break;
      const fade = tr.life / tr.max;
      const o = i * 6;
      pos[o] = tr.ax;
      pos[o + 1] = tr.ay;
      pos[o + 2] = tr.az;
      pos[o + 3] = tr.bx;
      pos[o + 4] = tr.by;
      pos[o + 5] = tr.bz;
      col[o] = tr.color.r * fade;
      col[o + 1] = tr.color.g * fade;
      col[o + 2] = tr.color.b * fade;
      col[o + 3] = tr.color.r * fade * 0.55;
      col[o + 4] = tr.color.g * fade * 0.55;
      col[o + 5] = tr.color.b * fade * 0.55;
      i++;
    }
    this.tracers = survivors;
    this.tracerGeo.setDrawRange(0, i * 2);
    this.tracerGeo.attributes.position.needsUpdate = true;
    this.tracerGeo.attributes.color.needsUpdate = true;
  }

  updateSparks(dt) {
    for (const s of this.sparkPool) {
      if (s.life <= 0) {
        s.sprite.visible = false;
        continue;
      }
      s.life -= dt;
      const f = Math.max(0, s.life / s.max);
      s.sprite.material.opacity = f;
      s.sprite.scale.setScalar(0.5 + (1 - f) * 1.1);
    }
  }

  updateViewmodel(view, dt) {
    // Never show a gun the player has not picked up yet.
    const armed = !!view.me.weapon;
    this.gunGroup.visible = armed;
    if (!armed) return;

    const look = WEAPON_LOOK[view.me.weapon] || WEAPON_LOOK.unarmed;
    this.gunMaterial.color.setHex(look.color);
    this.gunBarrel.scale.z = look.length / 0.34;
    this.gunBarrel.position.z = -0.45 - look.length * 0.42;
    this.gunBody.scale.set(look.thick / 0.085 * 0.85, 1, 1);

    this.recoil = Math.max(0, this.recoil - dt * 9);
    this.gunGroup.position.z = -0.3 + this.recoil * 0.07;
    this.gunGroup.rotation.x = this.recoil * 0.28;
    // Subtle idle sway so the weapon doesn't look pasted on.
    this.gunGroup.position.x = 0.23 + Math.sin(this.time * 1.1) * 0.004;
    this.gunGroup.position.y = -0.19 + Math.sin(this.time * 1.7) * 0.004 - Math.abs(this.recoil) * 0.01;

    this.muzzleTimer -= dt;
    if (this.muzzleTimer <= 0) this.muzzle.visible = false;
    else this.muzzle.scale.setScalar(0.35 + Math.random() * 0.25);
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  resize(width, height) {
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }
}
