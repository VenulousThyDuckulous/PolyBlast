/**
 * Client bootstrap and frame loop.
 *
 * Responsibilities: own the connection lifecycle, translate network state into an interpolated view
 * for the renderer, pace input packets at the sim tick rate, and turn game events into effects.
 */

import { Renderer } from './render.js';
import { Input } from './input.js';
import { Net } from './net.js';
import { Hud } from './hud.js';
import { Sfx } from './sfx.js';
import { DEVICE } from './devices.js';
import { AvatarEditor } from './editor.js';

const canvas = document.getElementById('scene');
const renderer = new Renderer(canvas);
const input = new Input(canvas);
const net = new Net();
const hud = new Hud();
const sfx = new Sfx();
const editor = new AvatarEditor();

const lobby = document.getElementById('lobby');
const joinForm = document.getElementById('join-form');
const nameInput = document.getElementById('name-input');
const playBtn = document.getElementById('play-btn');
const lobbyError = document.getElementById('lobby-error');
const paused = document.getElementById('paused');
const scopeEl = document.getElementById('scope');
const resumeBtn = document.getElementById('resume-btn');
const connectError = document.getElementById('connect-error');
const connectErrorText = document.getElementById('connect-error-text');
const reloadBtn = document.getElementById('reload-btn');
const deviceName = document.getElementById('device-name');
const sensitivityInput = document.getElementById('sensitivity-input');
const sensitivityValue = document.getElementById('sensitivity-value');
const deviceHint = document.getElementById('device-hint');
const promptKey = document.getElementById('prompt-key');
const legends = {
  [DEVICE.KEYBOARD]: document.getElementById('controls-kbm'),
  [DEVICE.GAMEPAD]: document.getElementById('controls-pad'),
  [DEVICE.TOUCH]: document.getElementById('controls-touch'),
};

const INPUT_INTERVAL = 1 / 30;
const SELF_SMOOTHING = 16;
const SNAP_DISTANCE = 8;

let config = null;
let phase = 'menu'; // menu | playing
let latestState = null;
let self = { x: 0, y: 0, z: 0, initialized: false };
let inputAccumulator = 0;
let seq = 0;
let stepTimer = 0;
let countdownBeep = 99;
let lastAlive = true;
let lastStamina = 100;

nameInput.value = localStorage.getItem('polyblast-name') || localStorage.getItem('lastcircle-name') || '';

// ------------------------------------------------------------------ connection

joinForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = nameInput.value.trim() || `Player ${Math.floor(Math.random() * 900 + 100)}`;
  nameInput.value = name;
  localStorage.setItem('polyblast-name', name);

  sfx.init();
  playBtn.disabled = true;
  playBtn.textContent = 'Connecting';
  lobbyError.textContent = '';

  try {
    const welcome = await net.connect(name, editor.avatar);
    config = welcome.config;
    hud.setSelfId(welcome.id);
    net.push(welcome.state);
    renderer.setWorld(welcome.world);
    latestState = welcome.state;

    const me = welcome.state.players.find((p) => p.id === welcome.id);
    if (me) {
      self.x = me.x;
      self.y = me.y;
      self.z = me.z;
      self.initialized = true;
      input.yaw = me.yaw;
      input.pitch = me.pitch || 0;
    }

    phase = 'playing';
    input.enabled = true;
    hud.show();
    lobby.classList.add('hidden');
    connectError.classList.add('hidden');
    applyDeviceUi(input.devices.active);
    // Pointer lock is a desktop mouse thing; on touch or a pad it would only trap the pointer.
    if (input.devices.active === DEVICE.KEYBOARD) input.requestLock();
    hud.banner(
      net.offline
        ? 'Offline match · you and 9 bots'
        : 'Lobby up · the match starts in a few seconds',
      3200,
    );
  } catch (err) {
    lobbyError.textContent = err.message || 'Could not connect';
    playBtn.disabled = false;
    playBtn.textContent = 'Drop in';
  }
});

net.onWorld = (world) => {
  renderer.setWorld(world);
};

net.onEvents = (events) => handleEvents(events);

net.onClose = () => {
  if (phase === 'menu') return;
  phase = 'menu';
  input.exitLock();
  connectError.classList.remove('hidden');
  connectErrorText.textContent = 'The server went away. Reload to drop back in.';
  document.body.classList.remove('scoped');
  scopeEl?.classList.add('hidden');
  wasScoped = false;
};

reloadBtn.addEventListener('click', () => location.reload());

// ------------------------------------------------------------------ sensitivity

/** Show the stored look multiplier and keep the slider and the game in step. */
function applySensitivity(value, { persist = false } = {}) {
  const applied = input.setSensitivity(value, { persist });
  if (sensitivityInput) sensitivityInput.value = String(applied);
  if (sensitivityValue) sensitivityValue.textContent = `${applied.toFixed(2)}×`;
}

applySensitivity(input.sensitivity);
sensitivityInput?.addEventListener('input', () =>
  applySensitivity(Number(sensitivityInput.value), { persist: true }),
);

// ------------------------------------------------------------------ pointer lock / pause

/** True while the local player still has a body in the match. */
function selfAlive() {
  return !!net.you?.alive;
}

input.onLockChange = (locked) => {
  // Only the desktop cursor can be locked; on touch/pad the pause overlay is driven explicitly.
  if (phase !== 'playing' || input.devices.platform === 'mobile') return;
  if (input.devices.active !== DEVICE.KEYBOARD) return;
  // A spectator has nothing to pause, and the overlay would cover the death screen.
  if (!selfAlive()) {
    paused.classList.add('hidden');
    return;
  }
  paused.classList.toggle('hidden', locked);
};

function resume() {
  paused.classList.add('hidden');
  input.requestLock();
}

function togglePause() {
  if (phase !== 'playing' || !selfAlive()) return;
  if (paused.classList.contains('hidden')) {
    paused.classList.remove('hidden');
    input.exitLock();
    input.clear();
  } else {
    resume();
  }
}

input.onAction = (action) => {
  if (action === 'escape' || action === 'pause') togglePause();
};

resumeBtn.addEventListener('click', resume);

canvas.addEventListener('mousedown', () => {
  if (phase === 'playing' && !input.locked && input.devices.active === DEVICE.KEYBOARD) input.requestLock();
});

// ------------------------------------------------------------------ devices

/** Reflect whichever device is driving in the lobby, the legends and the HUD hints. */
function applyDeviceUi(device) {
  const devices = input.devices;
  if (deviceName) deviceName.textContent = devices.describe();
  if (deviceHint) {
    if (device !== DEVICE.GAMEPAD && devices.hasGamepad) deviceHint.textContent = '· press a button to use the controller';
    else if (device === DEVICE.GAMEPAD && devices.platform === 'mobile') deviceHint.textContent = '· touch to use the screen';
    else deviceHint.textContent = '';
  }
  document.body.classList.toggle('touch-on', device === DEVICE.TOUCH && devices.platform === 'mobile');

  for (const [name, el] of Object.entries(legends)) {
    if (el) el.classList.toggle('hidden', name !== device);
  }

  if (promptKey) {
    promptKey.textContent = device === DEVICE.GAMEPAD ? 'Y' : 'E';
    promptKey.classList.toggle('hidden', device === DEVICE.TOUCH);
  }
}

input.onDeviceChange = (device) => {
  applyDeviceUi(device);
  if (phase !== 'playing') return;
  if (device === DEVICE.GAMEPAD) hud.toast('Controller connected');
  else if (device === DEVICE.TOUCH) hud.toast('Touch controls');
};

applyDeviceUi(input.devices.active);

// ------------------------------------------------------------------ events -> effects

function handleEvents(events) {
  for (const e of events) {
    switch (e.type) {
      case 'shot': {
        const dist = Math.hypot(e.sx - self.x, e.sy - (self.y + 1.6), e.sz - self.z);
        sfx.shoot(e.w, dist);
        if (e.by === net.id) renderer.kick();
        renderer.addTracer(
          { x: e.sx, y: e.sy, z: e.sz },
          { x: e.ex, y: e.ey, z: e.ez },
          e.by === net.id ? 0xfff0c0 : 0xffb070,
        );
        if (e.hit) renderer.addSpark(e.ex, e.ey, e.ez, e.by === net.id ? 0xffd166 : 0xff8b6b);
        break;
      }
      case 'hit': {
        if (e.by === net.id) {
          hud.hitmarker(false);
          sfx.hit(!!e.head);
        }
        if (e.id === net.id) {
          hud.hurt();
          renderer.addShake(0.45);
          sfx.hurt();
        }
        renderer.addSpark(e.x, e.y, e.z, e.head ? 0xff7b7b : 0xffd9a0);
        break;
      }
      case 'kill': {
        hud.addKill(e);
        if (e.killer === net.id) {
          hud.hitmarker(true);
          hud.banner(`Eliminated ${e.vname}`, 1600);
          sfx.kill();
        }
        if (e.victim === net.id) sfx.death();
        break;
      }
      case 'pickup':
        if (e.id === net.id) {
          hud.toast(e.label);
          sfx.pickup();
        }
        break;
      case 'deny':
        if (e.id === net.id) {
          hud.toast(e.reason);
          sfx.deny();
        }
        break;
      case 'slide': {
        sfx.slide(Math.hypot(e.x - self.x, e.z - self.z));
        if (e.id === net.id) renderer.addShake(0.1);
        break;
      }
      case 'melee': {
        const mine = e.id === net.id;
        const dist = Math.hypot(e.sx - self.x, e.sz - self.z);
        sfx.swing(dist, mine);
        if (mine) renderer.swingKnife();
        renderer.addTracer(
          { x: e.sx, y: e.sy, z: e.sz },
          { x: e.ex, y: e.ey, z: e.ez },
          mine ? 0xf2f7ff : 0xc9d6e6,
          0.05,
        );
        if (e.hit) renderer.addSpark(e.ex, e.ey, e.ez, 0xffe6a0);
        break;
      }
      case 'finisher': {
        if (e.by === net.id) {
          // The HUD owns the flash; the camera just takes the hit of the motion.
          hud.finisher(e.vname);
          sfx.finisher();
          renderer.addShake(0.55);
        } else if (e.id === net.id) {
          sfx.death();
        }
        break;
      }
      case 'zoneClose':
        sfx.zoneWarn();
        hud.banner('The circle is closing', 2000);
        break;
      case 'live':
        sfx.countdown(true);
        hud.banner('Drop! Find a gun', 2000);
        hud.hideDeath();
        hud.hideResults();
        break;
      case 'countdown':
        hud.clearFeed();
        break;
      case 'matchReset':
        hud.clearFeed();
        hud.hideResults();
        hud.hideDeath();
        hud.banner('New match · fresh map', 2400);
        break;
      default:
        break;
    }
  }
}

// ------------------------------------------------------------------ view assembly

function nearestLootLabel(state, me) {
  if (!me?.al) return null;
  const radius = config.match.pickupRadius;
  let best = null;
  let bestD = radius * radius;
  for (const item of state.loot) {
    const d = (item.x - me.x) ** 2 + (item.z - me.z) ** 2;
    if (d < bestD) {
      bestD = d;
      best = item;
    }
  }
  if (!best) return null;
  if (best.k === 'weapon') return `Pick up ${config.weapons[best.w]?.label || 'weapon'}`;
  if (best.k === 'medkit') return 'Use medkit (+40 HP)';
  if (best.k === 'armor') return 'Equip armor plate';
  return 'Take ammo';
}

function buildView(dt) {
  const state = latestState;
  const you = net.you;

  // Own position: draw from the authoritative snapshot, eased so corrections are invisible.
  const authoritative = state.players.find((p) => p.id === net.id);
  if (authoritative) {
    const dist = Math.hypot(authoritative.x - self.x, authoritative.y - self.y, authoritative.z - self.z);
    if (!self.initialized || dist > SNAP_DISTANCE) {
      self.x = authoritative.x;
      self.y = authoritative.y;
      self.z = authoritative.z;
      self.initialized = true;
    } else {
      const k = 1 - Math.exp(-SELF_SMOOTHING * dt);
      self.x += (authoritative.x - self.x) * k;
      self.y += (authoritative.y - self.y) * k;
      self.z += (authoritative.z - self.z) * k;
    }
  }

  const players = state.players.map((p) => {
    if (p.id === net.id) {
      return { ...p, x: self.x, y: self.y, z: self.z, yaw: input.yaw, pitch: input.pitch };
    }
    const s = net.sample(p.id);
    return s ? { ...p, x: s.x, y: s.y, z: s.z, yaw: s.yaw, pitch: s.pitch } : p;
  });

  const meEntry = players.find((p) => p.id === net.id);
  const alive = you ? you.alive : false;

  return {
    config,
    you,
    me: {
      id: net.id,
      x: self.x,
      y: self.y,
      z: self.z,
      yaw: input.yaw,
      pitch: input.pitch,
      alive: alive && !!meEntry?.al,
      weapon: you?.held || null,
      melee: !!you?.melee,
      sliding: !!you?.sliding,
      sprinting: !!you?.sprinting,
      stamina: you?.stamina ?? 100,
      staminaMax: you?.staminaMax ?? 100,
      slideReady: !you?.sliding && (you?.slideCd ?? 0) <= 0,
      scoped: !!you?.scoped,
    },
    players,
    loot: state.loot,
    zone: state.zone,
    phase: state.phase,
    alive: state.alive,
    countdown: state.timer,
    winner: state.winner,
    arenaHalf: config.arenaHalf,
    spectateId: you?.killerId ?? null,
    nearbyLoot: alive ? nearestLootLabel(state, meEntry) : null,
    finisher: alive ? finisherTarget(state, you) : null,
  };
}

/**
 * Client-side guess at whether a takedown is available, for the HUD prompt only. The server has the
 * final say (it also knows things like "are they tracking me"), so the prompt is anticipation, not
 * the mechanic.
 */
function finisherTarget(state, you) {
  if (!you?.alive || !you?.melee || !config?.melee) return null;
  const range = config.melee.finisherRange;
  const rearDot = config.melee.finisherRearDot;
  let best = null;
  let bestD = range;
  for (const p of state.players) {
    if (p.id === net.id || !p.al || p.sh) continue;
    const dx = self.x - p.x;
    const dz = self.z - p.z;
    const d = Math.hypot(dx, dz);
    if (d > bestD || d < 0.001) continue;
    const fx = -Math.sin(p.yaw);
    const fz = -Math.cos(p.yaw);
    if ((dx / d) * fx + (dz / d) * fz > rearDot) continue;
    bestD = d;
    best = p.n;
  }
  return best;
}

// ------------------------------------------------------------------ input

let wasScoped = false;

/**
 * Drive the lens overlay, the zoomed look sensitivity and the crosshair. Nothing here changes the
 * rules: the server decides whether the optic may come up at all.
 */
function applyScope(view) {
  const scoped = !!view.me.scoped;
  scopeEl?.classList.toggle('hidden', !scoped);
  if (scoped !== wasScoped) {
    wasScoped = scoped;
    document.body.classList.toggle('scoped', scoped);
    sfx.scope(scoped);
  }
  if (!scoped) {
    input.lookScale = 1;
    return;
  }
  const fov = config?.weapons?.[view.me.weapon]?.scopeFov ?? 30;
  // Zooming magnifies every mouse count, so scale look input by the field-of-view ratio.
  const ratio = Math.tan((fov * Math.PI) / 360) / Math.tan((78 * Math.PI) / 360);
  input.lookScale = Math.max(0.22, Math.min(1, ratio));
}

/** Next non-empty weapon slot (1-based), for the controller's single cycle button. */
function nextSlot() {
  const you = net.you;
  if (!you?.slots) return 0;
  for (let i = 1; i <= you.slots.length; i++) {
    const index = (you.slot + i) % you.slots.length;
    if (you.slots[index]) return index + 1;
  }
  return 0;
}

function sendInput(dt) {
  inputAccumulator += dt;
  let guard = 0;
  while (inputAccumulator >= INPUT_INTERVAL && guard < 4) {
    inputAccumulator -= INPUT_INTERVAL;
    guard++;
    const axes = input.axes();
    const actions = input.consumeActions();
    // Movement must not depend on pointer lock: some browsers refuse it, and the player would be
    // frozen in place. Only the pause overlay suspends control.
    const active = phase === 'playing' && paused.classList.contains('hidden');
    net.send({
      seq: ++seq,
      yaw: input.yaw,
      pitch: input.pitch,
      mx: active ? axes.x : 0,
      mz: active ? axes.z : 0,
      sprint: active && input.isSprinting(),
      jump: active && input.isJumping(),
      fire: active && input.fire,
      scope: active && input.scope,
      slide: active && input.slide,
      reload: actions.reload,
      interact: actions.interact,
      slot: actions.slot || nextSlot(),
    });
  }
}

// ------------------------------------------------------------------ frame

let lastNow = performance.now();

function frame(now) {
  const dt = Math.min(0.05, Math.max(0.0005, (now - lastNow) / 1000));
  lastNow = now;

  net.advance(dt);
  // Device arbitration and stick/touch sampling must happen every frame, lobby included.
  input.update(dt);

  if (latestState && config) {
    sendInput(dt);
    const view = buildView(dt);
    applyScope(view);
    renderer.update(view, dt);
    hud.update(view, dt);
    updateAmbient(view, dt);
    // Dying while paused (or losing pointer lock mid-death) must not leave the overlay up.
    if (!view.me.alive && !paused.classList.contains('hidden')) paused.classList.add('hidden');
  }

  renderer.render();
  requestAnimationFrame(frame);
}

function updateAmbient(view, dt) {
  // Countdown ticks.
  if (view.phase === 'countdown') {
    const n = Math.max(1, Math.ceil(view.countdown));
    if (n !== countdownBeep) {
      countdownBeep = n;
      if (n <= 5) sfx.countdown(false);
    }
  } else {
    countdownBeep = 99;
  }

  // Footsteps while moving on the ground, faster and heavier while sprinting.
  if (view.me.alive && phase === 'playing') {
    const axes = input.axes();
    const moving = Math.hypot(axes.x, axes.z) > 0.1;
    const sprinting = !!view.me.sprinting;
    if (moving || view.me.sliding) {
      stepTimer -= dt;
      if (stepTimer <= 0) {
        if (view.me.sliding) {
          // The slide sound itself covers the scrape; no footsteps on top of it.
          stepTimer = 0.3;
        } else if (sprinting) {
          sfx.sprintStep();
          stepTimer = 0.3;
        } else {
          sfx.step();
          stepTimer = 0.44;
        }
      }
    } else {
      stepTimer = 0;
    }

    // Emptying the bar is a real event for the player, so it gets a sound.
    if (lastStamina > 0 && view.me.stamina <= 0) sfx.exhausted();
    lastStamina = view.me.stamina;
  }

  if (view.you && view.you.alive !== lastAlive) {
    lastAlive = view.you.alive;
    if (!lastAlive) hud.banner('Eliminated', 1600);
  }
}

function resize() {
  renderer.resize(window.innerWidth, window.innerHeight);
}

window.addEventListener('resize', resize);
resize();

net.onState = (state) => {
  latestState = state;
};

// TEMP-DEBUG: inspect live state from the browser console during development.
window.__lc = {
  net,
  renderer,
  input,
  hud,
  editor,
  devices: input.devices,
  touch: input.touch,
  get state() {
    return latestState;
  },
  get self() {
    return { ...self };
  },
};

requestAnimationFrame(frame);
