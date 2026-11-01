/**
 * Every tunable in the game lives here. The server imports this directly; the browser gets the parts
 * it needs (weapons, zone schedule) inside the `welcome` packet, so tuning happens in one place.
 */

export const TICK_RATE = 30;
export const SNAPSHOT_RATE = 20;
export const TICK_DT = 1 / TICK_RATE;

/** Arena is 160x160 world units, centred on the origin. */
export const ARENA_HALF = 80;
export const ARENA_WALL_HEIGHT = 8;

export const PLAYER = {
  radius: 0.45,
  height: 1.8,
  eye: 1.62,
  speed: 6.4,
  sprintSpeed: 9.0,
  groundAccel: 16,
  airAccel: 3.2,
  jumpSpeed: 7.4,
  gravity: 22,
  maxHp: 100,
  maxArmor: 50,
  /** Fraction of incoming damage that hits armor instead of health while armor remains. */
  armorAbsorb: 0.6,
  spawnShield: 3,
  respawnSlotDelay: 0.35,
};

/**
 * Weapon table.
 *  dmg      damage per pellet
 *  pellets  projectiles per trigger pull
 *  spread   cone half-angle in degrees
 *  rpm      rounds per minute
 *  mag      magazine size
 *  reload   seconds
 *  range    metres before the ray stops
 *  head     headshot damage multiplier
 *  reserve  starting reserve ammo when picked up
 *  pickup   reserve ammo granted by an ammo crate
 */
export const WEAPONS = {
  pistol: {
    id: 'pistol',
    label: 'Pistol',
    dmg: 22,
    pellets: 1,
    spread: 0.9,
    rpm: 320,
    mag: 12,
    reload: 1.3,
    range: 70,
    head: 2,
    reserve: 36,
    pickup: 24,
    color: '#ffd166',
  },
  smg: {
    id: 'smg',
    label: 'SMG',
    dmg: 11,
    pellets: 1,
    spread: 2.4,
    rpm: 800,
    mag: 32,
    reload: 1.8,
    range: 55,
    head: 1.8,
    reserve: 64,
    pickup: 40,
    color: '#7ae582',
  },
  shotgun: {
    id: 'shotgun',
    label: 'Shotgun',
    dmg: 11,
    pellets: 8,
    spread: 4.2,
    rpm: 80,
    mag: 6,
    reload: 2.4,
    range: 30,
    head: 1.5,
    reserve: 18,
    pickup: 12,
    color: '#ff8b6b',
  },
  rifle: {
    id: 'rifle',
    label: 'Rifle',
    dmg: 40,
    pellets: 1,
    spread: 0.45,
    rpm: 130,
    mag: 10,
    reload: 2.1,
    range: 120,
    head: 2.2,
    reserve: 20,
    pickup: 16,
    color: '#8ecae6',
  },
};

export const WEAPON_IDS = Object.keys(WEAPONS);

export const ITEMS = {
  medkit: { id: 'medkit', label: 'Medkit', heal: 40, color: '#ff5d8f' },
  armor: { id: 'armor', label: 'Armor plate', armor: 25, color: '#8ecae6' },
  ammo: { id: 'ammo', label: 'Ammo', color: '#ffd166' },
};

/**
 * Zone schedule. Start radius is ZONE_START_RADIUS; each entry closes the ring to `radius`
 * after `hold` seconds, taking `close` seconds, and then deals `dps` outside it.
 */
export const ZONE_START_RADIUS = 78;
export const ZONE_PHASES = [
  { hold: 28, close: 12, radius: 55, dps: 1 },
  { hold: 22, close: 12, radius: 36, dps: 2 },
  { hold: 18, close: 11, radius: 20, dps: 4 },
  { hold: 14, close: 10, radius: 10, dps: 7 },
  { hold: 12, close: 10, radius: 4, dps: 10 },
];

export const MATCH = {
  countdown: 5,
  overDuration: 6,
  minPlayers: 10,
  maxPlayers: 16,
  lootCount: 70,
  pickupRadius: 2.5,
  spawnMinDistance: 18,
  /** A bot is added to top the lobby up to this many players. */
  botsToFill: 10,
};

export const PLAYER_COLORS = [
  '#ff6b6b',
  '#4ecdc4',
  '#ffe66d',
  '#a78bfa',
  '#f97316',
  '#22d3ee',
  '#f472b6',
  '#a3e635',
  '#fb7185',
  '#38bdf8',
  '#fbbf24',
  '#c084fc',
];

export const BOT_NAMES = [
  'Rook', 'Vex', 'Kilo', 'Nova', 'Juno', 'Sable', 'Havoc', 'Wisp',
  'Torque', 'Onyx', 'Flint', 'Zephyr', 'Cinder', 'Echo', 'Bramble', 'Ripley',
];

export const SIM = {
  /** Bot think interval in seconds (staggered per bot). */
  botThink: 0.12,
  /** Bots only spot what is roughly in front of them, so flanks and cover actually work. */
  botFov: Math.PI * 0.62,
  /** Inside this radius a bot hears you regardless of facing. */
  botHearing: 9,
  botViewRange: 55,
  /** Base aim error in radians, scaled up with range and how fast the target is moving. */
  botAimError: 0.075,
  botReaction: 0.55,
  /** Burst discipline: bots fire in short bursts instead of holding the trigger forever. */
  botBurstShots: 4,
  botBurstPause: 0.55,
  /**
   * Multiplies a bot's shot cone. This is the single biggest difficulty dial: 1 would make bots
   * laser-accurate at range, higher values make their fire progressively less punishing.
   */
  botSpreadPenalty: 7,
};
