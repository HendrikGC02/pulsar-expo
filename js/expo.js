// expo.js — the Pulsar Expo: a rack of vintage instruments driving PW.App.
//
//   Receiver (display)     the data on a CRT, story steps, pulsar choice, Vintage/Plain switch
//   Dedisperser            DM knob, S/N lamp meter, S/N against DM ("tuning curve", a bowtie)
//   Integrator             time / frequency scrunch selectors, one flash close up
//   Interference filter    per-channel noise strip, auto zap, click to zap, undo / redo
//   Audio                  sound mode, play, loop, speed, volume, output meter
//   Drawer                 folding, display, data and sound details
//
// Every processing unit has a patch cord: plug it into Bypass to take that stage out of the
// signal chain without losing its settings.
(function () {
  'use strict';
  const $ = (s, r) => (r || document).querySelector(s), $$ = (s, r) => [...(r || document).querySelectorAll(s)];
  const rack = $('#rack'), scr = $('#scr');
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const LOAD_SEC = 2;
  const KDM = 4.148808e-3;   // s, for f in GHz

  // ── rack-level settings (data-dependent ones live on the dataset) ──────
  const saved = (() => { try { return JSON.parse(localStorage.getItem('pulsarExpo') || '{}'); } catch (e) { return {}; } })();
  const R = Object.assign({
    vintage: true, aspect: 'auto', cmap: 'heat', con: 99.5, floor: 60, grat: true, smooth: false, curve: false,
    bypassDM: false, bypassInt: false, bypassRFI: false, sig: 6,
    mode: 'sweep', spd: 0.25, vol: 0.8, loop: true, flo: 300, fhi: 2400, voices: 96,
    secstart: 0, seclen: LOAD_SEC, res: 'auto',
  }, { vintage: saved.vintage, aspect: saved.aspect, cmap: saved.cmap });
  for (const k of ['vintage', 'aspect', 'cmap']) if (R[k] === undefined) R[k] = { vintage: true, aspect: 'auto', cmap: 'heat' }[k];
  const UI = { scene: 0, drawer: false, big: false, playing: false };
  const persist = () => { try { localStorage.setItem('pulsarExpo', JSON.stringify({ vintage: R.vintage, aspect: R.aspect, cmap: R.cmap })); } catch (e) { /* private window */ } };

  // ── busy / status ──────────────────────────────────────────────────────
  const busy = $('#busy');
  PW.ui = PW.ui || {};
  PW.ui.progress = (msg) => { busy.textContent = msg; busy.classList.add('show'); return { set(f, m) { busy.textContent = m || msg; }, done() { busy.classList.remove('show'); } }; };
  let statusTimer = null;
  function status(msg, kind) {
    const el = $('#status'); el.textContent = msg || ''; el.style.color = kind === 'error' ? '#ff7a5c' : kind === 'warn' ? '#ffd27a' : '';
    clearTimeout(statusTimer); statusTimer = setTimeout(() => { el.textContent = ''; }, 7000);
  }

  const app = new PW.App({ defaultLoadSec: LOAD_SEC });
  app.on('status', s => status(s.msg, s.kind));
  window.expo = { app, R, UI };

  // Bypass patches: take a stage out of every request without touching its settings.
  const baseRequest = app.buildRequest.bind(app);
  app.buildRequest = function (extra) {
    const r = baseRequest(extra);
    if (R.bypassDM) { r.dm = 0; if (r.wfDM != null) r.wfDM = 0; }
    if (R.bypassRFI) r.mask = null;
    if (R.bypassInt) {
      if (PW.TIME_KINDS.includes(r.kind)) { r.tscrunch = Math.min(...tscOptions()); r.fscrunch = 1; }
      else r.nbins = Math.max(...nbOptions());
    }
    return r;
  };

  // ── colour maps ─────────────────────────────────────────────────────────
  const lutFn = fn => { const L = new Uint8ClampedArray(768); for (let i = 0; i < 256; i++) { const c = fn(i / 255); L[i * 3] = c[0] * 255; L[i * 3 + 1] = c[1] * 255; L[i * 3 + 2] = c[2] * 255; } return L; };
  const c01 = v => clamp(v, 0, 1);
  const LUTS = {
    heat: lutFn(x => [c01(x / 0.4), c01((x - 0.25) / 0.55), c01((x - 0.65) / 0.35)]),     // psrchive-style: black, red, orange, white
    inferno: window.COLORMAPS && COLORMAPS.inferno ? COLORMAPS.inferno : lutFn(x => [x, x * x, x * .3]),
    grey: lutFn(x => [x, x, x]),
  };
  const INK = { heat: '#ffa640', inferno: '#f98e09', grey: '#e6e6e6' };
  const ink = (a = 1) => R.vintage ? `rgba(255,179,71,${a})` : `rgba(225,225,225,${a})`;

  // ── helpers on the active dataset ──────────────────────────────────────
  const ds = () => app.ds;
  const L = () => app.ds && app.ds.loaded;
  const isTime = k => PW.TIME_KINDS.includes(k || app.state.kind);
  const niceMax = v => { const p = Math.pow(10, Math.floor(Math.log10(v))); for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p; return 10 * p; };
  const dmMax = () => ds() ? niceMax(Math.max(10, ds().refDM * 2.2)) : 150;
  function tscOptions() {
    const d = ds(), l = L(); if (!d || !l) return [1];
    const dur = d.view.time.dur, out = [];
    for (let f = 1; f <= 1 << 16; f *= 2) { const cols = dur / (l.dt * f); if (cols <= 6000 && cols >= 60) out.push(f); }
    return out.length ? out.slice(0, 8) : [Math.max(1, Math.round(dur / l.dt / 900))];
  }
  function fscOptions() {
    const d = ds(); if (!d) return [1];
    const n = d.header.nchans, out = [];
    for (let f = 1; f <= 64; f *= 2) if (n % f === 0 && n / f >= 16) out.push(f);
    return out;
  }
  function nbOptions() {
    const d = ds(), l = L(); if (!d || !l || !d.period) return [64];
    const o = [32, 64, 128, 256, 512, 1024].filter(n => n <= d.period / l.dt * 1.01);
    return o.length ? o : [32];
  }
  const snapTo = (opts, v) => opts.reduce((a, b) => Math.abs(Math.log(b / v)) < Math.abs(Math.log(a / v)) ? b : a, opts[0]);
  function snapScrunch() {
    const d = ds(); if (!d) return;
    d.tscrunch = snapTo(tscOptions(), d.tscrunch || 1);
    d.fscrunch = snapTo(fscOptions(), d.fscrunch || 1);
    d.fold.nbins = snapTo(nbOptions(), d.fold.nbins || 128);
  }
  const fmtDur = s => s >= 1 ? s.toFixed(2) + ' s' : s >= 0.01 ? (s * 1e3).toFixed(0) + ' ms' : (s * 1e3).toFixed(2) + ' ms';
  const fmtAge = y => y >= 1e9 ? (y / 1e9).toFixed(1) + ' billion' : y >= 1e6 ? (y / 1e6).toFixed(y >= 1e7 ? 0 : 1) + ' million' : Math.round(y / (y > 1e4 ? 1000 : 100)) * (y > 1e4 ? 1000 : 100) + '';
  const thin = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const delay = (fMHz, dm, fhiMHz) => KDM * dm * (1 / (fMHz / 1e3) ** 2 - 1 / (fhiMHz / 1e3) ** 2);

  // ── the control model ───────────────────────────────────────────────────
  const B = (label) => ({ bool: true, label });
  const SPECS = {
    dm: () => ({ label: 'Dispersion measure', min: 0, max: dmMax(), step: dmMax() / 3000, fmt: v => v.toFixed(dmMax() >= 50 ? 1 : 2), disabled: !ds() }),
    win: () => { const d = ds(), l = L(); if (!l) return { label: 'Zoom', min: 0.1, max: 1, log: true, fmt: fmtDur, disabled: true };
      const P = d.period || 0, min = isTime() ? Math.max(l.dt * 64, P ? P * 0.6 : 0.002) : Math.max(P * 4, l.dt * 64);
      return { label: 'Zoom', min: Math.min(min, l.nsec), max: l.nsec, log: true, fmt: fmtDur }; },
    pos: () => { const l = L(), v = app.view; if (!l || !v) return { label: 'Time in the recording', min: 0, max: 1, fmt: () => '', disabled: true };
      return { label: 'Time in the recording', min: 0, max: Math.max(1e-6, l.nsec - v.dur), fmt: x => (l.tstart + x).toFixed(3) + ' s', disabled: l.nsec - v.dur < l.dt }; },
    tsc: () => ({ label: 'Time scrunch', vals: tscOptions(), fmt: v => '×' + v, disabled: !isTime() || R.bypassInt }),
    fsc: () => ({ label: 'Frequency scrunch', vals: fscOptions(), fmt: v => '×' + v, disabled: app.state.kind !== 'waterfall' || R.bypassInt }),
    nb: () => ({ label: 'Phase bins', vals: nbOptions(), fmt: String, disabled: isTime() }),
    ppr: () => ({ label: 'Turns per row', vals: [1, 2, 4, 8], fmt: String, disabled: app.state.kind !== 'pulsestack' }),
    shift: () => ({ label: 'Phase shift', min: -0.5, max: 0.5, step: 0.005, fmt: v => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2), disabled: isTime() }),
    con: () => ({ label: 'Brightest', min: 95, max: 100, step: 0.1, fmt: v => v.toFixed(1) + '%' }),
    floor: () => ({ label: 'Floor', min: 0, max: 95, step: 1, fmt: v => v.toFixed(0) + '%' }),
    cmap: () => ({ label: 'Colour map', vals: ['heat', 'inferno', 'grey'], names: ['Heat', 'Inferno', 'Grey'] }),
    aspect: () => ({ label: 'Screen shape', vals: ['auto', '16:9', '16:10'], names: ['Auto', '16:9', '16:10'] }),
    sig: () => ({ label: 'Threshold', min: 3, max: 12, step: 0.5, fmt: v => v.toFixed(1) + 'σ' }),
    mode: () => ({ label: 'Sound', vals: ['clicks', 'whistle', 'sweep', 'melody', 'static'], names: ['Clicks', 'Whistle', 'Sweep', 'Melody', 'Static'] }),
    spd: () => ({ label: 'Speed', vals: [0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1], fmt: v => '×' + v }),
    vol: () => ({ label: 'Volume', min: 0, max: 1, step: 0.01, fmt: v => Math.round(v * 100) }),
    flo: () => ({ label: 'Lowest pitch', min: 100, max: 800, step: 10, fmt: v => v.toFixed(0) + ' Hz', disabled: R.mode !== 'sweep' }),
    fhi: () => ({ label: 'Highest pitch', min: 1000, max: 4000, step: 50, fmt: v => (v / 1000).toFixed(2) + ' kHz', disabled: R.mode !== 'sweep' }),
    voices: () => ({ label: 'Voices', vals: [24, 48, 96], fmt: String, disabled: R.mode !== 'sweep' }),
    secstart: () => { const d = ds(), dur = d ? d.header.duration : 10; return { label: 'Section start', min: 0, max: Math.max(0.01, dur - 0.05), step: 0.01, fmt: v => v.toFixed(2) + ' s', disabled: !d }; },
    seclen: () => { const d = ds(), dur = d ? d.header.duration : 10; return { label: 'Length', min: Math.min(0.1, dur), max: Math.max(0.2, Math.min(dur, 60)), step: 0.05, log: true, fmt: v => v.toFixed(v < 10 ? 2 : 1) + ' s', disabled: !d }; },
    res: () => ({ label: 'Time resolution', vals: ['auto', 1, 2, 4, 8, 16], names: ['Auto', '×1', '×2', '×4', '×8', '×16'] }),
    vintage: () => B('Vintage look'), loop: () => B('Loop'), grat: () => B('Grid'), smooth: () => B('Smooth pixels'), curve: () => B('Dispersion curve'),
    bandpass: () => B('Bandpass'), bypassDM: () => B('Dedisperser'), bypassInt: () => B('Integrator'), bypassRFI: () => B('Interference filter'),
  };
  const model = {
    get plain() { return !R.vintage; },
    spec: p => SPECS[p] ? SPECS[p]() : null,
    get(p) {
      const d = ds();
      switch (p) {
        case 'dm': return d ? d.dm : 0;
        case 'win': return app.view ? app.view.dur : 1;
        case 'pos': return app.view ? app.view.start : 0;
        case 'tsc': return d ? d.tscrunch : 1;
        case 'fsc': return d ? d.fscrunch : 1;
        case 'nb': return d ? d.fold.nbins : 128;
        case 'ppr': return d ? d.fold.pulsesPerRow : 1;
        case 'shift': return d ? d.fold.phaseShift : 0;
        case 'bandpass': return d ? d.bandpass : true;
      }
      return R[p];
    },
    set(p, v) {
      const d = ds();
      const needsDs = ['dm', 'win', 'pos', 'tsc', 'fsc', 'nb', 'ppr', 'shift', 'bandpass'];
      if (needsDs.includes(p) && (!d || !d.loaded)) return;
      if (p === 'dm') { stopSweep(); d.dm = v; return compute(); }
      if (p === 'win') { const vw = app.view; const mid = vw.start + vw.dur / 2; vw.dur = v; vw.start = clamp(mid - v / 2, 0, Math.max(0, d.loaded.nsec - v)); snapScrunch(); return compute(); }
      if (p === 'pos') { app.view.start = v; return compute(); }
      if (p === 'tsc') { d.tscrunch = v; return compute(); }
      if (p === 'fsc') { d.fscrunch = v; return compute(); }
      if (p === 'nb') { d.fold.nbins = v; return compute(); }
      if (p === 'ppr') { d.fold.pulsesPerRow = v; return compute(); }
      if (p === 'shift') { d.fold.phaseShift = v; return compute(); }
      if (p === 'bandpass') { d.bandpass = v; tuneKey = ''; return compute(); }
      R[p] = v;
      if (p === 'vintage') { rack.classList.toggle('plain', !v); persist(); buildAll(); return redrawAll(); }
      if (p === 'aspect') { persist(); layout(); return sync(); }
      if (p === 'cmap') persist();
      if (['cmap', 'con', 'floor', 'grat', 'smooth', 'sig'].includes(p)) { drawMain(); drawSide(); return sync(); }
      if (p === 'curve') { if (v) computeCurve(); else { curveT0 = null; drawMain(); } return sync(); }
      if (p.startsWith('bypass')) { tuneKey = ''; return compute(); }
      if (p === 'mode') { const sp = PW.audio.suggestSpeed(v, d && d.period); R.spd = snapTo(SPECS.spd().vals, sp); if (UI.playing) play(); return sync(); }
      if (['spd', 'flo', 'fhi', 'voices', 'loop'].includes(p) && UI.playing) { clearTimeout(followTimer); followTimer = setTimeout(play, 350); }
      sync();
    },
  };
  function compute() { app.update('compute'); sync(); }

  // ── controls ────────────────────────────────────────────────────────────
  const ctls = () => $$('.c[data-p]');
  function buildAll() { ctls().forEach(el => PW.rack.build(el, model)); sync(); }
  function sync() {
    ctls().forEach(el => PW.rack.sync(el, model));
    const d = ds(), st = app.state;
    $$('[data-act]').forEach(b => {
      const a = b.dataset.act; let on = false;
      if (a.startsWith('kind:')) on = st.kind === a.slice(5);
      else if (a.startsWith('scene:')) on = UI.scene === +a.slice(6);
      else if (a.startsWith('ds:')) on = d && d.id === a.slice(3);
      else if (a === 'play') on = UI.playing;
      else if (a === 'dm0') on = !!d && Math.abs(d.dm) < 1e-9;
      else if (a === 'dmtrue') on = !!d && Math.abs(d.dm - d.refDM) < 1e-6;
      else if (a === 'enlarge') on = UI.big;
      else if (a === 'sweep') on = !!sweepRaf;
      if (a === 'undo') b.disabled = !d || !d.zap || !d.zap.undo.length;
      if (a === 'redo') b.disabled = !d || !d.zap || !d.zap.redo.length;
      b.classList.toggle('on', on);
    });
    for (const p of ['bypassDM', 'bypassInt', 'bypassRFI']) { const u = $(`[data-stage=${p}]`); u && u.classList.toggle('bypassed', !!R[p]); }
    $('#drawer').classList.toggle('open', UI.drawer);
    reads();
  }
  function reads() {
    const d = ds(), p = app.product, l = L(), snr = p && p.meta && isFinite(p.meta.snr) ? p.meta.snr : 0;
    const val = {
      snr: p ? Math.round(snr) : '–',
      osd1: !d ? '' : R.bypassDM ? 'DM bypassed' : `DM ${d.dm.toFixed(dmMax() >= 50 ? 1 : 2)}`,
      osd2: !p ? '' : isTime(p.kind) ? `t×${p.meta.tscrunch || d.tscrunch} f×${p.meta.fscrunch || d.fscrunch}  ${R.bypassRFI ? 'filter off' : maskCount() + ' ch off'}` : `${p.nx} bins  ${p.meta.nPulses || p.ny} turns`,
      osd3: !p ? '' : isTime(p.kind) ? `${fmtDur((p.x.max - p.x.min) / 10)}/div` : p.kind === 'profile' ? 'one turn, averaged' : `P ${(d.period * 1e3).toFixed(3)} ms`,
      osd4: p ? `S/N ${snr.toFixed(0)}` : '',
      peak: tunePeak ? `peak at DM ${tunePeak.toFixed(dmMax() >= 50 ? 0 : 2)}` : '',
      res: !l ? '' : isTime() ? `${fmtDur((p ? (p.x.max - p.x.min) / p.nx : l.dt))}, ${p && p.kind === 'waterfall' ? Math.abs((p.y.max - p.y.min) / p.ny).toFixed(2) + ' MHz' : ''} per pixel` : `${d.fold.nbins} phase bins`,
      zapcount: !d ? '' : R.bypassRFI ? 'bypassed' : `${maskCount()} of ${d.header.nchans} channels off`,
      flo: d ? `${Math.round(d.header.flo)} MHz` : '', fhi: d ? `${Math.round(d.header.fhi)} MHz` : '',
      modedesc: { clicks: 'one tick per turn', whistle: 'each band a note', sweep: 'radio pitch becomes sound pitch', melody: 'one note per flash', static: 'noise envelope' }[R.mode],
      audinfo: d ? `${R.spd >= 1 ? 'real time' : (1 / R.spd).toFixed(R.spd > 0.1 ? 1 : 0) + '× slower than real life'}` : '',
      drawerlabel: UI.drawer ? 'Close detailed controls' : 'Detailed controls',
      period: d && d.period ? `${(d.period * 1e3).toFixed(4)} ms` : '–',
      periodsrc: !d ? '' : { catalogue: 'from the ATNF catalogue for this date', search: 'refined from the data', saved: 'saved for this file', manual: 'typed in', header: 'from the file header', none: 'unknown' }[d.periodSource] || '',
    };
    $$('[data-read]').forEach(el => {
      const k = el.dataset.read;
      // log scale: noise (S/N ~3) shows nothing, a few tens fills half, a few hundred fills it
      if (k === 'bars') { const n = 24, on = p ? Math.round(clamp((Math.log10(Math.max(1, snr)) - 0.5) / (Math.log10(400) - 0.5), 0, 1) * n) : 0; el.innerHTML = Array.from({ length: n }, (_, i) => `<span class="${i < on ? (i >= on - 2 ? 'hot' : 'on') : ''}"></span>`).join(''); }
      else if (k in val) el.textContent = val[k];
    });
  }
  const maskCount = () => { const d = ds(); return d ? d.mask.reduce((a, b) => a + b, 0) : 0; };

  // ── canvases ────────────────────────────────────────────────────────────
  let SCALE = 1;
  function fit(cv) {
    const r = cv.getBoundingClientRect(), w = Math.max(1, Math.round(r.width / SCALE)), h = Math.max(1, Math.round(r.height / SCALE));
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    return [w, h, cv.getContext('2d')];
  }
  const hatch = (() => { const c = document.createElement('canvas'); c.width = c.height = 10; const x = c.getContext('2d'); x.fillStyle = '#141414'; x.fillRect(0, 0, 10, 10);
    x.strokeStyle = '#4a4a4a'; x.lineWidth = 2; x.beginPath(); x.moveTo(-2, 12); x.lineTo(12, -2); x.stroke(); return c; })();
  const font = (px) => R.vintage ? `${px}px VT323, monospace` : `${Math.round(px * 0.62)}px system-ui, sans-serif`;
  function grid10(ctx, W, H) {
    if (!R.grat) return;
    ctx.strokeStyle = R.vintage ? 'rgba(255,180,110,.15)' : 'rgba(255,255,255,.12)'; ctx.lineWidth = 1; ctx.beginPath();
    for (let i = 1; i < 10; i++) { const x = Math.round(i * W / 10) + .5; ctx.moveTo(x, 0); ctx.lineTo(x, H); }
    for (let i = 1; i < 8; i++) { const y = Math.round(i * H / 8) + .5; ctx.moveTo(0, y); ctx.lineTo(W, y); } ctx.stroke();
  }
  function percentiles(g, qs) {
    const s = [], step = Math.max(1, Math.floor(g.length / 20000));
    for (let i = 0; i < g.length; i += step) { const v = g[i]; if (Number.isFinite(v)) s.push(v); }
    s.sort((a, b) => a - b);
    return qs.map(q => s.length ? s[Math.min(s.length - 1, Math.floor(q / 100 * s.length))] : 0);
  }
  /** Rows (bottom-up, as in the product) whose channels are all switched off. */
  function maskedRows(p) {
    const d = ds(); if (!d || R.bypassRFI || p.kind !== 'waterfall') return null;
    const n = d.header.nchans, fs = Math.round(n / p.ny) || 1, flip = d.header.foff < 0, out = new Uint8Array(p.ny);
    for (let r = 0; r < p.ny; r++) { let all = 1; for (let k = r * fs; k < (r + 1) * fs; k++) { const c = flip ? n - 1 - k : k; if (!d.mask[c]) { all = 0; break; } } out[r] = all; }
    return out;
  }
  function drawMain() {
    const cv = $('[data-main]'), [W, H, ctx] = fit(cv), p = app.product;
    ctx.clearRect(0, 0, W, H);
    scr.classList.toggle('noseries', !!p && p.kind === 'profile');
    if (!p) { drawSeries(); return; }
    if (p.kind === 'profile' || p.ny === 1) drawProfileOn(cv, p.series || p.grid, p);
    else {
      const flip = p.kind !== 'pulsestack', mr = maskedRows(p), Lt = LUTS[R.cmap];
      const [lo, hi] = percentiles(p.grid, [R.floor, R.con]);
      const off = document.createElement('canvas'); off.width = p.nx; off.height = p.ny;
      const ox = off.getContext('2d'), im = ox.createImageData(p.nx, p.ny);
      for (let r = 0; r < p.ny; r++) {
        const row = flip ? p.ny - 1 - r : r; if (mr && mr[r]) continue;
        for (let x = 0; x < p.nx; x++) {
          const v = p.grid[r * p.nx + x]; if (!Number.isFinite(v)) continue;
          const c = clamp(((v - lo) / (hi - lo || 1)) * 255, 0, 255) | 0, o = (row * p.nx + x) * 4;
          im.data[o] = Lt[c * 3]; im.data[o + 1] = Lt[c * 3 + 1]; im.data[o + 2] = Lt[c * 3 + 2]; im.data[o + 3] = 255;
        }
      }
      ox.putImageData(im, 0, 0);
      ctx.fillStyle = ctx.createPattern(hatch, 'repeat'); ctx.fillRect(0, 0, W, H);
      ctx.imageSmoothingEnabled = !!R.smooth; ctx.drawImage(off, 0, 0, W, H);
      grid10(ctx, W, H);
      if (p.kind === 'waterfall' && R.curve && curveT0 != null) drawCurve(ctx, W, H, p);
      ctx.font = font(20); ctx.fillStyle = ink(.85); ctx.textBaseline = 'top';
      if (p.kind === 'pulsestack') { ctx.fillText('turn 1', 8, 6); ctx.textBaseline = 'bottom'; ctx.fillText(`turn ${p.ny * (ds().fold.pulsesPerRow || 1)}`, 8, H - 6); }
      else { ctx.fillText(`${p.y.max.toFixed(0)} MHz`, 8, 6); ctx.textBaseline = 'bottom'; ctx.fillText(`${p.y.min.toFixed(0)} MHz`, 8, H - 6); }
    }
    drawSeries();
  }
  function drawProfileOn(cv, s, p) {
    const [W, H, ctx] = fit(cv); ctx.clearRect(0, 0, W, H); grid10(ctx, W, H);
    let mn = Infinity, mx = -Infinity; for (const v of s) { if (v < mn) mn = v; if (v > mx) mx = v; }
    ctx.beginPath();
    for (let i = 0; i < s.length; i++) { const x0 = i / s.length * W, x1 = (i + 1) / s.length * W, y = H - 24 - (s[i] - mn) / (mx - mn || 1) * (H - 60); i ? ctx.lineTo(x0, y) : ctx.moveTo(x0, y); ctx.lineTo(x1, y); }
    ctx.strokeStyle = INK[R.cmap]; ctx.lineWidth = 3; ctx.lineJoin = 'round'; ctx.stroke();
    ctx.font = font(20); ctx.fillStyle = ink(.85); ctx.textBaseline = 'bottom'; ctx.fillText('phase 0', 8, H - 4); ctx.textAlign = 'right'; ctx.fillText('1', W - 8, H - 4); ctx.textAlign = 'left';
  }
  function drawLine(ctx, W, H, s, o) {
    o = o || {}; let mn = o.mn, mx = o.mx;
    if (mn == null) { mn = Infinity; mx = -Infinity; for (const v of s) { if (v < mn) mn = v; if (v > mx) mx = v; } }
    ctx.beginPath();
    for (let i = 0; i < s.length; i++) {
      const y = H - 6 - (s[i] - mn) / (mx - mn || 1) * (H - 14);
      if (o.steps) { const x0 = (o.x0 != null ? o.x0 + i * o.dx : i / s.length * W), x1 = x0 + (o.dx || W / s.length); i ? ctx.lineTo(x0, y) : ctx.moveTo(x0, y); ctx.lineTo(x1, y); }
      else { const x = o.x0 != null ? o.x0 + (i + .5) * o.dx : (i + .5) / s.length * W; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
    }
    ctx.strokeStyle = o.color || INK[R.cmap]; ctx.lineWidth = o.lw || 1.6; ctx.lineJoin = 'round'; ctx.stroke();
  }
  function drawSeries() {
    const cv = $('[data-series]'), [W, H, ctx] = fit(cv), p = app.product; ctx.clearRect(0, 0, W, H);
    if (!p || !p.series || p.kind === 'profile') return;
    if (R.grat) { ctx.strokeStyle = R.vintage ? 'rgba(255,180,110,.15)' : 'rgba(255,255,255,.1)'; ctx.beginPath(); for (let i = 1; i < 10; i++) { const x = Math.round(i * W / 10) + .5; ctx.moveTo(x, 0); ctx.lineTo(x, H); } ctx.stroke(); }
    drawLine(ctx, W, H, p.series, { lw: p.series.length < 300 ? 2.4 : 1.5, steps: p.kind === 'pulsestack' });
  }
  function drawCurve(ctx, W, H, p) {
    const d = ds(), res = d.refDM - (R.bypassDM ? 0 : d.dm), fhi = p.y.max, flo = p.y.min;
    ctx.save(); ctx.setLineDash([12, 9]); ctx.strokeStyle = R.vintage ? '#7fe0ff' : '#5ad'; ctx.lineWidth = 3; ctx.beginPath();
    for (let i = 0; i <= 80; i++) { const f = fhi - (fhi - flo) * i / 80, t = curveT0 + delay(f, res, fhi), x = (t - p.x.min) / (p.x.max - p.x.min) * W, y = i / 80 * H; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
    ctx.stroke(); ctx.restore();
  }

  // side displays: tuning curve, close-up, channel strip, output meter
  let tuneKey = '', tuneCurve = null, tunePeak = null, zoomData = null, curveT0 = null;
  function drawSide() { drawTune(); drawZoom(); drawStrip(); drawVU(lastLevel); }
  function drawTune() {
    const cv = $('[data-tune]'), [W, H, ctx] = fit(cv); ctx.clearRect(0, 0, W, H); grid10(ctx, W, H);
    const d = ds(); if (!d || !tuneCurve) return;
    const mx = Math.max(...tuneCurve.map(c => c[1])) || 1, top = dmMax();
    ctx.beginPath(); tuneCurve.forEach(([dm, s], i) => { const x = dm / top * W, y = H - 8 - Math.max(0, s) / mx * (H - 20); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.strokeStyle = ink(); ctx.lineWidth = 2; ctx.stroke();
    const x = (R.bypassDM ? 0 : d.dm) / top * W; ctx.strokeStyle = R.vintage ? 'rgba(255,240,200,.9)' : '#fff'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    ctx.font = font(18); ctx.fillStyle = ink(.8); ctx.textBaseline = 'bottom'; ctx.fillText('DM 0', 5, H - 2); ctx.textAlign = 'right'; ctx.fillText(String(top), W - 5, H - 2); ctx.textAlign = 'left';
  }
  function drawZoom() {
    const cv = $('[data-zoom]'), [W, H, ctx] = fit(cv); ctx.clearRect(0, 0, W, H); grid10(ctx, W, H);
    const z = zoomData; if (!z) return;
    let mn = Infinity, mx = -Infinity; for (const v of z.fine.concat(z.coarse)) { if (v < mn) mn = v; if (v > mx) mx = v; }
    drawLine(ctx, W, H, z.fine, { mn, mx, color: R.vintage ? 'rgba(255,200,140,.38)' : 'rgba(255,255,255,.35)', lw: 1.2 });
    drawLine(ctx, W, H, z.coarse, { mn, mx, steps: true, x0: z.cx0 * W, dx: z.cdx * W, color: ink(), lw: 2.6 });
    ctx.font = font(18); ctx.fillStyle = ink(.75); ctx.textBaseline = 'top'; ctx.fillText(z.label, 6, 4);
  }
  function stripData() {
    const d = ds(), l = L(); if (!d || !l || !l.chanStd) return null;
    const n = d.header.nchans, flip = d.header.foff < 0, cvs = new Float32Array(n);
    for (let k = 0; k < n; k++) { const c = flip ? n - 1 - k : k, m = l.chanMean[c]; cvs[k] = m > 0 ? l.chanStd[c] / m : 0; }
    const s = Array.from(cvs).filter(v => v > 0).sort((a, b) => a - b), med = s[s.length >> 1] || 1;
    const mad = (s.map(v => Math.abs(v - med)).sort((a, b) => a - b)[s.length >> 1] || med * 0.1) * 1.4826;
    return { cvs, med, mad, flip, n };
  }
  function drawStrip() {
    const cv = $('[data-strip]'), [W, H, ctx] = fit(cv); ctx.clearRect(0, 0, W, H);
    const d = ds(), sd = stripData(); if (!sd) return;
    const base = H - 24, hz = z => clamp(0.1 + 0.9 * z / (2 * R.sig), 0.03, 1) * (base - 6);
    for (let k = 0; k < sd.n; k++) {
      const c = sd.flip ? sd.n - 1 - k : k, x = k / sd.n * W, w = Math.max(1, W / sd.n);
      if (d.mask[c] && !R.bypassRFI) { ctx.fillStyle = ctx.createPattern(hatch, 'repeat'); ctx.fillRect(x, 0, w, base); continue; }
      const v = sd.cvs[k], z = (v - sd.med) / sd.mad, h = v > 0 ? hz(z) : 0;
      ctx.fillStyle = z > R.sig ? ink() : R.vintage ? 'rgba(255,200,140,.42)' : 'rgba(255,255,255,.42)'; ctx.fillRect(x, base - h, w, h);
    }
    // the auto-zap threshold
    const ty = Math.round(base - hz(R.sig)) + .5; ctx.save(); ctx.setLineDash([6, 5]); ctx.strokeStyle = R.vintage ? 'rgba(127,224,255,.75)' : '#5ad'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(0, ty); ctx.lineTo(W, ty); ctx.stroke(); ctx.restore();
  }
  let lastLevel = 0;
  function drawVU(level) {
    lastLevel = level;
    const cv = $('[data-vu]'), [W, H, ctx] = fit(cv); ctx.clearRect(0, 0, W, H);
    const cx = W / 2, cy = H + 18, Rr = Math.min(W * .5, H * 1.08);
    ctx.strokeStyle = ink(.7); ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(cx, cy, Rr * .82, Math.PI * 1.25, Math.PI * 1.75); ctx.stroke();
    for (let i = 0; i <= 10; i++) { const a = Math.PI * 1.25 + Math.PI * .5 * i / 10; ctx.beginPath(); ctx.moveTo(cx + Rr * .82 * Math.cos(a), cy + Rr * .82 * Math.sin(a)); ctx.lineTo(cx + Rr * (i % 5 ? .88 : .93) * Math.cos(a), cy + Rr * (i % 5 ? .88 : .93) * Math.sin(a)); ctx.stroke(); }
    ctx.strokeStyle = '#c2531c'; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(cx, cy, Rr * .82, Math.PI * 1.65, Math.PI * 1.75); ctx.stroke();
    const a = Math.PI * 1.25 + Math.PI * .5 * clamp(level, 0, 1); ctx.strokeStyle = R.vintage ? '#f4ecd8' : '#fff'; ctx.lineWidth = 2.2;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Rr * .96 * Math.cos(a), cy + Rr * .96 * Math.sin(a)); ctx.stroke();
  }
  function redrawAll() { drawMain(); drawSide(); sync(); }

  // ── follow-up computations (low priority, own worker channels) ────────
  let sideTimer = null;
  app.on('product', () => { drawMain(); drawStrip(); sync(); clearTimeout(sideTimer); sideTimer = setTimeout(sideCompute, 140); followAudio(); });
  async function sideCompute() { await computeZoom(); await computeTune(); if (R.curve) await computeCurve(); }
  const maskKey = () => { const d = ds(); let h = 0; d.mask.forEach((m, i) => { if (m) h = (h * 31 + i) | 0; }); return h; };
  function sideReq(extra) {
    const d = ds();
    return Object.assign({ dm: R.bypassDM ? 0 : d.dm, bandpass: d.bandpass, mask: R.bypassRFI ? null : d.mask.slice(), fscrunch: 1, tscrunch: 1,
      period: d.period || 1, nbins: d.fold.nbins, phaseShift: d.fold.phaseShift, pulsesPerRow: 1 }, extra);
  }
  async function computeTune() {
    const d = ds(), l = L(); if (!d || !l) return;
    const v = d.view.time, ts = isTime() ? (app.product && app.product.meta.tscrunch) || d.tscrunch : Math.max(1, Math.round(v.dur / l.dt / 900));
    const key = [d.id, v.start, v.dur, ts, maskKey(), d.bandpass, R.bypassRFI, dmMax()].join('|');
    if (key === tuneKey) { drawTune(); return; }
    let p;
    try { p = await d.engine.compute(sideReq({ kind: 'bowtie', viewStart: v.start, viewDur: v.dur, tscrunch: ts, dmMin: 0, dmMax: dmMax(), nDM: 100, nsub: Math.min(64, d.header.nchans) }), 'tune'); }
    catch (e) { console.warn('tune', e); return; }
    if (!p || p.stale || d !== ds()) return;
    tuneKey = key; tuneCurve = [];
    for (let j = 0; j < p.ny; j++) {
      const row = p.grid.subarray(j * p.nx, (j + 1) * p.nx), s = Array.from(row).sort((a, b) => a - b), med = s[s.length >> 1];
      const mad = s.map(x => Math.abs(x - med)).sort((a, b) => a - b)[s.length >> 1] * 1.4826 || 1;
      tuneCurve.push([p.y.min + (j + 0.5) * (p.y.max - p.y.min) / p.ny, (s[s.length - 1] - med) / mad]);
    }
    tunePeak = tuneCurve.reduce((a, b) => b[1] > a[1] ? b : a)[0];
    drawTune(); reads();
  }
  async function computeZoom() {
    const d = ds(), l = L(), p = app.product, s = p && (p.series || (p.ny === 1 ? p.grid : null)); if (!d || !l || !s) { zoomData = null; drawZoom(); return; }
    const n = s.length; let i = 0; for (let k = 1; k < n; k++) if (s[k] > s[i]) i = k;
    if (isTime(p.kind)) {
      const bw = (p.x.max - p.x.min) / n, half = Math.max(6, Math.min(16, Math.round(0.02 / bw) || 6)), a = Math.max(0, i - half), b = Math.min(n, i + half);
      const t0 = p.x.min + a * bw, dur = (b - a) * bw, ts = Math.max(1, Math.floor(dur / l.dt / 700));
      let f; try { f = await d.engine.compute(sideReq({ kind: 'timeseries', viewStart: t0, viewDur: dur, tscrunch: ts }), 'zoom'); } catch (e) { return; }
      if (!f || f.stale || d !== ds()) return;
      const fx0 = f.x.min, fx1 = f.x.max;
      zoomData = { fine: Array.from(f.grid), coarse: Array.from(s.slice(a, b)), cx0: (t0 - fx0) / (fx1 - fx0), cdx: bw / (fx1 - fx0),
        label: `${fmtDur(bw)} pixels, faint line ${fmtDur((f.x.max - f.x.min) / f.nx)}` };
    } else {
      const fineBins = Math.max(...nbOptions());
      let f; try { f = await d.engine.compute(sideReq({ kind: 'profile', viewStart: d.view.fold.start, viewDur: d.view.fold.dur, nbins: fineBins }), 'zoom'); } catch (e) { return; }
      if (!f || f.stale || d !== ds()) return;
      zoomData = { fine: Array.from(f.series || f.grid), coarse: Array.from(s), cx0: 0, cdx: 1 / n, label: `${n} bins, faint line ${fineBins}` };
    }
    drawZoom();
  }
  async function computeCurve() {
    const d = ds(), p = app.product; if (!d || !p || p.kind !== 'waterfall') return;
    let f; try { f = await d.engine.compute(sideReq({ kind: 'timeseries', dm: d.refDM, viewStart: p.x.min, viewDur: (p.x.max - p.x.min), tscrunch: p.meta.tscrunch || d.tscrunch }), 'aux'); } catch (e) { return; }
    if (!f || f.stale || d !== ds()) return;
    const s = f.grid, n = s.length, half = Math.max(1, Math.floor(n * 0.45)); let i = 0;
    for (let k = 1; k < half; k++) if (s[k] > s[i]) i = k;
    curveT0 = f.x.min + (i + 0.5) * (f.x.max - f.x.min) / n;
    drawMain();
  }

  // ── datasets ────────────────────────────────────────────────────────────
  function shortName(d) {
    if (d.cat) { const nn = d.cat.nickname; if (nn && nn.length <= 12) return nn.replace(/ pulsar$/i, ''); return d.cat.jname; }
    return d.src.slice(0, 14);
  }
  app.on('datasets', list => {
    const host = $('#psr-keys');
    host.innerHTML = list.map(d => `<button class="key dark" data-act="ds:${d.id}" title="${d.name}"><span class="lamp"></span>${shortName(d)}</button>`).join('') + '<button class="key dark" data-act="files">Add…</button>'
      + (demosLeft().length && list.length ? '<button class="key dark" data-act="demos" title="Download the example pulsars that are not open yet">Examples</button>' : '');
    $('#splash').classList.toggle('show', !list.length);
    sync();
  });
  app.on('dataset', d => { if (!d) return; d.zap = d.zap || { undo: [], redo: [] }; header(d); tuneKey = ''; tuneCurve = null; tunePeak = null; zoomData = null; curveT0 = null; sync(); });
  app.on('loaded', d => { snapScrunch(); R.secstart = d.loaded.tstart; R.seclen = d.loaded.nsec; header(d); tuneKey = ''; });
  function header(d) {
    const h = d.header, c = d.cat, l = d.loaded;
    $('#psr-name').textContent = c ? (c.nickname && c.nickname.length <= 20 ? c.nickname : 'PSR ' + c.jname) : d.src;
    $('#psr-sub').textContent = [c ? `PSR ${c.jname}${c.bname ? ' (' + c.bname + ')' : ''}` : d.name, `${Math.round(h.flo)} to ${Math.round(h.fhi)} MHz`,
      l ? `${l.nsec.toFixed(2)} s from ${l.tstart.toFixed(1)} s` : ''].filter(Boolean).join(', ');
    const f = [];
    if (d.period) { const r = 1 / d.period; f.push([r >= 10 ? r.toFixed(r >= 100 ? 0 : 1) : r.toFixed(2), 'turns per second']); }
    if (c && c.dist_kpc) { const ly = c.dist_kpc * 3261.56; f.push([ly >= 1e4 ? thin(Math.round(ly / 1000) * 1000) : thin(Math.round(ly / 10) * 10), 'light years away']); }
    if (c && c.age_yr) f.push([thin(fmtAge(c.age_yr)), 'years old']);
    $('#facts').innerHTML = f.map(([v, l2]) => `<div><dd>${v}</dd><dt>${l2}</dt></div>`).join('');
  }
  async function loadFiles(files) {
    files = [...files].filter(f => /\.fil$/i.test(f.name));
    if (!files.length) { status('No .fil files there', 'warn'); return; }
    let first = null;
    for (const f of files) {
      if (app.datasets.some(d => d.name === f.name && d.file.size === f.size)) continue;
      try { const d = await app.openFile(f); first = first || d; }
      catch (e) { console.error(e); status(e.message || String(e), 'error'); }
    }
    if (first) { await app.select(first.id, true); applyScene(UI.scene || 0); }
  }

  // Remember the Filterbanks folder between visits (File System Access API + IndexedDB).
  const idb = (mode, fn) => new Promise((res, rej) => {
    const r = indexedDB.open('pulsar-expo', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onerror = () => rej(r.error);
    r.onsuccess = () => { const tx = r.result.transaction('kv', mode), q = fn(tx.objectStore('kv')); tx.oncomplete = () => res(q && q.result); tx.onerror = () => rej(tx.error); };
  });
  const idbGet = k => idb('readonly', s => s.get(k)).catch(() => null);
  const idbSet = (k, v) => idb('readwrite', s => s.put(v, k)).catch(() => null);
  let rememberedDir = null;
  async function openFolder(handle) {
    try {
      if (!handle) {
        if (!window.showDirectoryPicker) { status('This browser cannot open folders: use Pick files instead', 'warn'); return pickFiles(); }
        handle = await window.showDirectoryPicker({ id: 'filterbanks', mode: 'read' });
      }
      let perm = await handle.queryPermission({ mode: 'read' });
      if (perm !== 'granted') perm = await handle.requestPermission({ mode: 'read' });
      if (perm !== 'granted') { status('No permission to read that folder', 'warn'); return; }
      await idbSet('dir', handle); rememberedDir = handle;
      const files = [];
      for await (const [name, h] of handle.entries()) if (h.kind === 'file' && /\.fil$/i.test(name)) files.push(await h.getFile());
      files.sort((a, b) => a.name.localeCompare(b.name));
      await loadFiles(files);
    } catch (e) { if (e && e.name !== 'AbortError') status(e.message || String(e), 'error'); }
  }
  function pickFiles() { $('#file-in').click(); }
  // Example pulsars shipped with the website (only offered over http, see demos.js)
  const demosLeft = () => (PW.demos && PW.demos.available) ? PW.demos.list.filter(d => !app.datasets.some(x => x.name === d.file)) : [];
  let demoBusy = false;
  async function loadDemos() {
    const todo = demosLeft();
    if (demoBusy || !todo.length) return;
    demoBusy = true;
    const total = todo.reduce((a, d) => a + d.mb, 0), got = {};
    const say = (m) => { status(m); if ($('#splash').classList.contains('show')) $('#splash-msg').textContent = m; };
    const upd = () => say(`Downloading the example pulsars: ${Object.values(got).reduce((a, b) => a + b, 0).toFixed(0)} of ${total.toFixed(0)} MB`);
    upd();
    let pickFirst = !app.datasets.length, chain = Promise.resolve();
    await Promise.all(todo.map(d => PW.demos.fetch(d, x => { got[d.file] = x * d.mb; upd(); })
      .then(f => (chain = chain.then(async () => {
        const nd = await app.openFile(f);
        if (pickFirst) { pickFirst = false; await app.select(nd.id, true); applyScene(UI.scene || 0); }
      })))
      .catch(e => { console.error(e); status(e.message || String(e), 'error'); })));
    demoBusy = false;
    app.emit && app.emit('datasets', app.datasets);
    status('Example pulsars ready: switch with the keys top right or P');
  }
  $('#file-in').addEventListener('change', e => { loadFiles(e.target.files); e.target.value = ''; });
  async function startup() {
    if (PW.demos && PW.demos.available) {
      $('#splash-demos').hidden = false;
      $('#splash-folder').className = 'key dark';
      $('#splash-folder').textContent = 'Open a folder';
      $('#splash-msg').textContent = 'Load the example pulsars, or open your own .fil files (a folder, or pick files). You can also drop .fil files anywhere on the rack. Your files stay in this browser: nothing is uploaded.';
    }
    rememberedDir = await idbGet('dir');
    if (rememberedDir) {
      $('#splash-folder').textContent = `Open ${rememberedDir.name} folder again`;
      $('#splash-msg').textContent = `Load every .fil file in “${rememberedDir.name}” (first ${LOAD_SEC} s of each), or pick files. You can also drop .fil files anywhere on the rack.`;
      try { if (await rememberedDir.queryPermission({ mode: 'read' }) === 'granted') return openFolder(rememberedDir); } catch (e) { /* ask with a click */ }
    }
  }
  // drag and drop
  let dragDepth = 0;
  addEventListener('dragenter', e => { e.preventDefault(); if (++dragDepth === 1) document.body.classList.add('dragging'); });
  addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
  addEventListener('dragover', e => e.preventDefault());
  addEventListener('drop', e => { e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging'); loadFiles(e.dataTransfer.files); });

  // ── zapping with undo ─────────────────────────────────────────────────
  function zap(chs, on) {
    const d = ds(); if (!d) return;
    chs = chs.filter(c => c >= 0 && c < d.header.nchans && d.mask[c] !== on);
    if (!chs.length) return;
    chs.forEach(c => { d.mask[c] = on; });
    d.zap.undo.push({ chs, on }); d.zap.redo = [];
    tuneKey = ''; compute(); drawStrip();
  }
  /** Channels (file order) in the out-row group that contains low→high channel k. */
  function groupAt(k, fs) { const d = ds(), n = d.header.nchans, flip = d.header.foff < 0, k0 = Math.floor(k / fs) * fs, out = []; for (let j = k0; j < Math.min(n, k0 + fs); j++) out.push(flip ? n - 1 - j : j); return out; }
  function toggleGroup(chs) { const d = ds(); zap(chs, chs.every(c => d.mask[c]) ? 0 : 1); }
  $('[data-main]').addEventListener('click', e => {
    const p = app.product, d = ds(); if (!p || !d || p.kind !== 'waterfall' || R.bypassRFI) return;
    const r = e.currentTarget.getBoundingClientRect(), row = p.ny - 1 - Math.floor((e.clientY - r.top) / r.height * p.ny), fs = Math.round(d.header.nchans / p.ny);
    toggleGroup(groupAt(row * fs, fs));
  });
  $('[data-main]').addEventListener('dblclick', e => { e.preventDefault(); enlarge(); });
  $('[data-strip]').addEventListener('click', e => {
    const d = ds(); if (!d || R.bypassRFI) return;
    const r = e.currentTarget.getBoundingClientRect(), k = Math.floor((e.clientX - r.left) / r.width * d.header.nchans);
    toggleGroup(groupAt(k, Math.max(1, Math.round(d.header.nchans / 512))));
  });
  async function autoZap() {
    const d = ds(); if (!d || !d.loaded) return;
    const before = d.mask.slice(); await app.autoZap(R.sig);
    const chs = []; d.mask.forEach((m, i) => { if (m && !before[i]) chs.push(i); });
    if (chs.length) { d.zap.undo.push({ chs, on: 1 }); d.zap.redo = []; }
    tuneKey = ''; drawStrip(); sync();
  }
  function undoRedo(which) {
    const d = ds(); if (!d) return;
    const from = which === 'undo' ? d.zap.undo : d.zap.redo, to = which === 'undo' ? d.zap.redo : d.zap.undo, s = from.pop(); if (!s) return;
    s.chs.forEach(c => { d.mask[c] = which === 'undo' ? 1 - s.on : s.on; }); to.push(s);
    tuneKey = ''; compute(); drawStrip();
  }

  // ── story ───────────────────────────────────────────────────────────────
  const SCENES = [
    { t: 'Raw data', c: 'Each curved stripe is one flash from the star. Low radio frequencies travel slower through the gas between the stars, so they arrive late.',
      apply(d) { app.state.kind = 'waterfall'; d.dm = 0; R.curve = false; } },
    { t: 'Dispersion', c: 'The dashed line is what physics predicts: the delay grows as one over frequency squared. Every flash follows it.',
      apply(d) { app.state.kind = 'waterfall'; d.dm = 0; R.curve = true; } },
    { t: 'Dedisperse', c: 'Turn the tuning knob. At the right dispersion measure every frequency lines up and the signal meter peaks.',
      apply(d) { app.state.kind = 'waterfall'; R.curve = false; d.dm = 0; setTimeout(() => sweepTo(d.refDM, 4000), 300); } },
    { t: 'Pulse stack', c: 'Each row is one turn of the star. Some flashes are bright, some faint, and now and then it skips one.',
      apply(d) { if (!d.period) return false; d.dm = d.refDM; app.state.kind = 'pulsestack'; R.curve = false; } },
    { t: 'Average pulse', c: 'Add every turn together and the noise cancels out, leaving the star’s own fingerprint.',
      apply(d) { if (!d.period) return false; d.dm = d.refDM; app.state.kind = 'profile'; R.curve = false; } },
    { t: 'Listen', c: 'Each radio frequency becomes a pitch. Out of tune it whistles downwards; at the right DM every flash is a single click.',
      apply(d) { d.dm = d.refDM; app.state.kind = 'waterfall'; R.curve = false; R.mode = 'sweep'; R.spd = snapTo(SPECS.spd().vals, PW.audio.suggestSpeed('sweep', d.period)); setTimeout(play, 400); } },
  ];
  $('#scenes').innerHTML = SCENES.map((s, i) => `<button class="key dark" data-act="scene:${i}"><span class="lamp"></span><em>${i + 1}</em>${s.t}</button>`).join('');
  function applyScene(i) {
    const d = ds(); UI.scene = i; stopSweep();
    $('#caption').innerHTML = `<b>${SCENES[i].t}.</b>${SCENES[i].c}`;
    if (!d || !d.loaded) return sync();
    if (SCENES[i].apply(d) === false) status('This pulsar has no known period, so it cannot be folded', 'warn');
    if (!isTime()) d.view.fold = { start: 0, dur: d.loaded.nsec };
    snapScrunch(); compute();
    if (R.curve) computeCurve();
  }
  let sweepRaf = null;
  function sweepTo(target, ms) {
    const d = ds(); if (!d) return; stopSweep();
    const d0 = R.bypassDM ? 0 : d.dm, t0 = performance.now(); R.bypassDM = false;
    const tick = now => { const u = Math.min(1, (now - t0) / ms); d.dm = d0 + (target - d0) * (1 - Math.pow(1 - u, 2.2)); app.update('compute'); reads(); ctls().forEach(el => el.dataset.p === 'dm' && PW.rack.sync(el, model));
      sweepRaf = u < 1 ? requestAnimationFrame(tick) : null; if (!sweepRaf) sync(); };
    sweepRaf = requestAnimationFrame(tick); sync();
  }
  /** Show another loaded pulsar at the same story step. */
  async function switchTo(id) { stopSweep(); if (UI.playing) stopPlay(); await app.select(id, true); applyScene(UI.scene); }
  function stopSweep() { if (sweepRaf) cancelAnimationFrame(sweepRaf); sweepRaf = null; }

  // ── audio ───────────────────────────────────────────────────────────────
  let player = null, sound = null, playRaf = null, followTimer = null;
  async function play() {
    const d = ds(); if (!d || !d.loaded) return;
    const keep = { dm: d.dm, mask: d.mask };
    if (R.bypassDM) d.dm = 0; if (R.bypassRFI) d.mask = new Uint8Array(d.header.nchans);
    let r;
    try {
      const o = { mode: R.mode, speed: R.spd, volume: 0.85 * R.vol };
      if (R.mode === 'sweep') Object.assign(o, { fLow: R.flo, fHigh: R.fhi, voices: R.voices });
      r = await app.renderAudio(o);
    } catch (e) { status('Sound failed: ' + (e.message || e), 'error'); }
    finally { d.dm = keep.dm; d.mask = keep.mask; }
    if (!r) return;
    player = player || new PW.audio.Player();
    sound = r; player.play(r.rendered, { loop: R.loop }); UI.playing = true;
    player.onended = () => { if (!R.loop) stopPlay(); };
    cancelAnimationFrame(playRaf);
    const ph = $('#playhead'), smp = r.rendered.samples, sr = r.rendered.sampleRate;
    const tick = () => {
      if (!player.isPlaying) { stopPlay(); return; }
      const pos = player.position(), tAbs = sound.viewStart + pos * sound.speed, p = app.product;
      let fx = null;
      if (p && isTime(p.kind)) fx = (tAbs - p.x.min) / (p.x.max - p.x.min);
      else if (p && d.period) { const u = tAbs / d.period + d.fold.phaseShift; fx = u - Math.floor(u); }
      if (fx != null && fx >= 0 && fx <= 1) { ph.style.display = 'block'; ph.style.left = (fx * 100) + '%'; } else ph.style.display = 'none';
      const i0 = Math.floor(pos * sr); let e = 0, n = 0; for (let k = Math.max(0, i0 - 1024); k < Math.min(smp.length, i0 + 1024); k++) { e += smp[k] * smp[k]; n++; }
      drawVU(clamp(Math.sqrt(e / Math.max(1, n)) * 3.2, 0, 1));
      playRaf = requestAnimationFrame(tick);
    };
    playRaf = requestAnimationFrame(tick); sync();
  }
  function stopPlay() { if (player) player.stop(true); cancelAnimationFrame(playRaf); UI.playing = false; $('#playhead').style.display = 'none'; drawVU(0); sync(); }
  function followAudio() { if (!UI.playing || !R.loop) return; clearTimeout(followTimer); followTimer = setTimeout(play, 450); }
  async function saveWav() {
    const d = ds(); if (!d) return;
    const o = { mode: R.mode, speed: R.spd, volume: 0.85 * R.vol }; if (R.mode === 'sweep') Object.assign(o, { fLow: R.flo, fHigh: R.fhi, voices: R.voices });
    const r = await app.renderAudio(o); if (!r) return;
    const blob = new Blob([PW.audio.toWAV(r.rendered.samples, r.rendered.sampleRate)], { type: 'audio/wav' }), a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `${d.src}_DM${d.dm.toFixed(2)}_${R.mode}_x${R.spd}.wav`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    status('Saved ' + a.download);
  }

  // ── enlarge the screen ──────────────────────────────────────────────────
  const scrHome = scr.parentElement, scrNext = scr.nextElementSibling;
  function enlarge(force) {
    UI.big = force != null ? force : !UI.big;
    if (UI.big) $('#bigslot').append(scr); else scrHome.insertBefore(scr, scrNext);
    $('#bigview').classList.toggle('show', UI.big);
    requestAnimationFrame(() => { drawMain(); sync(); });
  }

  // ── buttons and keys ────────────────────────────────────────────────────
  rack.addEventListener('click', e => {
    const b = e.target.closest('[data-act]'); if (!b || b.disabled) return;
    const a = b.dataset.act, d = ds();
    if (a.startsWith('scene:')) return applyScene(+a.slice(6));
    if (a.startsWith('kind:')) { if (!d) return; const k = a.slice(5); if (!isTime(k) && !d.period) return status('No period known for this pulsar', 'warn'); app.state.kind = k; if (!isTime(k)) d.view.fold = { start: 0, dur: d.loaded.nsec }; snapScrunch(); return compute(); }
    if (a.startsWith('ds:')) return switchTo(a.slice(3));
    switch (a) {
      case 'dm0': stopSweep(); if (d) { d.dm = 0; compute(); } break;
      case 'dmtrue': stopSweep(); if (d) { d.dm = d.refDM; compute(); } break;
      case 'sweep': if (sweepRaf) { stopSweep(); sync(); } else if (d) { d.dm = 0; sweepTo(d.refDM, 4000); } break;
      case 'auto': autoZap(); break;
      case 'clear': if (d) zap(d.mask.reduce((a2, m, i) => (m && a2.push(i), a2), []), 0); break;
      case 'undo': case 'redo': undoRedo(a); break;
      case 'play': UI.playing ? stopPlay() : play(); break;
      case 'drawer': UI.drawer = !UI.drawer; sync(); break;
      case 'enlarge': enlarge(); break;
      case 'folder': openFolder(rememberedDir); break;
      case 'files': pickFiles(); break;
      case 'demos': loadDemos(); break;
      case 'findperiod': app.findPeriod().then(sync); break;
      case 'centre': if (d && app.product) { const sh = app.centreShift(); if (sh != null) { d.fold.phaseShift = sh; compute(); } } break;
      case 'loadsection': if (d) app.loadSection({ tstart: R.secstart, nsec: Math.min(R.seclen, d.header.duration - R.secstart), tdec: R.res === 'auto' ? 'auto' : +R.res, maxValues: 120e6 }).then(() => { snapScrunch(); sync(); }); break;
      case 'wav': saveWav(); break;
    }
  });
  addEventListener('keydown', e => {
    if (e.target.closest && e.target.closest('input, textarea')) return;
    const d = ds(), k = e.key;
    if (k >= '1' && k <= '6' && !e.ctrlKey) return applyScene(+k - 1);
    if (k === ' ') { e.preventDefault(); return UI.playing ? stopPlay() : play(); }
    if ((e.ctrlKey || e.metaKey) && (k === 'z' || k === 'Z')) { e.preventDefault(); return undoRedo(e.shiftKey ? 'redo' : 'undo'); }
    if ((e.ctrlKey || e.metaKey) && (k === 'y' || k === 'Y')) { e.preventDefault(); return undoRedo('redo'); }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (k === 'ArrowRight' || k === 'ArrowLeft') { if (!d) return; e.preventDefault(); const s = SPECS.dm(); return model.set('dm', PW.rack.fromFrac(s, PW.rack.frac(s, d.dm) + (k === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 0.05 : 0.004))); }
    if (k === 'ArrowUp' || k === 'ArrowDown') { if (!d) return; e.preventDefault(); const s = SPECS.win(); return model.set('win', PW.rack.fromFrac(s, PW.rack.frac(s, app.view.dur) + (k === 'ArrowUp' ? -0.08 : 0.08))); }
    if (k === ',' || k === '.') { if (!d) return; const s = SPECS.pos(); return model.set('pos', clamp(app.view.start + (k === '.' ? 1 : -1) * app.view.dur * 0.25, s.min, s.max)); }
    switch (k.toLowerCase()) {
      case 'd': UI.drawer = !UI.drawer; return sync();
      case 'v': return model.set('vintage', !R.vintage);
      case 'f': return enlarge();
      case 'escape': if (UI.big) return enlarge(false); if (UI.drawer) { UI.drawer = false; return sync(); } return;
      case 'p': { const l = app.datasets; if (l.length > 1) switchTo(l[(l.indexOf(d) + 1) % l.length].id); return; }
      case 'o': return pickFiles();
      case 'm': { const v = SPECS.mode().vals; return model.set('mode', v[(v.indexOf(R.mode) + 1) % v.length]); }
      case 'b': return model.set('bypassDM', !R.bypassDM);
    }
  });

  // ── wear and tear, screws, layout ───────────────────────────────────────
  function wear(unit, seed) {
    let s = seed * 9301 + 49297; const rnd = () => (s = (s * 9301 + 49297) % 233280) / 233280;
    const w = 960, h = 260; let paths = '';
    for (let i = 0; i < 14; i++) { const x = rnd() * w, y = rnd() * h, l = 20 + rnd() * 90, a = (rnd() - 0.5) * 0.5, c = (rnd() - 0.5) * 14;
      paths += `<path d="M${x},${y} q${l / 2},${c} ${l * Math.cos(a)},${l * Math.sin(a)}" stroke="rgba(255,255,255,${0.04 + rnd() * 0.07})" stroke-width="${0.6 + rnd() * 0.8}" fill="none"/>`; }
    for (let i = 0; i < 5; i++) paths += `<ellipse cx="${rnd() * w}" cy="${rnd() * h}" rx="${20 + rnd() * 60}" ry="${8 + rnd() * 20}" fill="rgba(0,0,0,${0.05 + rnd() * 0.06})"/>`;
    for (let i = 0; i < 3; i++) paths += `<ellipse cx="${rnd() * w}" cy="${rnd() * h}" rx="${30 + rnd() * 80}" ry="${10 + rnd() * 25}" fill="rgba(255,255,255,${0.02 + rnd() * 0.03})"/>`;
    unit.insertAdjacentHTML('afterbegin', `<svg class="wear" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${paths}</svg>`);
  }
  $$('.unit').forEach((u, i) => {
    wear(u, +(u.dataset.seed || i + 1));
    const ear = side => `<div class="ear ${side}"><span class="slot" style="top:10px"><span class="screw" style="--a:${(i * 47 + (side === 'l' ? 20 : 110)) % 180}deg"></span></span><span class="slot" style="bottom:10px"><span class="screw" style="--a:${(i * 31 + (side === 'l' ? 75 : 5)) % 180}deg"></span></span></div>`;
    u.insertAdjacentHTML('afterbegin', ear('l') + ear('r'));
  });
  function layout() {
    const iw = innerWidth, ih = innerHeight;
    const H = R.aspect === '16:9' ? 1080 : R.aspect === '16:10' ? 1200 : Math.round(clamp(1920 * ih / iw, 1000, 1320));
    rack.style.setProperty('--H', H + 'px');
    SCALE = Math.min(iw / 1920, ih / H); rack.style.transform = `scale(${SCALE})`; rack.__scale = SCALE;
    requestAnimationFrame(() => { ctls().forEach(el => el.dataset.type === 'patch' && PW.rack.build(el, model)); redrawAll(); });
  }
  addEventListener('resize', layout);

  // ── boot ────────────────────────────────────────────────────────────────
  rack.classList.toggle('plain', !R.vintage);
  $('#caption').innerHTML = `<b>${SCENES[0].t}.</b>${SCENES[0].c}`;
  $('#splash').classList.add('show');
  (document.fonts ? document.fonts.ready : Promise.resolve()).then(() => { buildAll(); layout(); startup(); });
})();
