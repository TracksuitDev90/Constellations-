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
