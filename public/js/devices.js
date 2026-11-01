/**
 * Input device detection and arbitration.
 *
 * Three ways to play: keyboard + mouse, a gamepad, or touch. This module works out what the player
 * is on, watches for controllers being plugged in or put away, and decides which device is currently
 * driving.
 *
 * The rule is last input wins, seeded by platform:
 *   - phone/tablet        -> touch controls, until a controller is connected or used
 *   - desktop             -> keyboard + mouse, until a controller is used
 *   - controller connected -> that controller, until the screen is touched (or the keys are used)
 *
 * That is exactly the behaviour asked for: on mobile with a pad connected the controller drives, and
 * touching the screen hands control to the touchscreen. Picking the pad back up returns control to
 * it, so the two never fight over the same stick.
 */

export const DEVICE = {
  KEYBOARD: 'keyboard',
  TOUCH: 'touch',
  GAMEPAD: 'gamepad',
};

const STICK_DEADZONE = 0.18;
const TRIGGER_ON = 0.3;

/** Standard-mapping button indices, with the fallbacks some pads need. */
const BUTTON = {
  jump: [0],
  reload: [2],
  interact: [3],
  sprint: [6],
  fire: [7],
  slotPrev: [4],
  slotNext: [5],
  /** D-pad up draws the knife; L3 held slides. */
  slot3: [12],
  slide: [10],
  pause: [9],
};

function readButtons(pad) {
  return pad.buttons.map((b) => (typeof b === 'object' ? b.value || (b.pressed ? 1 : 0) : b || 0));
}

function pressed(buttons, indices, threshold = 0.5) {
  return indices.some((i) => (buttons[i] || 0) > threshold);
}

function deadzone(v, dz = STICK_DEADZONE) {
  const a = Math.abs(v);
  if (a < dz) return 0;
  const scaled = (a - dz) / (1 - dz);
  return v < 0 ? -scaled : scaled;
}

/** Phones and tablets report a coarse primary pointer; small screens with touch count too. */
export function detectPlatform() {
  if (typeof window === 'undefined') return 'desktop';
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  const touchPoints = navigator.maxTouchPoints || 0;
  const narrow = Math.min(window.innerWidth, window.innerHeight) < 820;
  const mobile = (coarse && touchPoints > 0) || (touchPoints > 1 && narrow);
  return mobile ? 'mobile' : 'desktop';
}

function firstConnectedPad() {
  const pads = navigator.getGamepads?.() ?? [];
  for (const pad of pads) if (pad && pad.connected) return pad;
  return null;
}

export class Devices {
  constructor({ onChange = null } = {}) {
    this.platform = detectPlatform();
    this.active = this.platform === 'mobile' ? DEVICE.TOUCH : DEVICE.KEYBOARD;
    this.pad = null;
    this.padName = '';
    this.onChange = onChange;
    /** Edge-triggered actions produced by the pad, drained by Input.consumeActions(). */
    this.padActions = { reload: false, interact: false, slot: 0, pause: false };
    this.prevPadButtons = [];
    this.prevPadAxes = [0, 0, 0, 0];

    window.addEventListener('gamepadconnected', (e) => {
      this.setPad(e.gamepad);
      // A pad that appears is a player saying they want to use it.
      this.setActive(DEVICE.GAMEPAD);
    });

    window.addEventListener('gamepaddisconnected', () => {
      this.setPad(null);
      if (this.active === DEVICE.GAMEPAD) {
        this.setActive(this.platform === 'mobile' ? DEVICE.TOUCH : DEVICE.KEYBOARD);
      }
    });
  }

  setPad(pad) {
    this.pad = pad;
    this.padName = pad?.id || '';
    this.prevPadButtons = [];
    this.prevPadAxes = [0, 0, 0, 0];
    if (!pad && this.active === DEVICE.GAMEPAD) {
      this.setActive(this.platform === 'mobile' ? DEVICE.TOUCH : DEVICE.KEYBOARD);
    }
  }

  setActive(device) {
    if (this.active === device) return;
    // A pad cannot drive if none is connected.
    if (device === DEVICE.GAMEPAD && !this.pad) return;
    this.active = device;
    this.onChange?.(device);
  }

  get hasGamepad() {
    return !!this.pad;
  }

  get usingGamepad() {
    return this.active === DEVICE.GAMEPAD;
  }

  get usingTouch() {
    return this.active === DEVICE.TOUCH;
  }

  /** Short human label for the lobby / HUD. */
  describe() {
    if (this.active === DEVICE.GAMEPAD) {
      const name = this.padName.replace(/\s*\(.*?\)\s*/g, ' ').trim();
      return name ? `Controller · ${name}` : 'Controller';
    }
    if (this.active === DEVICE.TOUCH) return 'Touchscreen';
    return 'Keyboard + mouse';
  }

  /**
   * Read the pad for this frame. Returns null when no pad is (or should be) driving.
   * Sticks are deadzoned; buttons are reported as held values plus edge-triggered actions.
   */
  pollPad() {
    // Some browsers only expose a pad after its first button press, without firing the event.
    if (!this.pad) {
      const found = firstConnectedPad();
      if (found) this.setPad(found);
    }
    const pad = this.pad;
    if (!pad) return null;

    // A pad that reports disconnection without an event.
    if (!pad.connected) {
      this.setPad(null);
      return null;
    }

    const buttons = readButtons(pad);
    const ax = deadzone(pad.axes[0] || 0);
    const ay = deadzone(pad.axes[1] || 0);
    const lx = deadzone(pad.axes[2] || 0);
    const ly = deadzone(pad.axes[3] || 0);

    // Any real stick or button movement claims control back from touch/keyboard.
    if (this.active !== DEVICE.GAMEPAD) {
      const moved =
        Math.abs(ax) > 0 || Math.abs(ay) > 0 || Math.abs(lx) > 0 || Math.abs(ly) > 0 ||
        buttons.some((v) => v > 0.5);
      if (moved) this.setActive(DEVICE.GAMEPAD);
    }

    // Edge detection against the previous frame.
    const prev = this.prevPadButtons;
    const rising = (indices, threshold = 0.5) =>
      pressed(buttons, indices, threshold) && !pressed(prev, indices, threshold);
    if (rising(BUTTON.reload)) this.padActions.reload = true;
    if (rising(BUTTON.interact)) this.padActions.interact = true;
    if (rising(BUTTON.slotNext)) this.padActions.slot = 2;
    if (rising(BUTTON.slotPrev)) this.padActions.slot = 1;
    if (rising(BUTTON.slot3)) this.padActions.slot = 3;
    if (rising(BUTTON.pause)) this.padActions.pause = true;
    this.prevPadButtons = buttons;

    return {
      active: this.active === DEVICE.GAMEPAD,
      move: { x: ax, z: -ay },
      look: { x: lx, y: ly },
      jump: pressed(buttons, BUTTON.jump),
      fire: pressed(buttons, BUTTON.fire, TRIGGER_ON),
      sprint: pressed(buttons, BUTTON.sprint, TRIGGER_ON),
      slide: pressed(buttons, BUTTON.slide),
    };
  }

  /** Drain pad actions queued since the last call. */
  takePadActions() {
    const a = this.padActions;
    this.padActions = { reload: false, interact: false, slot: 0, pause: false };
    return a;
  }
}
