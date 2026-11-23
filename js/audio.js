/* audio.js — pulsar sonification (PW.audio).
 *
 * Pure Float32Array DSP (no Web Audio needed to render; the Player is the only
 * browser-only part). Modes:
 *   static  noise x intensity envelope (filview's timeseries_to_audio, tidied)
 *   clicks  one percussive hit per detected pulse (real rotation rate at speed 1)
 *   whistle one musical voice per frequency subband: dispersion becomes audible
 *   melody  one bell/marimba note per pulse, pitch set by pulse strength
 *   sweep   radio frequency -> audio pitch, continuously (a dispersed pulse is a falling glide)
 *
 * All modes are level-matched with the same loudness stage (see finish()).
 */
(function () {
  'use strict';
  const g = (typeof self !== 'undefined') ? self
    : (typeof window !== 'undefined') ? window : globalThis;
  g.PW = g.PW || {};

  const TWO_PI = 2 * Math.PI;
  const TARGET_RMS = 0.12;   // loudness target (see referenceRms), ~ -18 dBFS before per-mode trim

  // ── Public tables ─────────────────────────────────────────────────────────

  /** Plain-language one-line description of each mode (shown to the public). */
  const MODES = {
    static: 'Radio static: the raw hiss of the telescope, getting louder each time the pulsar flashes.',
    clicks: 'Clicks: one tick for every rotation of the star. Fast pulsars blur into a buzzing note.',
    whistle: 'Whistle: each colour of radio light is a note. Spread-out pulses sweep down like a slide whistle; the right DM makes one chord.',
    melody: 'Melody: one note per pulse. Brighter pulses play higher notes, so the star\'s ups and downs become a tune.',
    sweep: 'Radio → sound: the radio frequency of the signal becomes the pitch you hear, so a spread-out pulse falls like a descending whistle and the right DM squeezes it into one short tick.'
  };

  /** Recommended settings per mode (merged under user options by render()). */
  const DEFAULTS = {
    static: { speed: 1, smooth: 1.0, trim: 0.6 },
    clicks: { speed: 1, threshold: 3, hiss: 0.15 },
    whistle: { speed: 0.1, threshold: 3, baseNote: 'A3', octaves: 3, scale: 'pentatonic', hiss: 0.15, reverb: 0.2 },
    melody: { speed: 0.25, threshold: 3, baseNote: 'A3', octaves: 2, scale: 'pentatonic', hiss: 0.1, reverb: 0.25 },
    // voices = radio sub-bands (continuous pitch scale fLow..fHigh Hz, linear in radio frequency)
    sweep: { speed: 0.25, threshold: 3, voices: 96, fLow: 300, fHigh: 2400, hiss: 0.1, reverb: 0.1, refFloor: 0.4 }
  };

  const BASE = {
    mode: 'static', speed: 1, maxDuration: 30, sampleRate: 44100, volume: 0.8,
    threshold: 3, baseNote: 'A3', octaves: 2, scale: 'pentatonic', hiss: 0.15,
    reverb: 0, smooth: 1.0, debug: false, trim: 1
  };

  const SCALES = {
    pentatonic: [0, 2, 4, 7, 9],
    major: [0, 2, 4, 5, 7, 9, 11],
    minor: [0, 2, 3, 5, 7, 8, 10],
    chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    harmonic: [0, 2, 3, 5, 7, 8, 11]
  };

  // ── Small helpers ─────────────────────────────────────────────────────────

  /** Note name ('A2', 'C#4', 'Bb3') or Hz number -> Hz. */
  function noteToHz(n) {
    if (typeof n === 'number') return n;
    const m = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(String(n).trim());
    if (!m) return 220;
    const semis = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1].toUpperCase()]
      + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
    const midi = 12 * (parseInt(m[3], 10) + 1) + semis;
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  /** Ascending list of note frequencies: `octaves` octaves of `scale` plus the top root. */
  function scaleLadder(baseNote, octaves, scale) {
    const deg = SCALES[scale] || SCALES.pentatonic;
    const f0 = noteToHz(baseNote);
    const out = [];
    for (let o = 0; o < octaves; o++) {
      for (let k = 0; k < deg.length; k++) out.push(f0 * Math.pow(2, o + deg[k] / 12));
    }
    out.push(f0 * Math.pow(2, octaves));
    return out;
  }

  /** Robust centre and sigma (median, 1.4826*MAD) from <= 20000 strided samples. */
  function robustStats(x, n) {
    const m = Math.min(n, 20000);
    const step = n / m;
    const tmp = new Float32Array(m);
    let k = 0;
    for (let i = 0; i < m; i++) {
      const v = x[Math.floor(i * step)];
      if (v === v && v !== Infinity && v !== -Infinity) tmp[k++] = v;
    }
    if (k < 2) return { med: 0, sigma: 1 };
    const s = tmp.subarray(0, k).sort();
    const med = s[k >> 1];
    for (let i = 0; i < k; i++) s[i] = Math.abs(s[i] - med);
    s.sort();
    let sigma = 1.4826 * s[k >> 1];
    if (!(sigma > 0)) {            // more than half the samples identical: fall back to std
      let a = 0;
      for (let i = 0; i < k; i++) a += s[i] * s[i];
      sigma = Math.sqrt(a / k);
    }
    return { med, sigma: sigma > 0 ? sigma : 1 };
  }

  /** Centred moving average of width w (prefix sums), non-finite -> 0. */
  function boxcar(x, n, w) {
    const out = new Float32Array(n);
    if (w <= 1) {
      for (let i = 0; i < n; i++) { const v = x[i]; out[i] = (v === v && Math.abs(v) < 1e30) ? v : 0; }
      return out;
    }
    const cs = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) { const v = x[i]; cs[i + 1] = cs[i] + ((v === v && Math.abs(v) < 1e30) ? v : 0); }
    const h = w >> 1;
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - h), b = Math.min(n, a + w);
      out[i] = (cs[b] - cs[a]) / (b - a);
    }
    return out;
  }

  /** In-place robust z-score: (x - median) / sigma. */
  function zscore(x, n) {
    const st = robustStats(x, n);
    const inv = 1 / st.sigma;
    for (let i = 0; i < n; i++) x[i] = (x[i] - st.med) * inv;
    return x;
  }

  /** Deterministic xorshift noise, roughly Gaussian (sum of 4 uniforms), unit variance. */
  function makeNoise(seed) {
    let s = (seed >>> 0) || 2463534242;
    return function () {
      let a = 0;
      for (let k = 0; k < 4; k++) {
        s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
        a += s / 2147483648 - 1;
      }
      return a * 0.8660254;   // sqrt(3)/2: var(sum of 4 U(-1,1)) = 4/3
    };
  }

  /**
   * Resample a data-rate array to the audio rate. Data faster than the audio
   * rate is block-averaged first (anti-alias); then linear interpolation.
   * Audio sample m sits at data index m * speed / (dt * sr).
   */
  function makeResampler(x, nd, dt, speed, sr) {
    const spa = speed / (dt * sr);       // data samples per audio sample
    let src = x, ns = nd, k = 1;
    if (spa > 1.5) {
      k = Math.round(spa);
      ns = Math.floor(nd / k);
      src = new Float32Array(ns);
      for (let b = 0; b < ns; b++) {
        let a = 0;
        for (let j = 0; j < k; j++) a += x[b * k + j];
        src[b] = a / k;
      }
    }
    const off = (k - 1) / 2;
    const at = function (m) {
      if (ns < 1) return 0;
      const p = (m * spa - off) / k;
      if (p <= 0) return src[0];
      if (p >= ns - 1) return src[ns - 1];
      const i = Math.floor(p), f = p - i;
      return src[i] + (src[i + 1] - src[i]) * f;
    };
    at.spa = spa; at.k = k;
    return at;
  }

  function toAudioRate(x, nd, dt, speed, sr, nOut) {
    const at = makeResampler(x, nd, dt, speed, sr), out = new Float32Array(nOut);
    for (let m = 0; m < nOut; m++) out[m] = at(m);
    return out;
  }

  // ── Pulse detection (shared by clicks / melody / events) ──────────────────

  /**
   * Find pulses in a freq-averaged series.
   * With a period: one candidate per rotation (window +-P/2 around the expected
   * arrival, re-centred on each detection), emitted only above `thr` sigma, so
   * nulls stay silent. Without: greedy peak picking with a minimum separation.
   * @returns {{ev: {i:number, z:number}[], zs: Float32Array}}
   */
  function detectPulses(ts, n, dt, period, thr) {
    const w = (period && period / dt >= 6) ? Math.max(1, Math.round(0.03 * period / dt)) : 3;
    const zs = zscore(boxcar(ts, n, w), n);
    const ev = [];
    if (period && period / dt >= 6) {
      const Ps = period / dt;
      // phase of the average profile peak anchors the first window
      const nb = 64, acc = new Float64Array(nb), cnt = new Float64Array(nb);
      for (let i = 0; i < n; i++) {
        const ph = (i / Ps) % 1;
        const b = Math.min(nb - 1, Math.floor(ph * nb));
        acc[b] += zs[i]; cnt[b]++;
      }
      let bb = 0, bv = -Infinity;
      for (let b = 0; b < nb; b++) {
        const v = cnt[b] ? acc[b] / cnt[b] : -Infinity;
        if (v > bv) { bv = v; bb = b; }
      }
      let e = (bb + 0.5) / nb * Ps;
      const half = 0.5 * Ps;
      let last = -Infinity;
      while (e - half < n) {
        const lo = Math.max(0, Math.ceil(e - half));
        const hi = Math.min(n - 1, Math.floor(e + half));
        let bi = -1, bz = -Infinity;
        for (let i = lo; i <= hi; i++) if (zs[i] > bz) { bz = zs[i]; bi = i; }
        if (bi >= 0 && bz > thr && bi - last > 0.25 * Ps) {
          ev.push({ i: bi, z: bz });
          last = bi;
          e = bi;
        }
        e += Ps;
      }
    } else {
      const minSep = Math.max(5, Math.round(0.02 / dt));
      const cand = [];
      for (let i = 1; i < n - 1; i++) {
        if (zs[i] > thr && zs[i] >= zs[i - 1] && zs[i] > zs[i + 1]) cand.push(i);
      }
      cand.sort((a, b) => zs[b] - zs[a]);
      const blocked = new Uint8Array(n);
      for (const i of cand) {
        if (blocked[i]) continue;
        ev.push({ i, z: zs[i] });
        const a = Math.max(0, i - minSep), b = Math.min(n - 1, i + minSep);
        for (let j = a; j <= b; j++) blocked[j] = 1;
      }
      ev.sort((a, b) => a.i - b.i);
    }
    return { ev, zs };
  }

  // ── Output stage: loudness match, bed, limiter, DC block, fades ───────────

  /**
   * Reference level of a buffer: geometric mean of the 95th-percentile 100 ms-window
   * RMS (how loud it is while sounding) and the RMS of the "active" windows (> 10 %
   * of that), so sparse chords/ticks are not boosted all the way to their peak level.
   */
  function referenceRms(buf, sr) {
    const win = Math.max(256, Math.round(0.1 * sr));
    const nw = Math.floor(buf.length / win);
    if (nw < 2) {
      let a = 0;
      for (let i = 0; i < buf.length; i++) a += buf[i] * buf[i];
      return Math.sqrt(a / Math.max(1, buf.length));
    }
    const r = new Float32Array(nw);
    for (let w = 0; w < nw; w++) {
      let a = 0;
      for (let i = w * win, e = i + win; i < e; i++) a += buf[i] * buf[i];
      r[w] = Math.sqrt(a / win);
    }
    const s = r.slice().sort();
    const p95 = s[Math.min(nw - 1, Math.floor(0.95 * nw))];
    let q = 0, k = 0;
    for (let w = 0; w < nw; w++) if (r[w] > 0.1 * p95) { q += r[w] * r[w]; k++; }
    const act = k ? Math.sqrt(q / k) : p95;
    return Math.sqrt(p95 * act);
  }

  function softClip(x) {   // linear to 0.6, then smooth saturation towards 0.95
    const a = x < 0 ? -x : x;
    if (a <= 0.6) return x;
    const y = 0.6 + 0.35 * Math.tanh((a - 0.6) / 0.35);
    return x < 0 ? -y : y;
  }

  /**
   * Common mastering stage. `buf` is the dry mix (any scale); returns the final
   * buffer in place: gain to TARGET_RMS, optional quiet hiss bed, soft limiter,
   * DC blocker, short fades, volume. Output peak is always < 0.96*volume.
   */
  function finish(buf, o, bedOn) {
    const n = buf.length, sr = o.sampleRate;
    for (let i = 0; i < n; i++) { const v = buf[i]; if (!(v === v) || v > 1e30 || v < -1e30) buf[i] = 0; }
    // refFloor: never boost a buffer whose reference level is below it (noise-only input stays quiet)
    const r = Math.max(referenceRms(buf, sr), o.refFloor || 0);
    const gain = r > 1e-9 ? Math.min(1e4, TARGET_RMS * (o.trim || 1) / r) : 1;
    for (let i = 0; i < n; i++) buf[i] *= gain;
    if (bedOn && o.hiss > 0) {
      const rng = makeNoise(777), bed = new Float32Array(n);
      let lp = 0, q = 0;
      for (let i = 0; i < n; i++) { lp += 0.2 * (rng() - lp); bed[i] = lp; q += lp * lp; }
      const sc = (o.hiss * TARGET_RMS * 0.8) / Math.sqrt(q / Math.max(1, n) + 1e-20);
      for (let i = 0; i < n; i++) buf[i] += bed[i] * sc;
    }
    // soft limit + DC blocker (R = 0.9985 -> ~10 Hz corner)
    let x1 = 0, y1 = 0;
    for (let i = 0; i < n; i++) {
      const x = softClip(buf[i]);
      let y = x - x1 + 0.9985 * y1;
      if (y > -1e-20 && y < 1e-20) y = 0;
      x1 = x; y1 = y;
      buf[i] = y;
    }
    const fi = Math.min(n >> 1, Math.round(0.005 * sr)), fo = Math.min(n >> 1, Math.round(0.03 * sr));
    for (let i = 0; i < fi; i++) buf[i] *= 0.5 - 0.5 * Math.cos(Math.PI * i / fi);
    for (let i = 0; i < fo; i++) buf[n - 1 - i] *= 0.5 - 0.5 * Math.cos(Math.PI * i / fo);
    const vol = Math.max(0, Math.min(1, o.volume));
    for (let i = 0; i < n; i++) buf[i] *= vol;
    return buf;
  }

  /** Small Schroeder reverb (4 combs + 2 allpass), mixed in place. mix 0..1. */
  function reverb(buf, sr, mix) {
    if (!(mix > 0)) return buf;
    const n = buf.length, k = sr / 44100;
    const combD = [1557, 1617, 1491, 1422].map(d => Math.round(d * k));
    const apD = [225, 556].map(d => Math.round(d * k));
    const wet = new Float32Array(n);
    for (const d of combD) {
      const line = new Float32Array(d);
      let p = 0, lp = 0;
      for (let i = 0; i < n; i++) {
        const y = line[p];
        lp += 0.65 * (y - lp);                 // damping
        line[p] = buf[i] * 0.3 + lp * 0.82;
        wet[i] += y * 0.25;
        if (++p === d) p = 0;
      }
    }
    for (const d of apD) {
      const line = new Float32Array(d);
      let p = 0;
      for (let i = 0; i < n; i++) {
        const z = line[p], x = wet[i];
        const v = x + 0.5 * z;
        line[p] = v;
        wet[i] = z - 0.5 * v;
        if (++p === d) p = 0;
      }
    }
    for (let i = 0; i < n; i++) buf[i] = buf[i] * (1 - 0.4 * mix) + wet[i] * mix * 3;
    return buf;
  }

  // ── Mode: static ──────────────────────────────────────────────────────────

  function renderStatic(c, o) {
    const n = c.nAudio;
    // envelope: min..max normalised like filview, but with a robust floor so
    // a single glitch does not flatten everything
    const lo = (function () {
      const st = robustStats(c.ts, c.nd);
      return st.med - 3 * st.sigma;
    })();
    let mx = -Infinity, mn = Infinity;
    for (let i = 0; i < c.nd; i++) { const v = c.ts[i]; if (v === v) { if (v > mx) mx = v; if (v < mn) mn = v; } }
    const floor = Math.max(mn, lo);
    const span = (mx - floor) > 0 ? (mx - floor) : 1;
    const e0 = new Float32Array(c.nd);
    for (let i = 0; i < c.nd; i++) {
      const v = c.ts[i];
      e0[i] = (v === v) ? Math.max(0, (v - floor) / span) : 0;
    }
    const env = toAudioRate(e0, c.nd, c.dt, c.speed, c.sr, n);
    const a = o.smooth > 0 ? 1 - Math.exp(-1 / (o.smooth * 1e-3 * c.sr)) : 1;
    const rng = makeNoise(12345), out = new Float32Array(n);
    let s = 0;
    for (let i = 0; i < n; i++) {
      s += a * (env[i] - s);
      out[i] = rng() * s;
    }
    return out;
  }

  // ── Mode: clicks ──────────────────────────────────────────────────────────

  let NOISE_TAB = null;
  function noiseTable() {
    if (NOISE_TAB) return NOISE_TAB;
    const N = 8192, t = new Float32Array(N), rng = makeNoise(99);
    let lp = 0, q = 0;
    for (let i = 0; i < N; i++) { lp += 0.5 * (rng() - lp); t[i] = lp; q += lp * lp; }
    const sc = 1 / Math.sqrt(q / N);
    for (let i = 0; i < N; i++) t[i] *= sc;
    NOISE_TAB = t;
    return t;
  }

  /** Typical audio-domain spacing between pulses (s). */
  function pulseInterval(c, events) {
    if (c.period) return c.period / c.speed;
    if (events.length < 2) return 1;
    const d = [];
    for (let i = 1; i < events.length; i++) d.push(events[i].t - events[i - 1].t);
    d.sort((a, b) => a - b);
    return d[d.length >> 1];
  }

  /** Percussive hit: pitch-dropping sine thump + short filtered-noise tick. */
  function addHit(buf, tPos, amp, Lsec, sr) {
    const tab = noiseTable(), mask = tab.length - 1;
    const n0 = Math.ceil(tPos), nL = Math.floor(Lsec * sr);
    const tauA = Lsec / 5, tauF = 0.03, tauN = Math.min(0.004, Lsec * 0.25);
    const fs = 190, fe = 65, att = 0.0004, fadeStart = 0.85 * Lsec;
    for (let k = 0; k < nL; k++) {
      const idx = n0 + k;
      if (idx < 0 || idx >= buf.length) continue;
      const tt = (idx - tPos) / sr;
      let g = Math.exp(-tt / tauA);
      if (tt < att) g *= 0.5 - 0.5 * Math.cos(Math.PI * tt / att);
      if (tt > fadeStart) g *= 0.5 + 0.5 * Math.cos(Math.PI * (tt - fadeStart) / (Lsec - fadeStart));
      const ph = TWO_PI * (fe * tt + (fs - fe) * tauF * (1 - Math.exp(-tt / tauF)));
      const thump = Math.sin(ph);
      const tick = tab[k & mask] * Math.exp(-tt / tauN);
      buf[idx] += amp * g * (0.8 * thump + (tt < att ? 0 : 0.45 * tick));
    }
  }

  function strengthAmps(events) {
    const s = events.map(e => e.strength).sort((a, b) => a - b);
    const ref = s.length ? s[Math.min(s.length - 1, Math.floor(0.9 * s.length))] : 1;
    return events.map(e => Math.max(0.25, Math.min(1, Math.sqrt(e.strength / ref))));
  }

  function renderClicks(c, o, events) {
    const buf = new Float32Array(c.nAudio);
    const interval = pulseInterval(c, events);
    const L = Math.max(0.0015, Math.min(0.25, 0.7 * interval));
    const amps = strengthAmps(events);
    for (let k = 0; k < events.length; k++) addHit(buf, events[k].t * c.sr, amps[k], L, c.sr);
    return buf;
  }

  // ── Mode: melody ──────────────────────────────────────────────────────────

  const PARTIALS = [[1, 1.0, 1.0], [4, 0.30, 0.30], [10, 0.10, 0.10]];  // marimba-like 1:4:10

  function addNote(buf, tPos, f, amp, tau, sr) {
    const nL = Math.floor(5 * tau * sr), n0 = Math.ceil(tPos);
    if (n0 >= buf.length) return;
    const attN = Math.max(2, Math.round(0.002 * sr));
    const frac = n0 - tPos;                              // sub-sample start offset
    for (const [ratio, pa, pd] of PARTIALS) {
      const fp = f * ratio;
      if (fp > 0.45 * sr) continue;
      const w = TWO_PI * fp / sr, cw = Math.cos(w), sw = Math.sin(w);
      const d = Math.exp(-1 / (tau * pd * sr));
      let c = Math.cos(w * frac), s = Math.sin(w * frac), dec = 1;
      const a = amp * pa;
      for (let k = 0; k < nL; k++) {
        const idx = n0 + k;
        if (idx >= buf.length) break;
        const ramp = k < attN ? 0.5 - 0.5 * Math.cos(Math.PI * k / attN) : 1;
        buf[idx] += a * s * dec * ramp;
        const cn = c * cw - s * sw;
        s = s * cw + c * sw; c = cn;
        dec *= d;
        if (dec < 1e-5) break;
      }
    }
  }

  function renderMelody(c, o, events) {
    const buf = new Float32Array(c.nAudio);
    const ladder = scaleLadder(o.baseNote, o.octaves, o.scale);
    const interval = pulseInterval(c, events);
    const tau = Math.max(0.05, Math.min(0.4, 0.6 * interval));
    // quantile mapping: rank of strength among all pulses -> scale degree
    const idx = events.map((e, i) => i).sort((a, b) => events[a].strength - events[b].strength);
    const amps = strengthAmps(events);
    const m = events.length;
    for (let r = 0; r < m; r++) {
      const k = idx[r];
      const deg = m > 1 ? Math.round(r / (m - 1) * (ladder.length - 1)) : (ladder.length >> 1);
      events[k].pitch = ladder[deg];
    }
    for (let k = 0; k < m; k++) {
      addNote(buf, events[k].t * c.sr, events[k].pitch, 0.5 + 0.5 * amps[k], tau, c.sr);
    }
    return buf;
  }

  // ── Mode: whistle ─────────────────────────────────────────────────────────

  const TAB_N = 4096;
  let TABLES = null;
  function waveTables() {
    if (TABLES) return TABLES;
    // sine, sine+2nd, sine+2nd+3rd; each guard-point extended and peak-normalised
    const defs = [[1], [1, 0.22], [1, 0.22, 0.08]];
    TABLES = defs.map(h => {
      const t = new Float32Array(TAB_N + 1);
      let mx = 0;
      for (let i = 0; i <= TAB_N; i++) {
        let v = 0;
        for (let k = 0; k < h.length; k++) v += h[k] * Math.sin(TWO_PI * (k + 1) * i / TAB_N);
        t[i] = v; if (Math.abs(v) > mx) mx = Math.abs(v);
      }
      for (let i = 0; i <= TAB_N; i++) t[i] /= mx;
      return t;
    });
    return TABLES;
  }

  /** Group sub.ny rows into nV voices (mean of contiguous rows), LOW->HIGH. */
  function groupSubbands(sub, n, nV) {
    const out = [];
    for (let v = 0; v < nV; v++) {
      const r0 = Math.floor(v * sub.ny / nV), r1 = Math.max(r0 + 1, Math.floor((v + 1) * sub.ny / nV));
      const row = new Float32Array(n);
      for (let r = r0; r < r1; r++) {
        const base = r * sub.nx;
        for (let i = 0; i < n; i++) row[i] += sub.grid[base + i];
      }
      const inv = 1 / (r1 - r0);
      for (let i = 0; i < n; i++) row[i] *= inv;
      out.push(row);
    }
    return out;
  }

  function renderWhistle(c, o, result) {
    const sub = c.sub, n = c.nd, sr = c.sr, nA = c.nAudio;
    const out = new Float32Array(nA);
    const ladder = scaleLadder(o.baseNote, o.octaves, o.scale);
    const nV = Math.min(sub.ny, ladder.length);
    // voice j -> note: spread evenly over the ladder, low radio freq = low pitch
    const freqs = [];
    for (let j = 0; j < nV; j++) freqs.push(ladder[nV > 1 ? Math.round(j * (ladder.length - 1) / (nV - 1)) : 0]);
    const rows = groupSubbands(sub, n, nV);
    const w = (c.period && c.period / c.dt >= 6) ? Math.max(1, Math.round(0.03 * c.period / c.dt)) : 3;
    const thr = o.threshold, kc = 1.5 * Math.max(thr, 1);
    const tabs = waveTables();
    const aAtt = 1 - Math.exp(-1 / (0.003 * sr)), aRel = 1 - Math.exp(-1 / (0.08 * sr));
    const env = new Float32Array(nA), blk = 128;
    if (o.debug) result.voices = { freqs, env: [], dtData: c.dt };
    for (let j = 0; j < nV; j++) {
      const z = zscore(boxcar(rows[j], n, w), n);
      for (let i = 0; i < n; i++) {                     // soft gate on z - threshold
        const u = z[i] - thr;
        z[i] = u > 0 ? 1 - Math.exp(-u / kc) : 0;
      }
      if (o.debug) result.voices.env.push(z.slice());
      const tgt = toAudioRate(z, n, c.dt, c.speed, sr, nA);
      let y = 0;
      for (let i = 0; i < nA; i++) {                    // attack/release smoothing
        const t = tgt[i] > 0 ? tgt[i] : 0;
        y += (t > y ? aAtt : aRel) * (t - y);
        if (y < 1e-6 && t === 0) y = 0;
        env[i] = y;
      }
      const f = freqs[j], inc = f / sr;
      const tab = (3 * f < 0.45 * sr) ? tabs[2] : (2 * f < 0.45 * sr) ? tabs[1] : tabs[0];
      const wgt = 1 / Math.pow(Math.max(f, 100) / 440, 0.15);   // mild equal-loudness tilt
      let ph = (j * 0.37) % 1;
      for (let b = 0; b < nA; b += blk) {
        const e = Math.min(nA, b + blk);
        let mxv = 0;
        for (let i = b; i < e; i++) if (env[i] > mxv) mxv = env[i];
        if (mxv === 0) { ph = (ph + inc * (e - b)) % 1; continue; }
        for (let i = b; i < e; i++) {
          const p = ph * TAB_N, i0 = p | 0, fr = p - i0;
          out[i] += wgt * env[i] * (tab[i0] + (tab[i0 + 1] - tab[i0]) * fr);
          ph += inc; if (ph >= 1) ph -= 1;
        }
      }
    }
    return out;
  }

  // ── Mode: sweep (radio frequency -> audio frequency) ─────────────────────

  /**
   * nV band rows (LOW->HIGH radio frequency, same order as sub.grid: row 0 = lowest).
   * More input rows than voices: contiguous means. Fewer: linear interpolation between rows.
   */
  function bandRows(sub, n, nV) {
    if (sub.ny >= nV) return groupSubbands(sub, n, nV);
    const out = [];
    for (let j = 0; j < nV; j++) {
      const p = Math.max(0, Math.min(sub.ny - 1, (j + 0.5) * sub.ny / nV - 0.5));
      const r0 = Math.min(sub.ny - 1, Math.floor(p)), r1 = Math.min(sub.ny - 1, r0 + 1), f = p - r0;
      const row = new Float32Array(n);
      for (let i = 0; i < n; i++) row[i] = sub.grid[r0 * sub.nx + i] * (1 - f) + sub.grid[r1 * sub.nx + i] * f;
      out.push(row);
    }
    return out;
  }

  /**
   * One sine per radio sub-band at f = fLow + (fHigh - fLow) * (nu - nuLow)/(nuHigh - nuLow): pitch is an
   * affine function of radio frequency, so the nu^-2 dispersion delay is heard as the same curve in
   * pitch-versus-time. Envelopes are as for the whistle (robust z, soft gate) but with a short release
   * (25 ms) so the glide does not smear into its own tail. Fixed random phases avoid a phase-locked comb.
   */
  function renderSweep(c, o, result) {
    const sub = c.sub, n = c.nd, sr = c.sr, nA = c.nAudio;
    const out = new Float32Array(nA);
    const nV = Math.max(2, Math.round(o.voices) || 96);
    const fLo = o.fLow, fHi = Math.min(o.fHigh, 0.45 * sr);
    const freqs = [];
    for (let j = 0; j < nV; j++) freqs.push(fLo + (fHi - fLo) * (j + 0.5) / nV);
    const rows = bandRows(sub, n, nV);
    const w = (c.period && c.period / c.dt >= 6) ? Math.max(1, Math.round(0.03 * c.period / c.dt)) : 3;
    const thr = o.threshold, kc = 1.5 * Math.max(thr, 1);
    // envelope smoother runs at control rate (every blk samples) with amplitude ramped linearly inside the block
    const blk = 32, aAtt = 1 - Math.exp(-blk / (0.003 * sr)), aRel = 1 - Math.exp(-blk / (0.025 * sr));
    const rng = makeNoise(4242);
    if (o.debug) result.voices = { freqs, env: [], dtData: c.dt };
    for (let j = 0; j < nV; j++) {
      const z = zscore(boxcar(rows[j], n, w), n);
      for (let i = 0; i < n; i++) {
        const u = z[i] - thr;
        z[i] = u > 0 ? 1 - Math.exp(-u / kc) : 0;
      }
      if (o.debug) result.voices.env.push(z.slice());
      // block-wise: blocks where the gated data is zero and the smoother has decayed cost nothing
      const at = makeResampler(z, n, c.dt, c.speed, sr), spa = at.spa, pad = at.k + 2;
      const cum = new Uint32Array(n + 1);
      for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + (z[i] > 0 ? 1 : 0);
      const f = freqs[j];
      const wgt = Math.pow(f / 1000, -0.25);            // mild equal-loudness tilt (ear is less sensitive low)
      const ph0 = TWO_PI * rng(), wr = TWO_PI * f / sr, cw = Math.cos(wr), sw = Math.sin(wr);
      let sn = Math.sin(ph0), cs = Math.cos(ph0);       // oscillator state: rotated by wr each sample
      let y = 0;
      for (let b = 0; b < nA; b += blk) {
        const e = Math.min(nA, b + blk);
        const lo = Math.max(0, Math.floor(b * spa) - pad), hi = Math.min(n, Math.ceil(e * spa) + pad);
        if (y < 1e-6 && cum[hi] === cum[lo]) {          // silent block: just advance the phase
          y = 0;
          const a = wr * (e - b), ca = Math.cos(a), sa = Math.sin(a), s2 = sn * ca + cs * sa;
          cs = cs * ca - sn * sa; sn = s2;
          continue;
        }
        const t = at(Math.min(nA - 1, b + (blk >> 1))), y0 = y;
        y += (t > y ? aAtt : aRel) * (t - y);
        const dy = wgt * (y - y0) / (e - b);
        let amp = wgt * y0;
        for (let i = b; i < e; i++) {
          amp += dy;
          out[i] += amp * sn;
          const s2 = sn * cw + cs * sw;
          cs = cs * cw - sn * sw; sn = s2;
        }
        const r = 1.5 - 0.5 * (sn * sn + cs * cs);       // keep |(cs,sn)| = 1
        sn *= r; cs *= r;
      }
    }
    return out;
  }

  // ── render() ──────────────────────────────────────────────────────────────

  /**
   * Render sonification. See SPEC section C.
   * @param {{ts:Float32Array, dt:number, sub:{grid:Float32Array,nx:number,ny:number}|null, period:number|null}} input
   * @param {object} opts  mode, speed, maxDuration, sampleRate, volume, threshold, baseNote,
   *   octaves, scale, hiss, reverb (0..1), smooth (ms, static), debug
   * @returns {{samples:Float32Array, sampleRate:number, duration:number, speed:number, dataDuration:number,
   *   events:{t:number,tData:number,strength:number,pitch?:number}[]}}
   *   events: t = seconds into the AUDIO, tData = seconds into the rendered DATA (= t*speed);
   *   strength in sigma. Playhead data time = viewStart + position*speed.
   */
  function render(input, opts) {
    opts = opts || {};
    const mode = MODES[opts.mode] ? opts.mode : 'static';
    const o = Object.assign({}, BASE, DEFAULTS[mode], opts, { mode });
    o.speed = Math.max(0.01, Math.min(1, +o.speed || 1));
    o.sampleRate = Math.round(o.sampleRate) || 44100;
    o.volume = (o.volume === undefined || o.volume === null) ? 0.8 : o.volume;
    const sr = o.sampleRate, dt = input.dt;

    // series used for envelopes / pulse detection: ts, else mean of subbands
    let ts = input.ts, sub = input.sub || null;
    let nd = ts ? ts.length : 0;
    if (sub) nd = ts ? Math.min(nd, sub.nx) : sub.nx;
    if (!ts && sub) {
      ts = new Float32Array(sub.nx);
      for (let r = 0; r < sub.ny; r++) for (let i = 0; i < sub.nx; i++) ts[i] += sub.grid[r * sub.nx + i] / sub.ny;
    }
    nd = Math.min(nd, Math.floor(o.maxDuration * o.speed / dt));
    const silent = { samples: new Float32Array(Math.round(0.1 * sr)), sampleRate: sr, duration: 0.1, speed: o.speed, dataDuration: 0, events: [] };
    if (!ts || nd < 4 || !(dt > 0)) return silent;
    if ((mode === 'whistle' || mode === 'sweep') && !sub) o.mode = 'clicks';   // no subbands: degrade gracefully

    const nAudio = Math.max(1, Math.floor(nd * dt / o.speed * sr));
    const c = { ts, nd, dt, sub, period: input.period > 0 ? input.period : null, speed: o.speed, sr, nAudio };

    // pulses (also reported as events for playhead flashes)
    const det = detectPulses(ts, nd, dt, c.period, o.threshold);
    const events = det.ev.map(e => ({ t: e.i * dt / o.speed, tData: e.i * dt, strength: e.z }))
      .filter(e => e.t < nAudio / sr);

    const result = { sampleRate: sr, speed: o.speed, dataDuration: nd * dt, events };
    let buf, bed = true;
    switch (o.mode) {
      case 'clicks': buf = renderClicks(c, o, events); break;
      case 'melody': buf = renderMelody(c, o, events); reverb(buf, sr, o.reverb); break;
      case 'whistle': buf = renderWhistle(c, o, result); reverb(buf, sr, o.reverb); break;
      case 'sweep': buf = renderSweep(c, o, result); reverb(buf, sr, o.reverb); break;
      default: buf = renderStatic(c, o); bed = false;
    }
    if (o.debug) result.refRms = referenceRms(buf, sr);
    result.samples = finish(buf, o, bed);
    result.duration = nAudio / sr;
    return result;
  }

  /**
   * Suggest a playback speed so pulses are spaced comfortably in audio time.
   * clicks: real time (1); melody/sweep: ~0.35 s per pulse; whistle: ~0.9 s per sweep.
   */
  function suggestSpeed(mode, period) {
    const d = DEFAULTS[mode] || DEFAULTS.static;
    if (!(period > 0)) return d.speed;
    // sweep: 0.35 s between pulses -> Vela x0.26 (glide ~1.1 s), J0437 x0.016 (glide ~0.7 s)
    const target = (mode === 'melody' || mode === 'sweep') ? 0.35 : mode === 'whistle' ? 0.9 : 0;
    if (!target) return d.speed;
    return Math.max(0.01, Math.min(1, period / target));
  }

  // ── WAV ───────────────────────────────────────────────────────────────────

  /** Mono 16-bit PCM WAV as ArrayBuffer. */
  function toWAV(samples, sampleRate) {
    const n = samples.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true);
    v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      v.setInt16(44 + i * 2, Math.round(s < 0 ? s * 32768 : s * 32767), true);
    }
    return buf;
  }

  // ── Player (browser only) ─────────────────────────────────────────────────

  /**
   * Plays rendered audio through one shared AudioContext (created lazily, so
   * call play() from a user gesture). position() = seconds into the rendered
   * audio; data time = viewStart + position()*rendered.speed.
   */
  class Player {
    constructor() {
      this.ctx = null; this.src = null; this.rendered = null;
      this.startedAt = 0; this.offset = 0; this.loop = false;
      this._playing = false; this.onended = null;
    }
    get isPlaying() { return this._playing; }
    _ensure() {
      if (this.ctx) return this.ctx;
      const AC = g.AudioContext || g.webkitAudioContext;
      if (!AC) throw new Error('Web Audio not available');
      this.ctx = new AC({ sampleRate: undefined });
      return this.ctx;
    }
    /** Start playback of a render() result. opts: { loop, offset (s) }. */
    play(rendered, opts) {
      opts = opts || {};
      const ctx = this._ensure();
      this.stop(true);
      if (ctx.state === 'suspended') ctx.resume();
      const buf = ctx.createBuffer(1, rendered.samples.length, rendered.sampleRate);
      buf.copyToChannel(rendered.samples, 0);
      const src = ctx.createBufferSource();
      src.buffer = buf; src.loop = !!opts.loop;
      src.connect(ctx.destination);
      const off = Math.max(0, Math.min(rendered.duration, opts.offset || 0));
      src.onended = () => {
        if (this.src !== src) return;                 // replaced by a newer play()
        this._playing = false; this.src = null;
        if (this.onended) this.onended();
      };
      this.rendered = rendered; this.loop = !!opts.loop; this.offset = off;
      this.startedAt = ctx.currentTime; this.src = src; this._playing = true;
      src.start(0, off);
    }
    /** Stop playback (does not fire onended when `silent`). */
    stop(silent) {
      if (!this.src) { this._playing = false; return; }
      const s = this.src;
      this.src = null; this._playing = false;
      s.onended = null;
      try { s.stop(); } catch (e) { /* already stopped */ }
      try { s.disconnect(); } catch (e) { /* ignore */ }
      if (!silent && this.onended) this.onended();
    }
    /** Seconds into the rendered audio (wraps when looping). */
    position() {
      if (!this.ctx || !this.rendered) return 0;
      if (!this._playing) return this.offset;
      const d = this.rendered.duration;
      let p = this.offset + (this.ctx.currentTime - this.startedAt);
      if (this.loop && d > 0) p = p % d;
      return Math.min(p, d);
    }
  }

  g.PW.audio = { render, toWAV, suggestSpeed, Player, MODES, DEFAULTS, SCALES, noteToHz, scaleLadder };
})();
