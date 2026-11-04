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
/**
 * How far a stick must be pushed to take control back. Jitter around the deadzone - which a worn
 * stick produces constantly - must not count as the player picking the pad up again.
 */
const STICK_CLAIM = 0.45;
/** Grace period after a screen touch before a pad may claim control again. */
const TOUCH_GRACE = 0.5;

/**
 * Standard-mapping button indices.
 *
 * 0 A, 1 B, 2 X, 3 Y, 4 LB, 5 RB, 6 LT, 7 RT, 8 back, 9 start, 10 L3, 11 R3,
 * 12-15 d-pad. The wobble earlier was that LB/RB acted as "slot 1 / slot 2" rather than as a scope
 * and a weapon cycle, and B - the button most players expect to crouch with - did nothing at all.
 */
const BUTTON = {
  jump: [0],
  slide: [1, 10],
  reload: [2],
  interact: [3],
  scope: [4],
  cycle: [5],
  sprint: [6],
  fire: [7],
  pause: [9],
  knife: [12],
  prevGun: [14],
  nextGun: [15],
};

function readButtons(pad) {
  // A pad without a `buttons` list must read as "nothing pressed" rather than throwing once per
  // frame, which used to take the whole render loop down with it.
  return Array.from(pad.buttons || [], (b) =>
    typeof b === 'object' && b ? b.value || (b.pressed ? 1 : 0) : Number(b) || 0,
  );
}

function pressed(buttons, indices, threshold = 0.5) {
  return indices.some((i) => (buttons[i] || 0) > threshold);
}

/** A trigger reported as an axis rests at -1 and is fully pulled at +1. Normalise it to 0..1. */
function axisTrigger(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  if (v < -0.55) return (v + 1) / 2;
  return v > 0.3 ? v : 0;
}

/**
 * Some pads (and some browsers) expose the triggers as axes instead of buttons 6/7, which used to
 * leave fire and sprint dead. Fall back to axes 5/4 when the button reports nothing.
 */
function trigger(buttons, axes, buttonIndex, axisIndex) {
  const value = buttons[buttonIndex] || 0;
  if (value > 0.05) return value;
  return axisTrigger(axes[axisIndex]);
}

/**
 * Radial deadzone: the magnitude is clamped and the direction preserved. Per-axis deadzones bend
 * diagonals (pushing up-right came out more right than up) and let slow drift through.
 */
function deadStick(x = 0, y = 0, dz = STICK_DEADZONE) {
  const magnitude = Math.hypot(x, y);
  if (magnitude < dz) return { x: 0, y: 0 };
  const scale = (magnitude - dz) / (1 - dz) / magnitude;
  return { x: x * scale, y: y * scale };
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

/**
 * The pad object delivered with `gamepadconnected` is a frozen snapshot in some browsers - Chrome
 * never updates it - so reading straight from it made a connected pad look dead: right name in the
 * lobby, every button and stick permanently zero. Always prefer the live entry for the same index,
 * and fall back to the stored object only when the browser gives us nothing.
 */
function livePad(stored) {
  if (!stored) return null;
  const pads = navigator.getGamepads?.() ?? [];
  const match = pads[stored.index];
  return match && match.connected ? match : stored;
}

export class Devices {
  constructor({ onChange = null } = {}) {
    this.platform = detectPlatform();
    this.active = this.platform === 'mobile' ? DEVICE.TOUCH : DEVICE.KEYBOARD;
    this.pad = null;
    this.padName = '';
    this.onChange = onChange;
    /** Edge-triggered actions produced by the pad, drained by Input.consumeActions(). */
    this.padActions = { reload: false, interact: false, slot: 0, cycle: false, pause: false };
    this.prevPadButtons = [];
    /** Seconds during which the pad may not take control back from a touchscreen. */
    this.claimCooldown = 0;

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

  /** Called when a finger touches the screen, so the pad cannot immediately take control back. */
  noteTouch() {
    this.claimCooldown = TOUCH_GRACE;
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
  pollPad(dt = 0) {
    this.claimCooldown = Math.max(0, this.claimCooldown - dt);

    // Some browsers only expose a pad after its first button press, without firing the event.
    if (!this.pad) {
      const found = firstConnectedPad();
      if (found) this.setPad(found);
    }
    const pad = livePad(this.pad);
    if (!pad) return null;
    // Adopt the browser's live object without resetting the edge-detection history.
    if (pad !== this.pad) {
      this.pad = pad;
      this.padName = pad.id || this.padName;
    }

    // A pad that reports disconnection without an event.
    if (!pad.connected) {
      this.setPad(null);
      return null;
    }

    const buttons = readButtons(pad);
    const axes = pad.axes || [];
    const move = deadStick(axes[0] || 0, axes[1] || 0);
    const look = deadStick(axes[2] || 0, axes[3] || 0);
    const fire = trigger(buttons, axes, 7, 5);
    const sprint = trigger(buttons, axes, 6, 4);

    // Take control back only on a deliberate input: a real stick push, a button, or a trigger past
    // its own threshold - and never in the moment right after the player touched the screen.
    if (this.active !== DEVICE.GAMEPAD && this.claimCooldown <= 0) {
      const deliberate =
        pressed(buttons, [0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 12, 13, 14, 15], 0.5) ||
        Math.hypot(move.x, move.y) > STICK_CLAIM ||
        Math.hypot(look.x, look.y) > STICK_CLAIM ||
        fire > TRIGGER_ON ||
        sprint > TRIGGER_ON;
      if (deliberate) this.setActive(DEVICE.GAMEPAD);
    }

    // Edge detection against the previous frame.
    const prev = this.prevPadButtons;
    const rising = (indices, threshold = 0.5) =>
      pressed(buttons, indices, threshold) && !pressed(prev, indices, threshold);
    if (rising(BUTTON.reload)) this.padActions.reload = true;
    if (rising(BUTTON.interact)) this.padActions.interact = true;
    if (rising(BUTTON.cycle)) this.padActions.cycle = true;
    if (rising(BUTTON.knife)) this.padActions.slot = 3;
    if (rising(BUTTON.prevGun)) this.padActions.slot = 1;
    if (rising(BUTTON.nextGun)) this.padActions.slot = 2;
    if (rising(BUTTON.pause)) this.padActions.pause = true;
    this.prevPadButtons = buttons;

    return {
      active: this.active === DEVICE.GAMEPAD,
      move: { x: move.x, z: -move.y },
      look: { x: look.x, y: look.y },
      jump: pressed(buttons, BUTTON.jump),
      fire: fire >= TRIGGER_ON,
      sprint: sprint >= TRIGGER_ON,
      slide: pressed(buttons, BUTTON.slide),
      scope: pressed(buttons, BUTTON.scope),
    };
  }

  /** Drain pad actions queued since the last call. */
  takePadActions() {
    const a = this.padActions;
    this.padActions = { reload: false, interact: false, slot: 0, cycle: false, pause: false };
    return a;
  }
}
