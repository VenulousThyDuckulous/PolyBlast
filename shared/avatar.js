/**
 * Avatar model shared by the server and the client.
 *
 * An avatar is three small integers - body colour, accent colour, hat - which keeps snapshots tiny
 * while still giving every player a recognisable silhouette. The server validates whatever it is
 * sent through `sanitizeAvatar`, so a hand-crafted join packet can only ever pick from these lists.
 */

export const BODY_COLORS = [
  { hex: '#ff6b6b', label: 'Crimson' },
  { hex: '#4ecdc4', label: 'Teal' },
  { hex: '#ffe066', label: 'Sunflower' },
  { hex: '#a78bfa', label: 'Violet' },
  { hex: '#f97316', label: 'Ember' },
  { hex: '#22d3ee', label: 'Cyan' },
  { hex: '#f472b6', label: 'Rose' },
  { hex: '#a3e635', label: 'Lime' },
  { hex: '#e2e8f0', label: 'Bone' },
  { hex: '#94a3b8', label: 'Steel' },
];

export const ACCENT_COLORS = [
  { hex: '#0d1420', label: 'Ink' },
  { hex: '#f8fafc', label: 'White' },
  { hex: '#ffd166', label: 'Gold' },
  { hex: '#58c7ff', label: 'Ice' },
  { hex: '#ff5d6c', label: 'Signal' },
  { hex: '#7ae582', label: 'Acid' },
];

export const HATS = [
  { id: 'none', label: 'None' },
  { id: 'cap', label: 'Cap' },
  { id: 'helmet', label: 'Helmet' },
  { id: 'horns', label: 'Horns' },
  { id: 'halo', label: 'Halo' },
  { id: 'antenna', label: 'Antenna' },
];

export const DEFAULT_AVATAR = { color: 0, accent: 0, hat: 0 };

const pick = (value, length) => (Number.isInteger(value) && value >= 0 && value < length ? value : 0);

/** Coerce anything into a valid avatar. Never throws, always returns in-range indices. */
export function sanitizeAvatar(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  return {
    color: pick(o.color, BODY_COLORS.length),
    accent: pick(o.accent, ACCENT_COLORS.length),
    hat: pick(o.hat, HATS.length),
  };
}

/** A random avatar, used for bots so the lobby is full of different silhouettes. */
export function randomAvatar(rand = Math.random) {
  return {
    color: Math.floor(rand() * BODY_COLORS.length),
    accent: Math.floor(rand() * ACCENT_COLORS.length),
    hat: Math.floor(rand() * HATS.length),
  };
}

/** Resolve an avatar into the hex/id values the renderer wants. */
export function avatarLook(avatar) {
  const a = sanitizeAvatar(avatar);
  return {
    body: BODY_COLORS[a.color].hex,
    accent: ACCENT_COLORS[a.accent].hex,
    hat: HATS[a.hat].id,
  };
}

/** Snapshot fields are short: c = body hex, ac = accent hex, h = hat index. */
export function avatarFromSnapshot(p) {
  return { body: p.c, accent: p.ac || ACCENT_COLORS[0].hex, hat: HATS[p.h || 0]?.id || 'none' };
}
