/**
 * Procedural audio. Everything is synthesised with WebAudio, so the game ships with no sound files.
 * The context is only created after a user gesture, which browsers require.
 */

export class Sfx {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.noiseBuffer = null;
    this.muted = false;
  }

  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.34;
    this.master.connect(this.ctx.destination);

    // One second of white noise, reused by every percussive sound.
    const len = Math.floor(this.ctx.sampleRate * 1);
    this.noiseBuffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  }

  now() {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  noise({ duration = 0.1, gain = 0.5, type = 'lowpass', freq = 1400, q = 0.8, decay = 0.08 } = {}) {
    if (!this.ctx || this.muted) return;
    const t = this.now();
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    src.connect(filter).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + duration + 0.02);
  }

  tone({ freq = 440, endFreq = null, duration = 0.12, gain = 0.2, type = 'sine', delay = 0 } = {}) {
    if (!this.ctx || this.muted) return;
    const t = this.now() + delay;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (endFreq) osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), t + duration);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + duration + 0.02);
  }

  shoot(kind, distance = 0) {
    // A sniper is heard across the arena; everything else is a much shorter, more local crack.
    const reach = kind === 'sniper' ? 160 : 70;
    if (distance > reach) return;
    const falloff = Math.max(0.06, 1 - distance / (reach * 1.07));
    switch (kind) {
      case 'smg':
        this.noise({ gain: 0.45 * falloff, freq: 2600, decay: 0.05 });
        this.tone({ freq: 220, endFreq: 90, duration: 0.06, gain: 0.12 * falloff, type: 'square' });
        break;
      case 'shotgun':
        this.noise({ gain: 0.85 * falloff, freq: 900, decay: 0.16 });
        this.tone({ freq: 120, endFreq: 45, duration: 0.16, gain: 0.3 * falloff, type: 'sine' });
        break;
      case 'rifle':
        this.noise({ gain: 0.7 * falloff, freq: 1500, decay: 0.12 });
        this.tone({ freq: 150, endFreq: 55, duration: 0.14, gain: 0.25 * falloff, type: 'sawtooth' });
        break;
      case 'sniper':
        // Deeper and much longer, with a tail that reads as an echo off the arena wall.
        this.noise({ gain: 0.9 * falloff, freq: 1150, decay: 0.24 });
        this.tone({ freq: 105, endFreq: 38, duration: 0.3, gain: 0.28 * falloff, type: 'sawtooth' });
        this.noise({ gain: 0.16 * falloff, freq: 600, decay: 0.5, duration: 0.55 });
        break;
      default:
        this.noise({ gain: 0.5 * falloff, freq: 1900, decay: 0.075 });
        this.tone({ freq: 260, endFreq: 100, duration: 0.08, gain: 0.16 * falloff, type: 'square' });
    }
  }

  hit(head = false) {
    this.tone({ freq: head ? 1500 : 1050, endFreq: head ? 1100 : 800, duration: 0.06, gain: 0.16, type: 'triangle' });
  }

  hurt() {
    this.noise({ gain: 0.35, freq: 500, decay: 0.16 });
    this.tone({ freq: 160, endFreq: 70, duration: 0.2, gain: 0.18, type: 'sine' });
  }

  kill() {
    this.tone({ freq: 880, duration: 0.09, gain: 0.2, type: 'triangle' });
    this.tone({ freq: 1320, duration: 0.14, gain: 0.16, type: 'triangle', delay: 0.07 });
  }

  pickup() {
    this.tone({ freq: 620, endFreq: 980, duration: 0.1, gain: 0.14, type: 'sine' });
  }

  reload() {
    this.noise({ gain: 0.16, freq: 3600, type: 'highpass', decay: 0.05, duration: 0.06 });
  }

  deny() {
    this.tone({ freq: 200, endFreq: 150, duration: 0.1, gain: 0.12, type: 'square' });
  }

  zoneWarn() {
    this.tone({ freq: 320, endFreq: 240, duration: 0.3, gain: 0.12, type: 'sawtooth' });
  }

  countdown(go = false) {
    if (go) {
      this.tone({ freq: 880, duration: 0.3, gain: 0.2, type: 'triangle' });
      this.tone({ freq: 1320, duration: 0.34, gain: 0.14, type: 'triangle', delay: 0.02 });
    } else {
      this.tone({ freq: 440, duration: 0.1, gain: 0.14, type: 'sine' });
    }
  }

  death() {
    this.tone({ freq: 300, endFreq: 60, duration: 0.8, gain: 0.24, type: 'sawtooth' });
    this.noise({ gain: 0.4, freq: 700, decay: 0.5, duration: 0.6 });
  }

  step() {
    this.noise({ gain: 0.06, freq: 900, type: 'lowpass', decay: 0.05, duration: 0.06 });
  }

  /** Sprint footsteps: heavier and faster than a walk, so sprinting sounds committed. */
  sprintStep() {
    this.noise({ gain: 0.085, freq: 1150, type: 'lowpass', decay: 0.055, duration: 0.07 });
  }

  /** A slide: one scrape of boots on ground, fading with distance. */
  slide(distance = 0) {
    if (distance > 46) return;
    const falloff = Math.max(0.1, 1 - distance / 50);
    this.noise({ gain: 0.26 * falloff, freq: 1250, type: 'lowpass', decay: 0.26, duration: 0.3 });
    this.tone({ freq: 150, endFreq: 70, duration: 0.22, gain: 0.07 * falloff, type: 'sine' });
  }

  /** Knife whoosh. Your own swing is louder than someone else's. */
  swing(distance = 0, own = false) {
    if (!own && distance > 38) return;
    const falloff = own ? 1 : Math.max(0.12, 1 - distance / 42);
    this.noise({ gain: 0.18 * falloff, freq: 2900, type: 'highpass', decay: 0.08, duration: 0.09 });
    if (own) this.tone({ freq: 380, endFreq: 620, duration: 0.07, gain: 0.05, type: 'triangle' });
  }

  /** Raising or lowering the optic: a small mechanical click, not a UI beep. */
  scope(open = true) {
    this.tone({
      freq: open ? 520 : 430,
      endFreq: open ? 780 : 320,
      duration: 0.05,
      gain: 0.05,
      type: 'triangle',
    });
    this.noise({ gain: 0.05, freq: 4200, type: 'highpass', decay: 0.03, duration: 0.04 });
  }

  /** Stamina ran out: a short, dry breath rather than a UI beep. */
  exhausted() {
    this.noise({ gain: 0.12, freq: 620, type: 'lowpass', decay: 0.2, duration: 0.22 });
    this.tone({ freq: 210, endFreq: 140, duration: 0.16, gain: 0.06, type: 'sine' });
  }

  /** The takedown sting: a low hit and a rising two-note sparkle. */
  finisher() {
    this.tone({ freq: 190, endFreq: 85, duration: 0.16, gain: 0.22, type: 'sawtooth' });
    this.noise({ gain: 0.2, freq: 800, decay: 0.16, duration: 0.18 });
    this.tone({ freq: 620, duration: 0.12, gain: 0.14, type: 'triangle', delay: 0.07 });
    this.tone({ freq: 930, duration: 0.18, gain: 0.12, type: 'triangle', delay: 0.16 });
  }
}
