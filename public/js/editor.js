/**
 * Character editor for the lobby.
 *
 * Three choices - body colour, trim colour, hat - rendered live on a small turntable so the player
 * sees exactly the model other people will see in the match. The choice is stored in localStorage
 * and sent with the join packet; the server validates it.
 *
 * The preview has its own tiny three.js scene and only renders while the lobby is on screen, so it
 * costs nothing once you have dropped in.
 */

import * as THREE from 'three';

import { ACCENT_COLORS, BODY_COLORS, DEFAULT_AVATAR, HATS, randomAvatar, sanitizeAvatar } from '../shared/avatar.js';
import { createAvatar } from './avatar-mesh.js';

const STORAGE_KEY = 'polyblast-avatar';

export class AvatarEditor {
  constructor({ onChange = null } = {}) {
    this.canvas = document.getElementById('avatar-canvas');
    this.bodyEl = document.getElementById('avatar-body');
    this.accentEl = document.getElementById('avatar-accent');
    this.hatsEl = document.getElementById('avatar-hats');
    this.shuffleEl = document.getElementById('avatar-shuffle');
    this.lobby = document.getElementById('lobby');
    this.onChange = onChange;

    this.avatar = sanitizeAvatar(this.load());
    this.group = null;
    this.running = false;
    this.spin = -0.5;

    this.buildOptions();
    this.initPreview();
    this.apply();

    this.tick = this.tick.bind(this);
    requestAnimationFrame(this.tick);
  }

  // ---------------------------------------------------------------- storage

  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : DEFAULT_AVATAR;
    } catch {
      return DEFAULT_AVATAR;
    }
  }

  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.avatar));
    } catch {
      /* private mode: the avatar just will not persist */
    }
  }

  // ---------------------------------------------------------------- options

  buildOptions() {
    if (this.bodyEl) {
      // Slot key must match the avatar field it sets, or the click silently does nothing.
      BODY_COLORS.forEach((color, index) => this.bodyEl.append(this.swatch(color, index, 'color')));
    }
    if (this.accentEl) {
      ACCENT_COLORS.forEach((color, index) => this.accentEl.append(this.swatch(color, index, 'accent')));
    }
    if (this.hatsEl) {
      HATS.forEach((hat, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'hat-btn';
        button.dataset.hat = String(index);
        button.textContent = hat.label;
        button.addEventListener('click', () => this.set({ hat: index }));
        this.hatsEl.append(button);
      });
    }
    this.shuffleEl?.addEventListener('click', () => this.set(randomAvatar()));
  }

  swatch(color, index, slot) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'swatch';
    button.dataset.slot = slot;
    button.dataset.index = String(index);
    button.style.setProperty('--swatch', color.hex);
    button.title = color.label;
    button.setAttribute('aria-label', color.label);
    button.addEventListener('click', () => this.set({ [slot]: index }));
    return button;
  }

  set(patch) {
    this.avatar = sanitizeAvatar({ ...this.avatar, ...patch });
    this.save();
    this.apply();
    this.onChange?.(this.avatar);
  }

  /** Reflect the current selection in the UI and rebuild the preview mesh. */
  apply() {
    for (const el of this.bodyEl?.querySelectorAll('[data-slot="color"]') || []) {
      el.classList.toggle('selected', Number(el.dataset.index) === this.avatar.color);
    }
    for (const el of this.accentEl?.querySelectorAll('[data-slot="accent"]') || []) {
      el.classList.toggle('selected', Number(el.dataset.index) === this.avatar.accent);
    }
    for (const el of this.hatsEl?.querySelectorAll('[data-hat]') || []) {
      el.classList.toggle('selected', Number(el.dataset.hat) === this.avatar.hat);
    }
    this.rebuildMesh();
  }

  // ---------------------------------------------------------------- preview

  initPreview() {
    if (!this.canvas) return;
    try {
      this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      this.renderer.setSize(this.canvas.clientWidth || 150, this.canvas.clientHeight || 150, false);
      this.scene = new THREE.Scene();
      this.camera = new THREE.PerspectiveCamera(34, 1, 0.1, 30);
      this.camera.position.set(0, 1.25, 3.4);
      this.camera.lookAt(0, 1.0, 0);
      this.scene.add(new THREE.HemisphereLight(0xbfd6f0, 0x1b2434, 1.5));
      const key = new THREE.DirectionalLight(0xfff0d0, 2.1);
      key.position.set(2.4, 3.6, 3);
      this.scene.add(key);
      const rim = new THREE.DirectionalLight(0x6fa8ff, 0.9);
      rim.position.set(-3, 2, -2.5);
      this.scene.add(rim);

      const grid = new THREE.GridHelper(2.4, 8, 0x35507a, 0x26374f);
      grid.position.y = 0;
      grid.material.transparent = true;
      grid.material.opacity = 0.5;
      this.scene.add(grid);
    } catch {
      // No WebGL (or it was blocked): the swatches still work, there is just no preview.
      this.canvas.classList.add('hidden');
    }
  }

  rebuildMesh() {
    if (!this.scene) return;
    if (this.group) {
      this.scene.remove(this.group);
      this.group.traverse((o) => {
        o.geometry?.dispose?.();
        o.material?.dispose?.();
      });
    }
    const built = createAvatar({
      body: BODY_COLORS[this.avatar.color].hex,
      accent: ACCENT_COLORS[this.avatar.accent].hex,
      hat: HATS[this.avatar.hat].id,
    });
    this.group = built.group;
    this.scene.add(this.group);
  }

  resize() {
    if (!this.renderer || !this.canvas) return;
    const size = this.canvas.clientWidth || 150;
    this.renderer.setSize(size, size, false);
    this.camera.aspect = 1;
    this.camera.updateProjectionMatrix();
  }

  tick() {
    requestAnimationFrame(this.tick);
    const visible = this.lobby && !this.lobby.classList.contains('hidden') && document.visibilityState === 'visible';
    if (!visible) {
      this.running = false;
      return;
    }
    if (!this.running) {
      this.running = true;
      this.resize();
    }
    if (!this.renderer || !this.group) return;
    this.group.rotation.y += 0.011;
    this.renderer.render(this.scene, this.camera);
  }
}
