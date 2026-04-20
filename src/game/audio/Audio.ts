/**
 * Lightweight Web Audio wrapper. No external audio files required for v1 —
 * all sounds are synthesized from oscillators and noise. Keeps the bundle
 * small and avoids IP concerns with sample licensing.
 */
/**
 * Diatonic pentatonic-ish ladder used for arrival chimes. Picking from a
 * fixed scale guarantees overlapping pings sound musical rather than dissonant.
 */
const FRIENDLY_LADDER = [
  523.25, // C5
  587.33, // D5
  659.25, // E5
  783.99, // G5
  880.0,  // A5
  1046.5, // C6
  1318.5, // E6
  1567.98, // G6
];

const ABSORB_LADDER = [
  329.63, // E4
  293.66, // D4
  261.63, // C4
  220.0,  // A3
  196.0,  // G3
];

export class Audio {
  private ctx: AudioContext | null = null;
  private musicGain: GainNode | null = null;
  private sfxGain: GainNode | null = null;
  private musicStarted = false;
  private lastLaunchAt = 0;
  /** Per-planet throttle so a flood of arrivals doesn't drown out the ambient. */
  private lastArriveAt = new Map<number, number>();
  private lastRingFillAt = 0;
  private lastRingTickAt = new Map<number, number>();
  private lastAbsorbAt = new Map<number, number>();
  private lastDeathAt = 0;
  private etherealTimer: number | null = null;
  muted = false;
  musicVolume = 0.35;
  sfxVolume = 0.45;

  init(): void {
    if (this.ctx) return;
    try {
      this.ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    } catch {
      return;
    }
    this.musicGain = this.ctx.createGain();
    this.musicGain.gain.value = this.musicVolume;
    this.musicGain.connect(this.ctx.destination);
    this.sfxGain = this.ctx.createGain();
    this.sfxGain.gain.value = this.sfxVolume;
    this.sfxGain.connect(this.ctx.destination);
  }

  /** Must be called from a user gesture (tap/click). */
  unlock(): void {
    if (!this.ctx) this.init();
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    if (!this.musicStarted && !this.muted) this.startAmbient();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.musicGain) this.musicGain.gain.value = muted ? 0 : this.musicVolume;
    if (this.sfxGain) this.sfxGain.gain.value = muted ? 0 : this.sfxVolume;
    if (muted && this.etherealTimer !== null) {
      clearTimeout(this.etherealTimer);
      this.etherealTimer = null;
    } else if (!muted && this.musicStarted && this.etherealTimer === null) {
      this.scheduleEthereal();
    }
  }

  private startAmbient(): void {
    if (!this.ctx || !this.musicGain) return;
    this.musicStarted = true;
    // Two slowly detuned sine pads an octave apart + a very slow LFO on filter.
    const baseFreqs = [110, 164.81, 246.94]; // A2, E3, B3 — open, calm
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 900;
    filter.Q.value = 0.8;
    filter.connect(this.musicGain);

    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = this.ctx.createGain();
    lfoGain.gain.value = 350;
    lfo.connect(lfoGain).connect(filter.frequency);
    lfo.start();

    for (const f of baseFreqs) {
      const osc1 = this.ctx.createOscillator();
      osc1.type = 'sine';
      osc1.frequency.value = f;
      const osc2 = this.ctx.createOscillator();
      osc2.type = 'sine';
      osc2.frequency.value = f * 1.003; // slight detune
      const voiceGain = this.ctx.createGain();
      voiceGain.gain.value = 0.12;
      osc1.connect(voiceGain);
      osc2.connect(voiceGain);
      voiceGain.connect(filter);
      osc1.start();
      osc2.start();
    }

    // Break up the otherwise-constant drone with sparse ethereal one-shots —
    // airy windy swells, distant chimes, subtle sweeps. Scheduled in JS-time
    // so they don't all stack in the audio graph up front.
    this.scheduleEthereal();
  }

  /**
   * Queue up the next sparse ambient one-shot. Variable gap (8..22s) so the
   * variance feels natural, never rhythmic. Reschedules itself forever.
   */
  private scheduleEthereal(): void {
    if (this.etherealTimer !== null) clearTimeout(this.etherealTimer);
    const delay = 8000 + Math.random() * 14000;
    this.etherealTimer = window.setTimeout(() => {
      this.etherealTimer = null;
      if (!this.muted) this.playEthereal();
      this.scheduleEthereal();
    }, delay);
  }

  /**
   * Pick one of a handful of soft space-y textures. All are filtered and quiet
   * enough to sit well under the drone — no lasers, no robot blips.
   */
  private playEthereal(): void {
    if (!this.ctx || !this.musicGain) return;
    const pick = Math.floor(Math.random() * 4);
    if (pick === 0) this.etherealWindSwell();
    else if (pick === 1) this.etherealDistantChime();
    else if (pick === 2) this.etherealDeepSweep();
    else this.etherealShimmer();
  }

  /** Long, breathy filtered-noise swell — reads as solar wind / space air. */
  private etherealWindSwell(): void {
    if (!this.ctx || !this.musicGain) return;
    const now = this.ctx.currentTime;
    const dur = 4 + Math.random() * 3;
    const sr = this.ctx.sampleRate;
    const sampleCount = Math.max(1, Math.floor(sr * dur));
    const buf = this.ctx.createBuffer(1, sampleCount, sr);
    const data = buf.getChannelData(0);
    for (let i = 0; i < sampleCount; i++) data[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'bandpass';
    lp.Q.value = 0.6;
    const centerStart = 260 + Math.random() * 200;
    const centerEnd = centerStart + (Math.random() - 0.5) * 200;
    lp.frequency.setValueAtTime(centerStart, now);
    lp.frequency.linearRampToValueAtTime(centerEnd, now + dur);
    const g = this.ctx.createGain();
    const peak = 0.055 + Math.random() * 0.025;
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(peak, now + dur * 0.4);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    src.connect(lp).connect(g).connect(this.musicGain);
    src.start(now);
    src.stop(now + dur + 0.05);
  }

  /** Lone distant bell that fades in slowly, like a ping from far away. */
  private etherealDistantChime(): void {
    if (!this.ctx || !this.musicGain) return;
    const now = this.ctx.currentTime;
    // Pentatonic note up high so it sits above the pad harmonically.
    const roots = [392.0, 440.0, 523.25, 587.33, 659.25]; // G4 A4 C5 D5 E5
    const f = roots[Math.floor(Math.random() * roots.length)];
    const partials = [f, f * 2.01, f * 3.02];
    const gains = [0.045, 0.022, 0.012];
    const dur = 4.5;
    for (let i = 0; i < partials.length; i++) {
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = partials[i];
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(gains[i], now + 1.2);
      g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
      osc.connect(g).connect(this.musicGain);
      osc.start(now);
      osc.stop(now + dur + 0.05);
    }
  }

  /** Slow sub-bass sine sweep — feels like something vast passing by. */
  private etherealDeepSweep(): void {
    if (!this.ctx || !this.musicGain) return;
    const now = this.ctx.currentTime;
    const dur = 6 + Math.random() * 3;
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    const f0 = 55 + Math.random() * 25;
    const f1 = f0 * (0.55 + Math.random() * 0.25);
    osc.frequency.setValueAtTime(f0, now);
    osc.frequency.exponentialRampToValueAtTime(f1, now + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.08, now + dur * 0.35);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    osc.connect(g).connect(this.musicGain);
    osc.start(now);
    osc.stop(now + dur + 0.05);
  }

  /** Glassy high shimmer — a cluster of detuned high sines, quick fade. */
  private etherealShimmer(): void {
    if (!this.ctx || !this.musicGain) return;
    const now = this.ctx.currentTime;
    const base = 1320 + Math.random() * 880;
    const dur = 2.4;
    const voices = 4;
    for (let i = 0; i < voices; i++) {
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = base * (1 + (Math.random() - 0.5) * 0.015) * (1 + i * 0.5);
      const g = this.ctx.createGain();
      const start = now + i * 0.08;
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(0.018 / (i + 1), start + 0.6);
      g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      osc.connect(g).connect(this.musicGain);
      osc.start(start);
      osc.stop(start + dur + 0.05);
    }
  }

  shipLaunch(): void {
    if (!this.ctx || !this.sfxGain || this.muted) return;
    const now = this.ctx.currentTime;
    if (now - this.lastLaunchAt < 0.05) return;
    this.lastLaunchAt = now;
    const osc = this.ctx.createOscillator();
    osc.type = 'triangle';
    const g = this.ctx.createGain();
    osc.frequency.setValueAtTime(880, now);
    osc.frequency.exponentialRampToValueAtTime(1760, now + 0.08);
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.18, now + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
    osc.connect(g).connect(this.sfxGain);
    osc.start(now);
    osc.stop(now + 0.14);
  }

  planetCaptured(): void {
    if (!this.ctx || !this.sfxGain || this.muted) return;
    const now = this.ctx.currentTime;
    const notes = [523.25, 659.25, 783.99]; // C5 E5 G5 chime
    for (let i = 0; i < notes.length; i++) {
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = notes[i];
      const g = this.ctx.createGain();
      const start = now + i * 0.04;
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(0.25, start + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, start + 0.6);
      osc.connect(g).connect(this.sfxGain);
      osc.start(start);
      osc.stop(start + 0.65);
    }
  }

  /**
   * Play a soft chime as a ship lands. `friendly` arrivals ascend up a major
   * pentatonic scale; absorbed ships (chipping at an enemy garrison) descend
   * a minor-leaning scale. Per-planet throttling keeps things musical when a
   * whole wave of ships arrives at once.
   */
  shipArrival(planetId: number, friendly: boolean, fillProgress = 0): void {
    if (!this.ctx || !this.sfxGain || this.muted) return;
    const now = this.ctx.currentTime;
    const last = this.lastArriveAt.get(planetId) ?? 0;
    const minGap = friendly ? 0.07 : 0.09;
    if (now - last < minGap) return;
    this.lastArriveAt.set(planetId, now);

    const ladder = friendly ? FRIENDLY_LADDER : ABSORB_LADDER;
    // fillProgress (0..1) advances the ladder so a planet that's growing
    // sounds visibly ascending; outside that the planet's id seeds the index
    // so each planet has its own characteristic chime.
    const seed = friendly
      ? Math.floor(fillProgress * (ladder.length - 1) + (planetId * 3) % 3)
      : Math.floor(((planetId * 7) + (1 - fillProgress) * (ladder.length - 1)) % ladder.length);
    const idx = Math.max(0, Math.min(ladder.length - 1, seed));
    const freq = ladder[idx];

    const osc = this.ctx.createOscillator();
    osc.type = friendly ? 'sine' : 'triangle';
    osc.frequency.value = freq;

    const g = this.ctx.createGain();
    const peak = friendly ? 0.07 : 0.05;
    const dur = friendly ? 0.32 : 0.28;
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(peak, now + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    osc.connect(g).connect(this.sfxGain);
    osc.start(now);
    osc.stop(now + dur + 0.05);
  }

  /**
   * Resonant bell when a planet's capacity ring fills — marks the moment a
   * planet "upgrades" and starts producing faster.
   */
  ringFilled(ringIndex: number): void {
    if (!this.ctx || !this.sfxGain || this.muted) return;
    const now = this.ctx.currentTime;
    if (now - this.lastRingFillAt < 0.08) return;
    this.lastRingFillAt = now;

    // Two-note bell: a fundamental + a perfect fifth above, brighter for
    // higher rings.
    const base = ringIndex === 0 ? 523.25 : 659.25; // C5 or E5
    const fifth = base * 1.5;
    const partials = [base, fifth, base * 2];
    for (let i = 0; i < partials.length; i++) {
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = partials[i];
      const g = this.ctx.createGain();
      const start = now + i * 0.012;
      const peak = 0.18 / (i + 1);
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(peak, start + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, start + 0.9);
      osc.connect(g).connect(this.sfxGain);
      osc.start(start);
      osc.stop(start + 0.95);
    }
  }

  /**
   * Soft percussive click when an absorbed unit reaches the planet center.
   * Per-planet throttle keeps the sound sparse during heavy absorb sessions.
   */
  shipAbsorbed(planetId: number): void {
    if (!this.ctx || !this.sfxGain || this.muted) return;
    const now = this.ctx.currentTime;
    const last = this.lastAbsorbAt.get(planetId) ?? 0;
    if (now - last < 0.045) return;
    this.lastAbsorbAt.set(planetId, now);
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(720, now);
    osc.frequency.exponentialRampToValueAtTime(360, now + 0.09);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.06, now + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.1);
    osc.connect(g).connect(this.sfxGain);
    osc.start(now);
    osc.stop(now + 0.12);
  }

  /**
   * Tiny ascending pluck as each absorbed unit ticks a ring's fill counter.
   * Pitch rises with ring index so the player feels the build-up to a full ring.
   */
  ringTick(planetId: number, ringIndex: number): void {
    if (!this.ctx || !this.sfxGain || this.muted) return;
    const now = this.ctx.currentTime;
    const key = planetId * 8 + ringIndex;
    const last = this.lastRingTickAt.get(key) ?? 0;
    if (now - last < 0.04) return;
    this.lastRingTickAt.set(key, now);
    const base = ringIndex === 0 ? 880 : 1174.66; // A5 or D6
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = base;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.045, now + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.14);
    osc.connect(g).connect(this.sfxGain);
    osc.start(now);
    osc.stop(now + 0.16);
  }

  /**
   * Soft explosive pop when two enemy ships mutually annihilate in mid-flight.
   * Three-layer hit: sub-bass thump for body, filtered noise burst for air,
   * brief descending sine chirp for the "crack". Throttled so a wave of
   * simultaneous kills blends into one impact instead of a crackle.
   */
  shipDeath(): void {
    if (!this.ctx || !this.sfxGain || this.muted) return;
    const now = this.ctx.currentTime;
    if (now - this.lastDeathAt < 0.05) return;
    this.lastDeathAt = now;

    // Layer 1: noise burst, band-limited and quickly decaying — the "poof".
    const dur = 0.22;
    const sampleCount = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
    const buf = this.ctx.createBuffer(1, sampleCount, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < sampleCount; i++) {
      const t = i / sampleCount;
      // Steep exponential decay with a tiny attack ramp.
      const env = Math.min(1, t * 40) * Math.pow(1 - t, 2.6);
      data[i] = (Math.random() * 2 - 1) * env;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const noiseFilter = this.ctx.createBiquadFilter();
    noiseFilter.type = 'bandpass';
    const centerJitter = 900 + Math.random() * 600;
    noiseFilter.frequency.setValueAtTime(centerJitter + 400, now);
    noiseFilter.frequency.exponentialRampToValueAtTime(centerJitter * 0.55, now + dur);
    noiseFilter.Q.value = 1.1;
    const noiseGain = this.ctx.createGain();
    noiseGain.gain.value = 0.095;
    src.connect(noiseFilter).connect(noiseGain).connect(this.sfxGain);
    src.start(now);
    src.stop(now + dur + 0.02);

    // Layer 2: short sub-bass thump (60→30 Hz) — gives the hit its body. Kept
    // quiet so it doesn't dominate; felt more than heard.
    const thump = this.ctx.createOscillator();
    thump.type = 'sine';
    thump.frequency.setValueAtTime(78, now);
    thump.frequency.exponentialRampToValueAtTime(34, now + 0.18);
    const thumpGain = this.ctx.createGain();
    thumpGain.gain.setValueAtTime(0.0001, now);
    thumpGain.gain.exponentialRampToValueAtTime(0.14, now + 0.005);
    thumpGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.2);
    thump.connect(thumpGain).connect(this.sfxGain);
    thump.start(now);
    thump.stop(now + 0.22);

    // Layer 3: tiny descending sine chirp for the crack — pitched varied per
    // hit so repeated clashes don't sound stamped out.
    const chirpStart = 1400 + Math.random() * 500;
    const chirp = this.ctx.createOscillator();
    chirp.type = 'triangle';
    chirp.frequency.setValueAtTime(chirpStart, now);
    chirp.frequency.exponentialRampToValueAtTime(chirpStart * 0.35, now + 0.09);
    const chirpGain = this.ctx.createGain();
    chirpGain.gain.setValueAtTime(0.0001, now);
    chirpGain.gain.exponentialRampToValueAtTime(0.05, now + 0.006);
    chirpGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.1);
    chirp.connect(chirpGain).connect(this.sfxGain);
    chirp.start(now);
    chirp.stop(now + 0.12);
  }

  endSting(win: boolean): void {
    if (!this.ctx || !this.sfxGain || this.muted) return;
    const now = this.ctx.currentTime;
    const notes = win ? [523.25, 659.25, 783.99, 1046.5] : [392, 329.63, 261.63];
    for (let i = 0; i < notes.length; i++) {
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = notes[i];
      const g = this.ctx.createGain();
      const start = now + i * 0.14;
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(0.3, start + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, start + 0.8);
      osc.connect(g).connect(this.sfxGain);
      osc.start(start);
      osc.stop(start + 0.85);
    }
  }
}
