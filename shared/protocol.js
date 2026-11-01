/**
 * Shared protocol constants and tiny helpers used by both the server and the browser client.
 * This file must stay dependency-free so it can be imported from either side.
 */

export const MSG = {
  JOIN: 'join',
  INPUT: 'input',
  WELCOME: 'welcome',
  STATE: 'state',
};

export const PHASE = {
  LOBBY: 'lobby',
  COUNTDOWN: 'countdown',
  LIVE: 'live',
  OVER: 'over',
};

/** Two gun slots plus a permanent melee slot that always holds the knife. */
export const SLOTS = 3;
export const MELEE_SLOT = 2;
export const GUN_SLOTS = 2;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const clamp01 = (v) => clamp(v, 0, 1);

/** Shortest signed angle difference between two radians, in (-PI, PI]. */
export function angleDelta(from, to) {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Convert an aim pair into a unit direction vector (three.js convention: yaw 0 faces -Z). */
export function aimDir(yaw, pitch) {
  const cp = Math.cos(pitch);
  return {
    x: -Math.sin(yaw) * cp,
    y: Math.sin(pitch),
    z: -Math.cos(yaw) * cp,
  };
}

/** True when the payload looks like a sane input packet. */
export function sanitizeInput(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  const mx = clamp(num(raw.mx, 0), -1, 1);
  const mz = clamp(num(raw.mz, 0), -1, 1);
  return {
    seq: num(raw.seq, 0) | 0,
    yaw: clamp(num(raw.yaw, 0), -Math.PI * 4, Math.PI * 4),
    pitch: clamp(num(raw.pitch, 0), -Math.PI, Math.PI),
    mx,
    mz,
    sprint: !!raw.sprint,
    jump: !!raw.jump,
    fire: !!raw.fire,
    /** Held, not edge-triggered: the sim decides when a slide may actually start. */
    slide: !!raw.slide,
    reload: !!raw.reload,
    interact: !!raw.interact,
    slot: raw.slot === 1 ? 1 : raw.slot === 2 ? 2 : raw.slot === 3 ? 3 : 0,
  };
}
