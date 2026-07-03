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

/**
 * Slow ambient chord progression for the pad bed. All chords live in the
 * A-minor / C-major diatonic family so every SFX ladder (pentatonic chimes,
 * absorb plucks) stays consonant no matter which chord is up. Voice-led:
 * adjacent chords share tones or move by small steps, so the 8–11s glides
 * between them read as the drone slowly "turning over" rather than a key
 * change. Index 0 is the boot chord (matches the original static pad).
 */
const AMBIENT_CHORDS: ReadonlyArray<readonly [number, number, number]> = [
  [110.0, 164.81, 246.94], // Am add9  (A2  E3 B3)
  [87.31, 130.81, 196.0],  // F quartal (F2  C3 G3)
  [130.81, 196.0, 293.66], // C add9   (C3  G3 D4)
  [98.0, 146.83, 220.0],   // Gsus2    (G2  D3 A3)
  [82.41, 123.47, 196.0],  // Em7      (E2  B2 G3)
];

/**
 * Note pool for the sparse generative motif — A-minor pentatonic across two
 * octaves. Diatonic to every chord in AMBIENT_CHORDS, so a phrase can start
 * under one chord and finish under the next without ever clashing.
 */
const MOTIF_POOL = [220.0, 261.63, 293.66, 329.63, 392.0, 440.0, 523.25];

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
  private lastEvolveAt = 0;
  /** Persistent low-rumble bus for ongoing combat density. */
  private combatRumbleSource: AudioBufferSourceNode | null = null;
  private combatRumbleGain: GainNode | null = null;
  /** Last clock time the rumble target intensity was non-zero. */
  private combatLastActiveAt = 0;
  private etherealTimer: number | null = null;
  /**
   * Shared bus for the whole ambient bed (pad, sub, shimmer, ghost voices,
   * noise beds, ethereal one-shots, motif). A pair of ultra-slow LFOs ride
   * its gain so the entire soundtrack ebbs and swells over multi-minute
   * tides — the music breathes as one body instead of holding one level.
   */
  private bedGain: GainNode | null = null;
  /** Live pad oscillator pairs (main + detuned twin) for chord glides. */
  private padOscPairs: Array<{ a: OscillatorNode; b: OscillatorNode }> = [];
  private subOscNode: OscillatorNode | null = null;
  private shimmerOscA: OscillatorNode | null = null;
  private shimmerOscB: OscillatorNode | null = null;
  /** Index into AMBIENT_CHORDS the pad currently sits on (or glides toward). */
  private chordIdx = 0;
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

  /**
   * Suspend the context while the page is hidden — stops all DSP work
   * (battery on mobile) and silences the ambient bed over other apps.
   */
  suspend(): void {
    if (this.ctx && this.ctx.state === 'running') void this.ctx.suspend();
  }

  /** Resume after returning to the foreground (or an iOS audio interruption). */
  resume(): void {
    if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume();
  }

  /**
   * Slow shared "breath" phase (0..1) derived from the audio clock, one
   * cycle every 4 seconds — the same order of magnitude as the ambient
   * pad's tremolo LFOs, so visuals pulsing on it read as moving with the
   * music. Renderers shape it into whatever curve they need.
   */
  beatPhase01(): number {
    if (!this.ctx) return 0;
    const BEAT_HZ = 0.25;
    return (this.ctx.currentTime * BEAT_HZ) % 1;
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

    // ── Tide bus ──────────────────────────────────────────────────────────
    // Everything in the ambient bed routes through this gain, whose level
    // drifts on two ultra-slow LFOs (~2- and ~4-minute cycles). Their sum
    // never repeats cleanly, so the whole soundtrack ebbs away and swells
    // back like a tide — the "comfy" macro-motion under all the detail.
    const bed = this.ctx.createGain();
    bed.gain.value = 0.88;
    bed.connect(this.musicGain);
    this.bedGain = bed;
    this.attachSlowLfo(bed.gain, 0.0078, 0.16);
    this.attachSlowLfo(bed.gain, 0.0043, 0.1);

    // ── Filter bus ────────────────────────────────────────────────────────
    // Main lowpass with THREE summed LFOs at prime-ish rates. The combined
    // modulation never repeats cleanly so the cutoff meanders instead of
    // pulsing — the drone never sits on the same color for long.
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 820;
    filter.Q.value = 0.8;
    filter.connect(bed);

    this.attachSlowLfo(filter.frequency, 0.067, 360);
    this.attachSlowLfo(filter.frequency, 0.023, 190);
    this.attachSlowLfo(filter.frequency, 0.013, 95);
    // Slowly drifting Q adds a breathing "open / close" quality to the pad.
    this.attachSlowLfo(filter.Q, 0.031, 0.35);

    // ── Core pad voices ───────────────────────────────────────────────────
    // Each voice has its own tremolo at a different slow rate + an independent
    // detune drift, so pairs of voices drift in and out of phase with each
    // other instead of breathing in unison. Voices boot on AMBIENT_CHORDS[0]
    // and are re-pitched by the chord-drift scheduler over the match.
    const bootChord = AMBIENT_CHORDS[0];
    const padVoices = [
      { freq: bootChord[0], tremRate: 0.041, tremDepth: 0.045, driftRate: 0.019 },
      { freq: bootChord[1], tremRate: 0.063, tremDepth: 0.055, driftRate: 0.027 },
      { freq: bootChord[2], tremRate: 0.029, tremDepth: 0.040, driftRate: 0.017 },
    ];
    this.padOscPairs = padVoices.map((v) => this.addPadVoice(v, filter, 0.11)).filter(
      (p): p is { a: OscillatorNode; b: OscillatorNode } => p !== null,
    );

    // ── Sub-bass "breathing" voice ───────────────────────────────────────
    // A very low sine that swells in and out over ~90s. Adds a felt-not-heard
    // low-end movement that keeps the drone from feeling static even when
    // the mid register is settled.
    const subOsc = this.ctx.createOscillator();
    subOsc.type = 'sine';
    subOsc.frequency.value = bootChord[0] / 2; // an octave under the chord root
    this.subOscNode = subOsc;
    const subGain = this.ctx.createGain();
    subGain.gain.value = 0.045;
    subOsc.connect(subGain).connect(bed);
    subOsc.start();
    // Breath LFO on the sub gain — slow, deep.
    this.attachSlowLfo(subGain.gain, 0.011, 0.04);
    // Subtle pitch drift on the sub (microtonal), gives an "engine humming"
    // quality without ever sounding mechanical.
    this.attachSlowLfo(subOsc.detune, 0.007, 12);

    // ── Upper harmonic shimmer layer ─────────────────────────────────────
    // A pair of very quiet high sines a fifth apart that drift in their own
    // amplitude envelope — when they swell they add air, when they recede
    // the pad feels more grounded.
    const shimmerA = this.ctx.createOscillator();
    shimmerA.type = 'sine';
    shimmerA.frequency.value = bootChord[1] * 4; // E5 at boot
    const shimmerB = this.ctx.createOscillator();
    shimmerB.type = 'sine';
    shimmerB.frequency.value = bootChord[2] * 4; // B5 at boot
    this.shimmerOscA = shimmerA;
    this.shimmerOscB = shimmerB;
    const shimmerGain = this.ctx.createGain();
    shimmerGain.gain.value = 0.014;
    shimmerA.connect(shimmerGain);
    shimmerB.connect(shimmerGain);
    shimmerGain.connect(filter);
    shimmerA.start();
    shimmerB.start();
    // Very slow swell on shimmer — absent most of the time, present briefly.
    this.attachSlowLfo(shimmerGain.gain, 0.009, 0.012);
    this.attachSlowLfo(shimmerA.detune, 0.043, 8);
    this.attachSlowLfo(shimmerB.detune, 0.037, 8);

    // ── Occasional "ghost" harmonic voices ───────────────────────────────
    // Scheduled transient pads that fade in, drift, and leave. Re-rolls its
    // pitch each time so the harmonic context shifts without a key change.
    this.scheduleGhostVoice();

    // ── Occasional bandpass noise "solar wind" bed ───────────────────────
    // Low-volume filtered noise that fades in slowly and sits under the pad
    // for ~20-40s. Keeps the texture alive in stretches without any new
    // melodic event; overlaps freely with the ethereal one-shots.
    this.scheduleNoiseBed();

    // Break up the otherwise-constant drone with sparse ethereal one-shots —
    // airy windy swells, distant chimes, subtle sweeps. Scheduled in JS-time
    // so they don't all stack in the audio graph up front.
    this.scheduleEthereal();

    // ── Slow harmonic motion ─────────────────────────────────────────────
    // Every 20-40s the whole pad (voices + sub + shimmer) glides to a new
    // chord over ~8-11s. This is the main anti-drone measure: the bed now
    // has a harmonic story instead of sitting on one Am cluster forever.
    this.scheduleChordDrift();

    // ── Sparse generative motif ──────────────────────────────────────────
    // Occasional soft pentatonic phrases (3-6 notes) floating above the pad
    // — enough melodic identity to break the drone without ever becoming a
    // hook that could wear out over a long session.
    this.scheduleMotif();
  }

  /**
   * Add a core pad voice: two slightly detuned sines, per-voice tremolo via
   * a slow LFO on the voice gain, and a second detune-drift LFO so the
   * beating frequency between the two oscillators wanders over minutes.
   */
  private addPadVoice(
    spec: { freq: number; tremRate: number; tremDepth: number; driftRate: number },
    dest: AudioNode,
    baseGain: number,
  ): { a: OscillatorNode; b: OscillatorNode } | null {
    if (!this.ctx) return null;
    const osc1 = this.ctx.createOscillator();
    osc1.type = 'sine';
    osc1.frequency.value = spec.freq;
    const osc2 = this.ctx.createOscillator();
    osc2.type = 'sine';
    osc2.frequency.value = spec.freq * 1.003;

    const voiceGain = this.ctx.createGain();
    voiceGain.gain.value = baseGain;
    osc1.connect(voiceGain);
    osc2.connect(voiceGain);
    voiceGain.connect(dest);
    osc1.start();
    osc2.start();

    this.attachSlowLfo(voiceGain.gain, spec.tremRate, spec.tremDepth);
    // Slow detune drift on osc2 only so the beat frequency between the two
    // oscillators wanders over minutes — never lands the same way twice.
    this.attachSlowLfo(osc2.detune, spec.driftRate, 14);
    // Tiny breath on osc1 too so the pair doesn't stay at a fixed offset.
    this.attachSlowLfo(osc1.detune, spec.driftRate * 0.63, 6);
    return { a: osc1, b: osc2 };
  }

  /**
   * Every 20-40s, glide the entire harmonic bed (pad voices, sub-bass,
   * shimmer pair) to a new chord from AMBIENT_CHORDS over ~8-11 seconds.
   * The glide is slow enough to read as the drone "leaning" rather than a
   * chord change, but over a couple of minutes the harmony visits the whole
   * progression — the single biggest cure for the static-drone feel.
   */
  private scheduleChordDrift(): void {
    const delay = 20000 + Math.random() * 20000;
    window.setTimeout(() => {
      this.driftToNextChord();
      this.scheduleChordDrift();
    }, delay);
  }

  private driftToNextChord(): void {
    if (!this.ctx || this.ctx.state !== 'running') return;
    // Muted just means the master gain is 0 — keep drifting silently so the
    // harmony is somewhere new when the player unmutes.
    let next = Math.floor(Math.random() * AMBIENT_CHORDS.length);
    if (next === this.chordIdx) next = (next + 1) % AMBIENT_CHORDS.length;
    this.chordIdx = next;
    const chord = AMBIENT_CHORDS[next];
    const now = this.ctx.currentTime;
    const glide = 8 + Math.random() * 3;

    const rampTo = (param: AudioParam, target: number): void => {
      // Pin the automation to the param's current value first so the ramp
      // starts from wherever a previous (possibly unfinished) glide left it.
      const from = Math.max(1e-3, param.value);
      param.cancelScheduledValues(now);
      param.setValueAtTime(from, now);
      param.exponentialRampToValueAtTime(Math.max(1e-3, target), now + glide);
    };

    for (let i = 0; i < this.padOscPairs.length; i++) {
      const f = chord[i] ?? chord[chord.length - 1];
      rampTo(this.padOscPairs[i].a.frequency, f);
      rampTo(this.padOscPairs[i].b.frequency, f * 1.003);
    }
    if (this.subOscNode) rampTo(this.subOscNode.frequency, chord[0] / 2);
    if (this.shimmerOscA) rampTo(this.shimmerOscA.frequency, chord[1] * 4);
    if (this.shimmerOscB) rampTo(this.shimmerOscB.frequency, chord[2] * 4);
  }

  /**
   * Queue the next generative motif phrase — a long, irregular gap (35-70s)
   * so phrases feel like rare transmissions, not background muzak.
   */
  private scheduleMotif(): void {
    const delay = 35000 + Math.random() * 35000;
    window.setTimeout(() => {
      if (!this.muted) this.playMotif();
      this.scheduleMotif();
    }, delay);
  }

  /**
   * Play a short random-walk phrase over the pentatonic MOTIF_POOL: 3-6 soft
   * bell tones with slow attacks, each with a quiet octave partial. Note
   * spacing is loose and human (0.7-1.4s) and the whole phrase decrescendos,
   * so it reads as a distant melody drifting past rather than a jingle.
   */
  private playMotif(): void {
    if (!this.ctx || !this.musicGain) return;
    if (this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    const noteCount = 3 + Math.floor(Math.random() * 4);
    let idx = Math.floor(Math.random() * MOTIF_POOL.length);
    let t = now + 0.05;
    // Soften the phrase through a gentle lowpass so it sits behind the SFX.
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1600;
    lp.Q.value = 0.5;
    lp.connect(this.bedGain ?? this.musicGain);
    for (let n = 0; n < noteCount; n++) {
      const f = MOTIF_POOL[idx];
      const fade = 1 - (n / noteCount) * 0.45; // phrase decrescendo
      const peak = (0.035 + Math.random() * 0.012) * fade;
      const dur = 2.2 + Math.random() * 0.8;
      const partials = [f, f * 2.002];
      const gains = [peak, peak * 0.35];
      for (let i = 0; i < partials.length; i++) {
        const osc = this.ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = partials[i];
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(gains[i], t + 0.25);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        osc.connect(g).connect(lp);
        osc.start(t);
        osc.stop(t + dur + 0.05);
      }
      // Random walk: mostly steps, occasional leap, clamped to the pool.
      const step = Math.random() < 0.7 ? (Math.random() < 0.5 ? -1 : 1) : (Math.random() < 0.5 ? -2 : 2);
      idx = Math.max(0, Math.min(MOTIF_POOL.length - 1, idx + step));
      t += 0.7 + Math.random() * 0.7;
    }
  }

  /**
   * Attach an oscillator LFO to an AudioParam. The LFO's output is scaled
   * by `depth` and summed with the param's base value, so the param
   * oscillates by ±depth around whatever it was set to. Runs forever.
   */
  private attachSlowLfo(param: AudioParam, rateHz: number, depth: number): void {
    if (!this.ctx) return;
    const lfo = this.ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = rateHz;
    const g = this.ctx.createGain();
    g.gain.value = depth;
    lfo.connect(g).connect(param);
    // Randomize start phase so multiple LFOs don't line up on boot.
    lfo.start(this.ctx.currentTime + Math.random() * 0.2);
  }

  /**
   * Schedule a transient "ghost" harmonic pad — a quiet voice that fades in,
   * drifts, and fades out over ~25-45 seconds on a random consonant interval
   * above the base key. Reschedules itself after each cycle so the texture
   * keeps shifting without ever turning into a melody.
   */
  private scheduleGhostVoice(): void {
    const delay = 18000 + Math.random() * 30000;
    window.setTimeout(() => {
      if (!this.muted) this.playGhostVoice();
      this.scheduleGhostVoice();
    }, delay);
  }

  private playGhostVoice(): void {
    if (!this.ctx || !this.musicGain) return;
    // Suspended context (page hidden): skip — scheduling against a frozen
    // clock would stack every missed one-shot onto the moment of resume.
    if (this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    // Intervals above A2 (110) that stay consonant with the A-minor pentatonic
    // pad — fifth, fourth, minor third, octave, major second up a tenth.
    const notes = [146.83, 196.0, 220.0, 261.63, 329.63];
    const f = notes[Math.floor(Math.random() * notes.length)];
    const dur = 25 + Math.random() * 20;
    const osc1 = this.ctx.createOscillator();
    osc1.type = 'sine';
    osc1.frequency.value = f;
    const osc2 = this.ctx.createOscillator();
    osc2.type = 'sine';
    osc2.frequency.value = f * 2.003; // octave up, slightly sharp
    const g = this.ctx.createGain();
    const peak = 0.025 + Math.random() * 0.02;
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(peak, now + dur * 0.35);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    osc1.connect(g);
    osc2.connect(g);
    g.connect(this.bedGain ?? this.musicGain);
    osc1.start(now);
    osc2.start(now);
    osc1.stop(now + dur + 0.1);
    osc2.stop(now + dur + 0.1);
    // Slow drift on the octave partial so the voice shimmers while it's up.
    this.attachSlowLfo(osc2.detune, 0.051, 11);
  }

  /**
   * Schedule a long, quiet "solar wind" noise bed — bandpassed white noise
   * that fades in slowly, sits for 20-40s, then fades out. Helps fill the
   * gaps between ethereal one-shots without ever becoming loud enough to
   * compete with them.
   */
  private scheduleNoiseBed(): void {
    const delay = 12000 + Math.random() * 25000;
    window.setTimeout(() => {
      if (!this.muted) this.playNoiseBed();
      this.scheduleNoiseBed();
    }, delay);
  }

  private playNoiseBed(): void {
    if (!this.ctx || !this.musicGain) return;
    // Suspended context (page hidden): skip — scheduling against a frozen
    // clock would stack every missed one-shot onto the moment of resume.
    if (this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    const dur = 20 + Math.random() * 22;
    const sr = this.ctx.sampleRate;
    const sampleCount = Math.max(1, Math.floor(sr * Math.min(dur, 12)));
    const buf = this.ctx.createBuffer(1, sampleCount, sr);
    const data = buf.getChannelData(0);
    for (let i = 0; i < sampleCount; i++) data[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true; // loop the short noise buffer across the full duration
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 0.5;
    const centerStart = 340 + Math.random() * 280;
    bp.frequency.setValueAtTime(centerStart, now);
    bp.frequency.linearRampToValueAtTime(centerStart * (0.6 + Math.random() * 0.6), now + dur);
    const g = this.ctx.createGain();
    const peak = 0.028 + Math.random() * 0.015;
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(peak, now + dur * 0.3);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    src.connect(bp).connect(g).connect(this.bedGain ?? this.musicGain);
    src.start(now);
    src.stop(now + dur + 0.1);
  }

  /**
   * Queue up the next sparse ambient one-shot. Variable gap (6..19s) so the
   * variance feels natural, never rhythmic. Reschedules itself forever.
   */
  private scheduleEthereal(): void {
    if (this.etherealTimer !== null) clearTimeout(this.etherealTimer);
    const delay = 6000 + Math.random() * 13000;
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
    // Suspended context (page hidden): skip — scheduling against a frozen
    // clock would stack every missed one-shot onto the moment of resume.
    if (this.ctx.state !== 'running') return;
    const pick = Math.floor(Math.random() * 8);
    if (pick === 0) this.etherealWindSwell();
    else if (pick === 1) this.etherealDistantChime();
    else if (pick === 2) this.etherealDeepSweep();
    else if (pick === 3) this.etherealShimmer();
    else if (pick === 4) this.etherealCometWhistle();
    else if (pick === 5) this.etherealPulsarEchoes();
    else if (pick === 6) this.etherealAuroraSwell();
    else this.etherealVoidBreath();
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
    src.connect(lp).connect(g).connect(this.bedGain ?? this.musicGain);
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
      osc.connect(g).connect(this.bedGain ?? this.musicGain);
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
    osc.connect(g).connect(this.bedGain ?? this.musicGain);
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
      osc.connect(g).connect(this.bedGain ?? this.musicGain);
      osc.start(start);
      osc.stop(start + dur + 0.05);
    }
  }

  /**
   * A slow, falling whistle with gentle vibrato and a faint noise tail —
   * something small streaking past very far away. Quiet and lowpassed so it
   * reads as atmosphere, not an SFX.
   */
  private etherealCometWhistle(): void {
    if (!this.ctx || !this.musicGain) return;
    const now = this.ctx.currentTime;
    const bus = this.bedGain ?? this.musicGain;
    const dur = 3.5 + Math.random() * 2.5;
    const f0 = 900 + Math.random() * 500;
    const f1 = f0 * (0.4 + Math.random() * 0.15);
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(f0, now);
    osc.frequency.exponentialRampToValueAtTime(f1, now + dur);
    // Gentle vibrato so the whistle wavers like it's crossing thin air.
    this.attachSlowLfo(osc.frequency, 4.6, f0 * 0.008);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1800;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.022, now + dur * 0.3);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    osc.connect(lp).connect(g).connect(bus);
    osc.start(now);
    osc.stop(now + dur + 0.05);

    // Faint airy tail trailing the whistle.
    const tailDur = dur * 0.8;
    const sr = this.ctx.sampleRate;
    const buf = this.ctx.createBuffer(1, Math.max(1, Math.floor(sr * tailDur)), sr);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.2;
    bp.frequency.setValueAtTime(f0 * 0.8, now);
    bp.frequency.exponentialRampToValueAtTime(f1 * 0.8, now + tailDur);
    const ng = this.ctx.createGain();
    ng.gain.setValueAtTime(0.0001, now);
    ng.gain.exponentialRampToValueAtTime(0.012, now + tailDur * 0.4);
    ng.gain.exponentialRampToValueAtTime(0.0001, now + tailDur);
    src.connect(bp).connect(ng).connect(bus);
    src.start(now);
    src.stop(now + tailDur + 0.05);
  }

  /**
   * A soft repeating ping that echoes away into silence — a distant pulsar /
   * sonar heartbeat. The repeats are slow (~0.5s) and each is quieter and
   * darker than the last, so it recedes rather than insists.
   */
  private etherealPulsarEchoes(): void {
    if (!this.ctx || !this.musicGain) return;
    const now = this.ctx.currentTime;
    const bus = this.bedGain ?? this.musicGain;
    // Pentatonic-safe pitches so echoes stay consonant under any chord.
    const roots = [440.0, 523.25, 587.33, 659.25]; // A4 C5 D5 E5
    const f = roots[Math.floor(Math.random() * roots.length)];
    const echoes = 4 + Math.floor(Math.random() * 3);
    const gap = 0.45 + Math.random() * 0.2;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2200;
    lp.connect(bus);
    for (let i = 0; i < echoes; i++) {
      const start = now + i * gap;
      const peak = 0.035 * Math.pow(0.62, i);
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      // Each echo lands a hair flatter — the ping "sinking" into the distance.
      osc.frequency.value = f * (1 - i * 0.004);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(peak, start + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, start + 0.8);
      osc.connect(g).connect(lp);
      osc.start(start);
      osc.stop(start + 0.85);
    }
  }

  /**
   * Two barely-detuned mid sines that swell together over ~8-12s — their
   * beat frequency shimmers like an aurora curtain, then the pair recedes.
   */
  private etherealAuroraSwell(): void {
    if (!this.ctx || !this.musicGain) return;
    const now = this.ctx.currentTime;
    const bus = this.bedGain ?? this.musicGain;
    const dur = 8 + Math.random() * 4;
    // Chord-family pitches an octave-ish above the pad.
    const roots = [220.0, 261.63, 329.63, 392.0];
    const f = roots[Math.floor(Math.random() * roots.length)];
    const detune = 1.004 + Math.random() * 0.004; // ~1.5-3.5 Hz beating
    for (const freq of [f, f * detune]) {
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(0.02, now + dur * 0.45);
      g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
      osc.connect(g).connect(bus);
      osc.start(now);
      osc.stop(now + dur + 0.05);
    }
  }

  /**
   * A deep, dark inhale-exhale of lowpassed noise — the void itself
   * breathing once. Sits almost entirely under 300 Hz; felt more than heard.
   */
  private etherealVoidBreath(): void {
    if (!this.ctx || !this.musicGain) return;
    const now = this.ctx.currentTime;
    const bus = this.bedGain ?? this.musicGain;
    const dur = 5 + Math.random() * 3;
    const sr = this.ctx.sampleRate;
    const buf = this.ctx.createBuffer(1, Math.max(1, Math.floor(sr * dur)), sr);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 0.7;
    // The filter opens on the inhale and closes on the exhale.
    lp.frequency.setValueAtTime(120, now);
    lp.frequency.linearRampToValueAtTime(300, now + dur * 0.5);
    lp.frequency.linearRampToValueAtTime(90, now + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.05, now + dur * 0.5);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    src.connect(lp).connect(g).connect(bus);
    src.start(now);
    src.stop(now + dur + 0.05);
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

  /**
   * A planet's residual hull finally gives out and the world goes neutral.
   * Reads as a "breaking shield" — a short descending noise-band sweep paired
   * with a soft sub-thump, and a brief glassy crack on top. Distinct from
   * `planetCaptured` (ascending chime) and `shipDeath` (sharp poof) so the
   * player registers it as a third, distinct event.
   */
  planetNeutralized(): void {
    if (!this.ctx || !this.sfxGain || this.muted) return;
    const now = this.ctx.currentTime;

    // Layer 1: descending bandpass-noise sweep — the "shield shatter".
    const dur = 0.55;
    const sampleCount = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
    const buf = this.ctx.createBuffer(1, sampleCount, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < sampleCount; i++) {
      const t = i / sampleCount;
      const env = Math.min(1, t * 20) * Math.pow(1 - t, 1.8);
      data[i] = (Math.random() * 2 - 1) * env;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.4;
    bp.frequency.setValueAtTime(1400, now);
    bp.frequency.exponentialRampToValueAtTime(320, now + dur);
    const noiseGain = this.ctx.createGain();
    noiseGain.gain.value = 0.12;
    src.connect(bp).connect(noiseGain).connect(this.sfxGain);
    src.start(now);
    src.stop(now + dur + 0.02);

    // Layer 2: low sub-thump — gives the shatter body. Slightly longer than
    // ship death's thump so it reads as a bigger event.
    const thump = this.ctx.createOscillator();
    thump.type = 'sine';
    thump.frequency.setValueAtTime(92, now);
    thump.frequency.exponentialRampToValueAtTime(44, now + 0.28);
    const thumpGain = this.ctx.createGain();
    thumpGain.gain.setValueAtTime(0.0001, now);
    thumpGain.gain.exponentialRampToValueAtTime(0.16, now + 0.008);
    thumpGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.32);
    thump.connect(thumpGain).connect(this.sfxGain);
    thump.start(now);
    thump.stop(now + 0.34);

    // Layer 3: two glassy descending partials — the audible "crack" on top
    // of the shatter. Minor third falling to evoke the loss.
    const partials = [880, 740];
    for (let i = 0; i < partials.length; i++) {
      const osc = this.ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(partials[i] * 1.5, now);
      osc.frequency.exponentialRampToValueAtTime(partials[i] * 0.5, now + 0.4);
      const g = this.ctx.createGain();
      const start = now + i * 0.05;
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(0.055 / (i + 1), start + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, start + 0.45);
      osc.connect(g).connect(this.sfxGain);
      osc.start(start);
      osc.stop(start + 0.5);
    }
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

  /**
   * Resonant ascending swell when a planet evolves to its next size — a
   * bigger, bassier event than `ringFilled`. Three-osc chord (sub + root +
   * fifth) with a sustain plateau so the moment lands.
   */
  planetEvolve(newType: number): void {
    if (!this.ctx || !this.sfxGain || this.muted) return;
    const now = this.ctx.currentTime;
    if (now - this.lastEvolveAt < 0.15) return;
    this.lastEvolveAt = now;

    // Pitch climbs slightly per tier so back-to-back evolutions feel like a
    // staircase rather than the same chime each time.
    const root = 220 * Math.pow(2, newType * 0.25);
    const partials = [
      { freq: 60, peak: 0.16, sweep: 90 }, // sub-bass thump that rises a bit
      { freq: root, peak: 0.22, sweep: root },
      { freq: root * 1.5, peak: 0.14, sweep: root * 1.5 }, // perfect fifth
    ];
    for (let i = 0; i < partials.length; i++) {
      const p = partials[i];
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(p.freq, now);
      if (i === 0) osc.frequency.exponentialRampToValueAtTime(p.sweep, now + 0.3);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(p.peak, now + 0.05);
      g.gain.setValueAtTime(p.peak, now + 0.45);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.9);
      osc.connect(g).connect(this.sfxGain);
      osc.start(now);
      osc.stop(now + 0.95);
    }
  }

  /**
   * Drive a persistent low-rumble that swells with combat density. `intensity`
   * is 0..1 (see Game.ts: deaths-per-second over a 1s window normalized).
   * Lazy-allocates a noise source on first non-zero call; tears it down once
   * intensity has stayed at zero for >2s so silence really is silent.
   */
  combatTension(intensity: number): void {
    if (!this.ctx || !this.sfxGain || this.muted) {
      // Even if muted, ensure any active rumble is torn down.
      if (this.combatRumbleSource) this.stopCombatRumble();
      return;
    }
    const now = this.ctx.currentTime;
    const target = Math.max(0, Math.min(1, intensity));
    if (target > 0) this.combatLastActiveAt = now;

    if (target > 0 && !this.combatRumbleSource) this.startCombatRumble();
    if (this.combatRumbleGain) {
      // Linear ramp tracks the intensity smoothly so spurts of deaths don't
      // pop the level. 0.06 ceiling keeps the rumble felt-not-heard.
      const peak = target * 0.06;
      this.combatRumbleGain.gain.cancelScheduledValues(now);
      this.combatRumbleGain.gain.setTargetAtTime(peak, now, 0.18);
    }
    if (this.combatRumbleSource && target === 0 && now - this.combatLastActiveAt > 2.0) {
      this.stopCombatRumble();
    }
  }

  private startCombatRumble(): void {
    if (!this.ctx || !this.sfxGain) return;
    const sr = this.ctx.sampleRate;
    // ~2s loop of white noise; bandpass shaped into a sub rumble.
    const sampleCount = Math.max(1, Math.floor(sr * 2));
    const buf = this.ctx.createBuffer(1, sampleCount, sr);
    const data = buf.getChannelData(0);
    for (let i = 0; i < sampleCount; i++) data[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 140;
    bp.Q.value = 0.6;
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    src.connect(bp).connect(gain).connect(this.sfxGain);
    src.start();
    this.combatRumbleSource = src;
    this.combatRumbleGain = gain;
  }

  private stopCombatRumble(): void {
    if (this.combatRumbleSource) {
      try {
        this.combatRumbleSource.stop();
      } catch {
        // already stopped
      }
      this.combatRumbleSource.disconnect();
    }
    if (this.combatRumbleGain) this.combatRumbleGain.disconnect();
    this.combatRumbleSource = null;
    this.combatRumbleGain = null;
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
