/**
 * Player input: keyboard + mouse, gamepad, or touchscreen.
 *
 * Whatever the player uses, this class produces one stream of movement axes, aim and actions, so the
 * rest of the client (and the server) neither knows nor cares which device is driving.
 *
 * Continuous state (movement axes, fire) is read every frame. One-shot actions (reload, interact,
 * weapon slot) are latched until the next network tick consumes them, because a keypress can easily
 * land between two 30 Hz input packets.
 *
 * Which device is live is decided by Devices: last input wins, seeded by platform. On a phone with a
 * controller attached the pad drives until the screen is touched.
 */

import { Devices, DEVICE } from './devices.js';
import { TouchControls } from './touch.js';

const MOVE_KEYS = {
  KeyW: 'forward',
  ArrowUp: 'forward',
  KeyS: 'back',
  ArrowDown: 'back',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
};

const SENSITIVITY = 0.0021;
/** Radians per second at full stick deflection. */
const PAD_LOOK_SPEED = 3.1;
const MAX_PITCH = Math.PI / 2 - 0.06;

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.mouseFire = false;
    this.locked = false;
    this.yaw = 0;
    this.pitch = 0;
    this.actions = { reload: false, interact: false, slot: 0 };
    this.onLockChange = null;
    this.onAction = null;
    this.onDeviceChange = null;
    this.enabled = false;

    this.devices = new Devices({ onChange: (device) => this.handleDeviceChange(device) });
    this.touch = new TouchControls(this.devices);
    this.pad = null;

    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('keyup', (e) => this.onKeyUp(e));
    window.addEventListener('blur', () => this.clear());

    canvas.addEventListener('mousedown', (e) => {
      if (!this.enabled) return;
      if (this.devices.platform !== 'mobile') this.devices.setActive(DEVICE.KEYBOARD);
      if (e.button === 0) this.mouseFire = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouseFire = false;
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    // Touching the screen hands control to the touchscreen - even while a controller is driving and
    // the touch layer is hidden. This is the "until you touch the screen" half of the switch rule.
    window.addEventListener(
      'pointerdown',
      (e) => {
        if (!this.enabled) return;
        if (e.pointerType === 'touch' || e.pointerType === 'pen') this.devices.setActive(DEVICE.TOUCH);
      },
      { capture: true },
    );

    document.addEventListener('mousemove', (e) => {
      if (!this.locked || this.devices.usingTouch) return;
      this.look(e.movementX * -SENSITIVITY, e.movementY * -SENSITIVITY);
    });

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) this.mouseFire = false;
      this.onLockChange?.(this.locked);
    });
  }

  /** Apply a yaw/pitch delta and keep both in range. */
  look(dYaw, dPitch) {
    this.yaw += dYaw;
    this.pitch += dPitch;
    this.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, this.pitch));
    // Keep yaw in [-PI, PI] so snapshots stay small.
    if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
    if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;
  }

  handleDeviceChange(device) {
    if (device === DEVICE.TOUCH) this.exitLock();
    if (device !== DEVICE.TOUCH) this.touch.clear();
    this.syncTouchLayer();
    this.onDeviceChange?.(device);
  }

  syncTouchLayer() {
    const showTouch = this.enabled && this.devices.usingTouch && this.devices.platform === 'mobile';
    this.touch.enabled = showTouch;
    this.touch.show(showTouch);
  }

  onKeyDown(e) {
    if (!this.enabled) return;
    if (MOVE_KEYS[e.code] || ['Space', 'ShiftLeft', 'ShiftRight', 'KeyR', 'KeyE', 'Digit1', 'Digit2'].includes(e.code)) {
      e.preventDefault();
    }
    this.keys.add(e.code);
    if (this.devices.platform !== 'mobile') this.devices.setActive(DEVICE.KEYBOARD);

    if (e.repeat) return;
    switch (e.code) {
      case 'KeyR':
        this.actions.reload = true;
        break;
      case 'KeyE':
        this.actions.interact = true;
        break;
      case 'Digit1':
        this.actions.slot = 1;
        break;
      case 'Digit2':
        this.actions.slot = 2;
        break;
      case 'Escape':
        this.onAction?.('escape');
        break;
    }
  }

  onKeyUp(e) {
    this.keys.delete(e.code);
  }

  clear() {
    this.keys.clear();
    this.mouseFire = false;
    this.touch.clear();
  }

  requestLock() {
    if (this.devices.platform === 'mobile') return;
    if (document.pointerLockElement !== this.canvas) {
      const p = this.canvas.requestPointerLock?.();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }
  }

  exitLock() {
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
  }

  /**
   * Sample non-mouse devices and fold them into the shared state. Called once per frame.
   * Mouse look is event-driven, so it needs no polling.
   */
  update(dt) {
    this.syncTouchLayer();

    const pad = this.devices.pollPad();
    this.pad = pad;

    // Edge-triggered pad/touch actions are latched exactly like key presses.
    const padActions = this.devices.takePadActions();
    const touchActions = this.touch.takeActions();
    for (const a of [padActions, touchActions]) {
      if (a.pause) this.onAction?.('pause');
      if (a.reload) this.actions.reload = true;
      if (a.interact) this.actions.interact = true;
      if (a.slot) this.actions.slot = a.slot;
    }

    if (this.devices.usingGamepad && pad) {
      this.look(-pad.look.x * PAD_LOOK_SPEED * dt, -pad.look.y * PAD_LOOK_SPEED * dt);
    } else if (this.devices.usingTouch) {
      const look = this.touch.drainLook();
      this.look(look.x, look.y);
    } else {
      this.touch.drainLook();
    }
  }

  /** Movement axes in [-1, 1] for the current frame. */
  axes() {
    if (this.devices.usingTouch) return { x: this.touch.axes.x, z: this.touch.axes.z };
    if (this.devices.usingGamepad && this.pad) return { x: this.pad.move.x, z: this.pad.move.z };

    let x = 0;
    let z = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) z += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) z -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) x += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) x -= 1;
    const len = Math.hypot(x, z);
    if (len > 1) {
      x /= len;
      z /= len;
    }
    return { x, z };
  }

  isSprinting() {
    if (this.devices.usingTouch) return this.touch.sprint;
    if (this.devices.usingGamepad && this.pad) return this.pad.sprint;
    return this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
  }

  isJumping() {
    if (this.devices.usingTouch) return this.touch.jump;
    if (this.devices.usingGamepad && this.pad) return this.pad.jump;
    return this.keys.has('Space');
  }

  /** True while the trigger is down, from whichever device is live. */
  get fire() {
    if (this.devices.usingTouch) return this.touch.fire;
    if (this.devices.usingGamepad && this.pad) return this.pad.fire;
    return this.mouseFire;
  }

  /** Read and clear the latched one-shot actions. */
  consumeActions() {
    const a = this.actions;
    this.actions = { reload: false, interact: false, slot: 0 };
    return a;
  }
}
