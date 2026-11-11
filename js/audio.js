/**
 * PANODROME — Stage 1.5 · Warm Acoustic Audio Engine
 *
 * SOUND LAW (locked 2026-11-02, Stage 1.5 — replaces the banned Stage-1-era
 * oscillator "dug-dug"):
 *   · NEVER a naked oscillator knock. Every step is a FILTERED ACOUSTIC
 *     transient: a low-passed noise body (< 180 Hz cutoff) + a whisper of
 *     air, with an optional very quiet sub-support sine (< 180 Hz) that
 *     decays in ~70 ms — a soft velvet thump, not a click.
 *   · Footsteps fire every 0.65 m of REAL camera travel (controls.js law).
 *   · Ambience = a gentle filtered air bed per room (no clinks, no chirps,
 *     no looping tones) at very low gain.
 *   · Bump = one soft low thud on real collisions (rate-limited).
 *   · 🔊 / 🔇 toggle in the HUD; choice remembered in localStorage.
 */
const MASTER = 0.9;
const STEP_GAIN = 0.15;      // noise body of a footstep
const SUB_GAIN = 0.05;       // quiet sub-support (< 180 Hz velvet thump)
const AMBIENCE_GAIN = 0.05;  // gentle acoustic air
const BUMP_GAIN = 0.12;

function brownBuffer(ctx, seconds = 4) {
  const n = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1;
    last = (last + 0.02 * w) / 1.02;
    d[i] = last * 3.5;
  }
  return buf;
}
function pinkBuffer(ctx, seconds = 4) {
  const n = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.997 * b0 + 0.0299 * w;
    b1 = 0.985 * b1 + 0.0563 * w;
    b2 = 0.95 * b2 + 0.115 * w;
    d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.4;
  }
  return buf;
}

/** Per-material soft step tuning: everything low-passed, never clicky. */
const MATERIALS = {
  wood:     { body: 155, air: 480,  bodyGain: 1.0,  decay: 0.095 },
  stone:    { body: 170, air: 420,  bodyGain: 0.95, decay: 0.075 },
  concrete: { body: 160, air: 380,  bodyGain: 1.0,  decay: 0.085 },
  carpet:   { body: 110, air: 300,  bodyGain: 0.62, decay: 0.12 },
  gravel:   { body: 150, air: 650,  bodyGain: 0.9,  decay: 0.11 },
  grass:    { body: 130, air: 550,  bodyGain: 0.7,  decay: 0.12 },
};

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.muted = localStorage.getItem("panodrome_sound") === "off";
    this._ambience = null;
    this._room = null;
    this._lastBump = 0;
    this._alt = 1;
    this.onMuteChange = null;
  }

  /** Must be called from a user gesture (the intro Enter button). */
  unlock() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!this.ctx) {
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : MASTER;
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -20;
      comp.ratio.value = 5;
      this.master.connect(comp).connect(this.ctx.destination);
      this._brown = brownBuffer(this.ctx);
      this._pink = pinkBuffer(this.ctx);
      if (this._room) this.setRoom(this._room);
    }
    this.ctx.resume?.();
  }

  get ready() { return !!this.ctx; }

  setMuted(m) {
    this.muted = m;
    localStorage.setItem("panodrome_sound", m ? "off" : "on");
    if (this.ctx) {
      const t = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.setTargetAtTime(m ? 0 : MASTER, t, 0.05);
    }
    this.onMuteChange && this.onMuteChange(m);
  }

  /* ------------------------------------------------------------ ambience */

  setRoom(profile) {
    this._room = profile;
    if (!this.ctx) return;
    this._clearAmbience();

    const g = this.ctx.createGain();
    g.gain.value = 0;
    g.connect(this.master);
    const nodes = [g];

    const amb = profile.ambient || "room_tone";
    const src = this.ctx.createBufferSource();
    src.buffer = amb === "city_hum" || amb === "cellar_drip" ? this._brown : this._pink;
    src.loop = true;
    const lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value =
      amb === "hall_air" ? 240 :
      amb === "city_hum" ? 210 :
      amb === "birds_wind" ? 520 :
      amb === "cellar_drip" ? 300 : 380;
    lp.Q.value = 0.4;
    const gain = this.ctx.createGain();
    gain.gain.value =
      amb === "hall_air" ? 1.15 :
      amb === "birds_wind" ? 1.25 :
      amb === "cellar_drip" ? 0.9 : 1.0;
    // slow breathing — the air in the room gently swells
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 0.06 + Math.random() * 0.04;
    const lfoG = this.ctx.createGain();
    lfoG.gain.value = AMBIENCE_GAIN * 0.3;
    lfo.connect(lfoG).connect(gain.gain);
    lfo.start();
    src.connect(lp).connect(gain).connect(g);
    src.start();
    nodes.push(src, lp, gain, lfo, lfoG);

    g.gain.linearRampToValueAtTime(AMBIENCE_GAIN, this.ctx.currentTime + 1.6);
    this._ambience = { nodes, gain: g };
  }

  _clearAmbience() {
    if (!this._ambience) return;
    const { nodes, gain } = this._ambience;
    const t = this.ctx.currentTime;
    gain.gain.cancelScheduledValues(t);
    gain.gain.setTargetAtTime(0, t, 0.25);
    const a = this._ambience;
    setTimeout(() => {
      for (const n of a.nodes) { try { n.stop?.(); } catch (e) {} try { n.disconnect(); } catch (e) {} }
    }, 900);
    this._ambience = null;
  }

  /* ------------------------------------------------------------ footsteps */

  /** One soft step. Called by controls.js every 0.65 m of real travel. */
  step(material) {
    if (!this.ctx || this.muted) return;
    const m = MATERIALS[material] || MATERIALS.wood;
    const t = this.ctx.currentTime;
    this._alt = -this._alt;                       // alternate feet L/R
    const vol = 0.9 + Math.random() * 0.25;

    const pan = new StereoPannerNode(this.ctx, { pan: 0.22 * this._alt });
    pan.connect(this.master);
    if (this._room?.reverb) {
      // a whisper of room air behind the step
      const send = this.ctx.createGain();
      send.gain.value = 0.10 * this._room.reverb;
      const lpSend = this.ctx.createBiquadFilter();
      lpSend.type = "lowpass";
      lpSend.frequency.value = 300;
      pan.connect(send).connect(lpSend).connect(this.master);
    }

    // body: low-passed noise thump (the velvet footfall, < 180 Hz)
    const src = this.ctx.createBufferSource();
    src.buffer = this._brown;
    src.playbackRate.value = 0.9 + Math.random() * 0.2;
    const lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = m.body;
    lp.Q.value = 0.7;
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(STEP_GAIN * m.bodyGain * vol, t + 0.007);
    env.gain.exponentialRampToValueAtTime(0.0001, t + m.decay + 0.05);
    src.connect(lp).connect(env).connect(pan);
    src.start(t, Math.random() * 2);
    src.stop(t + m.decay + 0.1);

    // air: a tiny soft hiss of the shoe (very quiet, band-limited)
    const air = this.ctx.createBufferSource();
    air.buffer = this._pink;
    const bp = this.ctx.createBiquadFilter();
    bp.type = "lowpass";
    bp.frequency.value = m.air;
    const airEnv = this.ctx.createGain();
    airEnv.gain.setValueAtTime(0, t);
    airEnv.gain.linearRampToValueAtTime(0.028 * m.bodyGain * vol, t + 0.006);
    airEnv.gain.exponentialRampToValueAtTime(0.0001, t + 0.055);
    air.connect(bp).connect(airEnv).connect(pan);
    air.start(t, Math.random() * 2);
    air.stop(t + 0.09);

    // sub support: one very quiet low sine swelling through the same envelope
    const sub = this.ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.setValueAtTime(64, t);
    sub.frequency.exponentialRampToValueAtTime(42, t + 0.07);
    const subEnv = this.ctx.createGain();
    subEnv.gain.setValueAtTime(0, t);
    subEnv.gain.linearRampToValueAtTime(SUB_GAIN * vol, t + 0.01);
    subEnv.gain.exponentialRampToValueAtTime(0.0001, t + 0.075);
    sub.connect(subEnv).connect(pan);
    sub.start(t);
    sub.stop(t + 0.1);
  }

  /* ------------------------------------------------------------ bump thud */

  /** Soft low thud when the player physically hits furniture or a wall. */
  bump() {
    if (!this.ctx || this.muted) return;
    const now = performance.now();
    if (now - this._lastBump < 600) return;       // rate limit
    this._lastBump = now;

    const t = this.ctx.currentTime;
    const out = this.ctx.createGain();
    out.gain.value = 1;
    out.connect(this.master);

    const src = this.ctx.createBufferSource();
    src.buffer = this._brown;
    const lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 130;
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(BUMP_GAIN, t + 0.008);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
    src.connect(lp).connect(env).connect(out);
    src.start(t, Math.random() * 2);
    src.stop(t + 0.2);

    const sub = this.ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.setValueAtTime(58, t);
    sub.frequency.exponentialRampToValueAtTime(36, t + 0.11);
    const subEnv = this.ctx.createGain();
    subEnv.gain.setValueAtTime(0, t);
    subEnv.gain.linearRampToValueAtTime(0.07, t + 0.009);
    subEnv.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
    sub.connect(subEnv).connect(out);
    sub.start(t);
    sub.stop(t + 0.16);
  }

  /* ------------------------------------------------------------ transition */

  /** Gentle low-passed air swell for the door warp (no whoosh screech). */
  warp() {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this._pink;
    const lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(240, t);
    lp.frequency.exponentialRampToValueAtTime(900, t + 0.7);
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(0.09, t + 0.4);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.85);
    src.connect(lp).connect(env).connect(this.master);
    src.start(t);
    src.stop(t + 0.9);
  }

  dispose() {
    this._clearAmbience();
    this.ctx?.close?.();
    this.ctx = null;
  }
}
