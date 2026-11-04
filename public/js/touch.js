/**
 * Touchscreen controls: a left thumbstick for movement, drag-anywhere-else for looking, and a
 * cluster of action buttons.
 *
 * The controls are plain DOM on top of the canvas rather than something drawn into it, which keeps
 * hit testing away from the renderer and lets CSS handle safe-area insets on notched phones.
 *
 * Only one finger drives the stick and only one drives the look, so you can run and aim at the same
 * time; each control tracks its own pointer id.
 */

/** Radians of yaw per pixel dragged. Higher than mouse sensitivity: thumbs are less precise. */
const LOOK_SENSITIVITY = 0.0042;

/**
 * A slide needs a moment of speed before the server will launch it, and a tapped button can be
 * shorter than that moment. A slide press therefore keeps reporting "held" for this long after the
 * finger lifts, so a quick tap still slides instead of doing nothing.
 */
const SLIDE_MIN_HOLD = 0.3;

/** Pointer capture keeps a drag alive outside its element, but is not always available. */
function capture(element, pointerId) {
  try {
    element.setPointerCapture?.(pointerId);
  } catch {
    /* the pointer may already be gone; dragging just stops being tracked */
  }
}

export class TouchControls {
  constructor(devices) {
    this.devices = devices;
    this.enabled = false;

    this.axes = { x: 0, z: 0 };
    this.lookX = 0;
    this.lookY = 0;

    this.fire = false;
    this.jump = false;
    this.sprint = false;
    this.slide = false;
    /** Finger is physically on the slide button. */
    this.slideDown = false;
    /** Seconds of minimum hold left after a slide press, so a tap still slides. */
    this.slideHold = 0;
    this.scope = false;
    this.actions = { reload: false, interact: false, slot: 0, pause: false };

    this.root = document.getElementById('touch');
    this.stickZone = document.getElementById('stick-zone');
    this.stickBase = document.getElementById('stick-base');
    this.stickKnob = document.getElementById('stick-knob');
    this.lookZone = document.getElementById('look-zone');
    this.buttons = document.getElementById('touch-buttons');

    this.stickPointer = null;
    this.lookPointer = null;
    this.lastLook = { x: 0, y: 0 };
    this.stickRadius = 52;

    if (this.root) this.bind();
  }

  get available() {
    return !!this.root;
  }

  bind() {
    // Claiming the device on touch happens in Input, at window level: this layer is hidden while a
    // controller is in use, so it cannot be the thing that notices the screen being touched.

    // ---------------------------------------------------------------- stick
    this.stickZone.addEventListener('pointerdown', (e) => {
      if (!this.enabled || this.stickPointer !== null) return;
      e.preventDefault();
      this.stickPointer = e.pointerId;
      capture(this.stickZone, e.pointerId);
      const rect = this.stickBase.getBoundingClientRect();
      this.stickRadius = Math.max(28, rect.width / 2 - 14);
      this.stickCenter = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      this.updateStick(e.clientX, e.clientY);
    });

    this.stickZone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.stickPointer) return;
      e.preventDefault();
      this.updateStick(e.clientX, e.clientY);
    });

    const releaseStick = (e) => {
      if (e.pointerId !== this.stickPointer) return;
      this.stickPointer = null;
      this.axes.x = 0;
      this.axes.z = 0;
      this.moveKnob(0, 0);
    };
    this.stickZone.addEventListener('pointerup', releaseStick);
    this.stickZone.addEventListener('pointercancel', releaseStick);
    this.stickZone.addEventListener('lostpointercapture', releaseStick);

    // ----------------------------------------------------------------- look
    this.lookZone.addEventListener('pointerdown', (e) => {
      if (!this.enabled || this.lookPointer !== null) return;
      e.preventDefault();
      this.lookPointer = e.pointerId;
      capture(this.lookZone, e.pointerId);
      this.lastLook = { x: e.clientX, y: e.clientY };
    });

    this.lookZone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.lookPointer) return;
      e.preventDefault();
      const dx = e.clientX - this.lastLook.x;
      const dy = e.clientY - this.lastLook.y;
      this.lastLook = { x: e.clientX, y: e.clientY };
      this.lookX -= dx * LOOK_SENSITIVITY;
      this.lookY -= dy * LOOK_SENSITIVITY;
    });

    const releaseLook = (e) => {
      if (e.pointerId !== this.lookPointer) return;
      this.lookPointer = null;
    };
    this.lookZone.addEventListener('pointerup', releaseLook);
    this.lookZone.addEventListener('pointercancel', releaseLook);
    this.lookZone.addEventListener('lostpointercapture', releaseLook);

    // -------------------------------------------------------------- buttons
    for (const button of this.buttons.querySelectorAll('[data-act]')) {
      const act = button.dataset.act;
      const isHold =
        act === 'fire' || act === 'jump' || act === 'sprint' || act === 'slide' || act === 'scope';

      button.addEventListener('pointerdown', (e) => {
        if (!this.enabled) return;
        e.preventDefault();
        e.stopPropagation();
        capture(button, e.pointerId);
        button.classList.add('held');
        if (act === 'fire') this.fire = true;
        else if (act === 'jump') this.jump = true;
        else if (act === 'sprint') this.sprint = true;
        else if (act === 'slide') {
          this.slideDown = true;
          this.slideHold = SLIDE_MIN_HOLD;
          this.slide = true;
        }
        else if (act === 'scope') this.scope = true;
        else if (act === 'reload') this.actions.reload = true;
        else if (act === 'interact') this.actions.interact = true;
        else if (act === 'pause') this.actions.pause = true;
        else if (act === 'slot1') this.actions.slot = 1;
        else if (act === 'slot2') this.actions.slot = 2;
        else if (act === 'slot3') this.actions.slot = 3;
      });

      const release = (e) => {
        if (isHold) {
          if (act === 'fire') this.fire = false;
          else if (act === 'jump') this.jump = false;
          else if (act === 'sprint') this.sprint = false;
          else if (act === 'slide') this.slideDown = false;
          else if (act === 'scope') this.scope = false;
        }
        button.classList.remove('held');
        e?.preventDefault?.();
      };
      button.addEventListener('pointerup', release);
      button.addEventListener('pointercancel', release);
      button.addEventListener('lostpointercapture', release);
      // Buttons must never submit or focus-trap; they are game input.
      button.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    // Dragging off a button (or losing the window) must not leave the trigger down.
    window.addEventListener('blur', () => this.clear());
  }

  updateStick(clientX, clientY) {
    const dx = clientX - this.stickCenter.x;
    const dy = clientY - this.stickCenter.y;
    const len = Math.hypot(dx, dy);
    const max = this.stickRadius;
    const scale = len > max ? max / len : 1;
    const kx = dx * scale;
    const ky = dy * scale;
    this.moveKnob(kx, ky);
    // Normalise so gentle pushes walk and full pushes run at top speed.
    this.axes.x = kx / max;
    this.axes.z = -ky / max;
  }

  moveKnob(x, y) {
    this.stickKnob.style.transform = `translate(${x}px, ${y}px)`;
    this.stickBase.classList.toggle('active', x !== 0 || y !== 0);
  }

  /**
   * Advance the timers that outlive a finger leaving a button. Driven once per frame by Input, so the
   * minimum slide hold does not depend on how often the browser delivers pointer events.
   */
  tick(dt) {
    if (this.slideHold > 0) this.slideHold = Math.max(0, this.slideHold - dt);
    if (!this.slideDown) this.slide = this.slideHold > 0;
  }

  /** Look movement accumulated since the last call, consumed by Input. */
  drainLook() {
    const out = { x: this.lookX, y: this.lookY };
    this.lookX = 0;
    this.lookY = 0;
    return out;
  }

  takeActions() {
    const a = this.actions;
    this.actions = { reload: false, interact: false, slot: 0, pause: false };
    return a;
  }

  clear() {
    this.axes.x = 0;
    this.axes.z = 0;
    this.fire = false;
    this.jump = false;
    this.sprint = false;
    this.slide = false;
    this.slideDown = false;
    this.slideHold = 0;
    this.scope = false;
    this.stickPointer = null;
    this.lookPointer = null;
    this.moveKnob(0, 0);
  }

  show(visible) {
    if (!this.root) return;
    this.root.classList.toggle('hidden', !visible);
    if (!visible) this.clear();
  }
}
