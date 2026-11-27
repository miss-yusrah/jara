'use client'

// Jara Streak's music and sound effects, made live with the Web Audio API: no audio files, nothing
// licensed, nothing to download. An Afrobeats-style groove (kick, clap, shaker, log drum, a highlife
// guitar line) in A minor that builds as the streak grows: the lobby is laid back, a run adds drums
// and bass, a combo adds the bell and clap, and a Golden Hour adds sparkle on top. The tempo rises
// with the streak. Browsers only allow sound after a tap, so start() is called from a button.

const midi = (n: number) => 440 * 2 ** ((n - 69) / 12)

// A minor: Am, F, C, G, one chord per bar.
const CHORDS = [[57, 60, 64], [53, 57, 60], [60, 64, 67], [55, 59, 62]]
const ROOTS = [45, 41, 48, 43]
const KICK = [0, 6, 8, 14]
const CLAP = [4, 12]
const RIM = [3, 7, 10, 15]
const BELL = [0, 3, 6, 10, 12]
const LOG = [0, 3, 6, 10, 11]
const GUITAR = [0, 2, 3, 5, 6, 8, 10, 11, 13, 14]

export type Mood = 'lobby' | 'play' | 'combo' | 'fire' | 'golden'
const LEVEL: Record<Mood, number> = { lobby: 0, play: 1, combo: 2, fire: 3, golden: 4 }

export class StreakAudio {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private music: GainNode | null = null
  private fx: GainNode | null = null
  private noise: AudioBuffer | null = null
  private timer: number | null = null
  private step = 0
  private next = 0
  private bpm = 104
  private level = 0
  private muted = false
  private onVisibility = () => {
    if (!this.ctx) return
    if (document.visibilityState === 'hidden') void this.ctx.suspend()
    else if (!this.muted) void this.ctx.resume()
  }

  /** Call from a tap. Safe to call again. */
  start() {
    if (typeof window === 'undefined') return
    if (!this.ctx) {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctx) return
      const ctx = new Ctx()
      this.ctx = ctx
      this.master = ctx.createGain()
      this.master.gain.value = this.muted ? 0 : 0.8
      const comp = ctx.createDynamicsCompressor()
      comp.threshold.value = -14
      comp.ratio.value = 4
      this.master.connect(comp).connect(ctx.destination)
      this.music = ctx.createGain()
      this.music.gain.value = 0.55
      this.music.connect(this.master)
      this.fx = ctx.createGain()
      this.fx.gain.value = 0.9
      this.fx.connect(this.master)
      const length = ctx.sampleRate
      this.noise = ctx.createBuffer(1, length, ctx.sampleRate)
      const data = this.noise.getChannelData(0)
      for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1
      document.addEventListener('visibilitychange', this.onVisibility)
    }
    if (this.ctx.state === 'suspended' && !this.muted) void this.ctx.resume()
    if (this.timer === null) {
      this.next = this.ctx.currentTime + 0.08
      this.timer = window.setInterval(() => this.schedule(), 25)
    }
  }

  stop() {
    if (this.timer !== null) window.clearInterval(this.timer)
    this.timer = null
    document.removeEventListener('visibilitychange', this.onVisibility)
    void this.ctx?.close()
    this.ctx = null
  }

  setMuted(muted: boolean) {
    this.muted = muted
    if (!this.ctx || !this.master) return
    this.master.gain.setTargetAtTime(muted ? 0 : 0.8, this.ctx.currentTime, 0.05)
    if (!muted && this.ctx.state === 'suspended') void this.ctx.resume()
  }

  /** How full the groove is, and how fast: 104 bpm in the lobby, up to 124 on a long streak. */
  setMood(mood: Mood, streak = 0) {
    this.level = LEVEL[mood]
    this.bpm = mood === 'lobby' ? 104 : Math.min(124, 108 + streak)
  }

  private schedule() {
    const ctx = this.ctx
    if (!ctx) return
    while (this.next < ctx.currentTime + 0.12) {
      this.playStep(this.step, this.next)
      this.next += 60 / this.bpm / 4
      this.step = (this.step + 1) % 64
    }
  }

  private playStep(step: number, t: number) {
    const bar = Math.floor(step / 16)
    const s = step % 16
    const lvl = this.level
    // Shaker on every 16th, accented off the beat.
    this.hat(t, s % 2 ? 0.05 : 0.025)
    if (GUITAR.includes(s)) {
      const chord = CHORDS[bar]
      const note = chord[(GUITAR.indexOf(s) + bar) % chord.length] + (s >= 8 ? 12 : 0)
      this.pluck(t, midi(note), lvl === 0 ? 0.06 : 0.05)
    }
    if (lvl === 0) {
      if (s === 0 || s === 8) this.kick(t, 0.35)
      if (s === 0) this.pad(t, CHORDS[bar], 60 / this.bpm * 4)
      return
    }
    if (KICK.includes(s)) this.kick(t, 0.9)
    if (LOG.includes(s)) this.logDrum(t, midi(ROOTS[bar] + (s === 10 || s === 11 ? 12 : 0)))
    if (lvl >= 2) {
      if (CLAP.includes(s)) this.clap(t)
      if (BELL.includes(s)) this.bell(t)
    }
    if (lvl >= 3 && RIM.includes(s)) this.rim(t)
    if (lvl >= 4) this.sparkle(t, midi(CHORDS[bar][s % 3] + 24))
  }

  // ---- instruments ----

  private env(t: number, peak: number, attack: number, decay: number, dest: AudioNode) {
    const g = this.ctx!.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(peak, t + attack)
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay)
    g.connect(dest)
    return g
  }

  private noiseBurst(t: number, length: number) {
    const src = this.ctx!.createBufferSource()
    src.buffer = this.noise
    src.start(t, Math.random() * 0.5, length)
    return src
  }

  private kick(t: number, peak: number) {
    const ctx = this.ctx!
    const o = ctx.createOscillator()
    o.frequency.setValueAtTime(150, t)
    o.frequency.exponentialRampToValueAtTime(45, t + 0.12)
    o.connect(this.env(t, peak, 0.003, 0.3, this.music!))
    o.start(t); o.stop(t + 0.35)
  }

  private hat(t: number, peak: number) {
    const ctx = this.ctx!
    const f = ctx.createBiquadFilter()
    f.type = 'highpass'; f.frequency.value = 7000
    this.noiseBurst(t, 0.05).connect(f)
    f.connect(this.env(t, peak, 0.002, 0.04, this.music!))
  }

  private clap(t: number) {
    const ctx = this.ctx!
    const f = ctx.createBiquadFilter()
    f.type = 'bandpass'; f.frequency.value = 1400; f.Q.value = 0.8
    this.noiseBurst(t, 0.2).connect(f)
    f.connect(this.env(t, 0.35, 0.004, 0.16, this.music!))
  }

  private rim(t: number) {
    const ctx = this.ctx!
    const o = ctx.createOscillator()
    o.type = 'square'; o.frequency.value = 1750
    const f = ctx.createBiquadFilter()
    f.type = 'bandpass'; f.frequency.value = 1750
    o.connect(f).connect(this.env(t, 0.07, 0.001, 0.03, this.music!))
    o.start(t); o.stop(t + 0.05)
  }

  private bell(t: number) {
    const ctx = this.ctx!
    for (const freq of [830, 1245]) {
      const o = ctx.createOscillator()
      o.type = 'square'; o.frequency.value = freq
      const f = ctx.createBiquadFilter()
      f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = 6
      o.connect(f).connect(this.env(t, 0.06, 0.002, 0.12, this.music!))
      o.start(t); o.stop(t + 0.16)
    }
  }

  /** The amapiano-style log drum: a round bass note that drops into place. */
  private logDrum(t: number, freq: number) {
    const ctx = this.ctx!
    const o = ctx.createOscillator()
    o.frequency.setValueAtTime(freq * 1.6, t)
    o.frequency.exponentialRampToValueAtTime(freq, t + 0.06)
    const f = ctx.createBiquadFilter()
    f.type = 'lowpass'; f.frequency.value = 900
    o.connect(f).connect(this.env(t, 0.5, 0.005, 0.32, this.music!))
    o.start(t); o.stop(t + 0.4)
  }

  /** Highlife-style guitar pluck. */
  private pluck(t: number, freq: number, peak: number) {
    const ctx = this.ctx!
    const o = ctx.createOscillator()
    o.type = 'triangle'; o.frequency.value = freq
    const f = ctx.createBiquadFilter()
    f.type = 'lowpass'; f.frequency.setValueAtTime(3200, t); f.frequency.exponentialRampToValueAtTime(700, t + 0.2)
    o.connect(f).connect(this.env(t, peak, 0.003, 0.22, this.music!))
    o.start(t); o.stop(t + 0.3)
  }

  private pad(t: number, chord: number[], length: number) {
    const ctx = this.ctx!
    for (const n of chord) {
      const o = ctx.createOscillator()
      o.type = 'sine'; o.frequency.value = midi(n - 12)
      o.connect(this.env(t, 0.035, length * 0.3, length * 0.7, this.music!))
      o.start(t); o.stop(t + length + 0.05)
    }
  }

  private sparkle(t: number, freq: number) {
    const ctx = this.ctx!
    const o = ctx.createOscillator()
    o.type = 'sine'; o.frequency.value = freq
    o.connect(this.env(t, 0.03, 0.002, 0.09, this.music!))
    o.start(t); o.stop(t + 0.12)
  }

  // ---- sound effects ----

  private tone(freq: number, at: number, length: number, type: OscillatorType = 'sine', peak = 0.25, slideTo?: number) {
    const ctx = this.ctx
    if (!ctx || !this.fx) return
    const t = ctx.currentTime + at
    const o = ctx.createOscillator()
    o.type = type
    o.frequency.setValueAtTime(freq, t)
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + length)
    o.connect(this.env(t, peak, 0.005, length, this.fx))
    o.start(t); o.stop(t + length + 0.05)
  }

  /** Brighter as the streak grows. */
  correct(streak: number) {
    const lift = Math.min(streak, 12)
    this.tone(midi(76 + lift), 0, 0.09, 'triangle', 0.22)
    this.tone(midi(83 + lift), 0.07, 0.16, 'triangle', 0.22)
  }

  wrong() {
    this.tone(220, 0, 0.45, 'sawtooth', 0.12, 70)
    this.tone(233, 0, 0.45, 'square', 0.05, 75)
  }

  tick() { this.tone(1500, 0, 0.03, 'square', 0.05) }

  combo() { [72, 76, 79, 84].forEach((n, i) => this.tone(midi(n), i * 0.06, 0.14, 'triangle', 0.2)) }

  go() {
    this.tone(220, 0, 0.35, 'sawtooth', 0.06, 880)
    ;[69, 73, 76, 81].forEach((n, i) => this.tone(midi(n), 0.1 + i * 0.07, 0.18, 'triangle', 0.18))
  }

  over() { [67, 64, 60, 55].forEach((n, i) => this.tone(midi(n), i * 0.13, 0.22, 'triangle', 0.18)) }

  best() { [72, 76, 79, 84, 79, 84, 88].forEach((n, i) => this.tone(midi(n), i * 0.09, 0.2, 'triangle', 0.2)) }
}
