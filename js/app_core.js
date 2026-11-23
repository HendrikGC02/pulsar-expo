// app_core.js — shared state + processing pipeline for the Studio and Expo apps.
//
//   state --(engine.compute, in a worker)--> product --> Plot2D (2D)
//                                                   \--> heights.prepare -> mesh.build -> View3D
//
// Each opened .fil is a "dataset" with its own worker, loaded section and
// data-dependent settings (DM, period, view window, mask...). Look settings
// (colour map, 3D shape...) are shared.
(function () {
  const g = (typeof self !== 'undefined') ? self : window;
  g.PW = g.PW || {};

  const TIME_KINDS = ['waterfall', 'timeseries', 'bowtie'];
  const FOLD_KINDS = ['pulsestack', 'foldspec', 'profile'];
  const KIND_LABELS = {
    waterfall: 'Waterfall (frequency × time)',
    timeseries: 'Time series',
    pulsestack: 'Pulse stack (Joy Division)',
    foldspec: 'Folded spectrum (frequency × phase)',
    profile: 'Average pulse profile',
    bowtie: 'DM–time "bowtie"',
  };

  const MESH_PRESETS = {
    desk:   { label: 'Desk model (blocks)', mesh: { style: 'blocks', sizeX: 120, sizeY: 80, base: 3, relief: 15 },
              heights: { floorPct: 5, clipPct: 99.9, gamma: 0.5, sigma: 0, invert: false, log: false } },
    smooth: { label: 'Smooth landscape', mesh: { style: 'smooth', sizeX: 120, sizeY: 80, base: 3, relief: 15, upsample: 3 },
              heights: { floorPct: 5, clipPct: 99.9, gamma: 0.6, sigma: 0.8, invert: false, log: false } },
    joy:    { label: 'Joy Division ridges', kind: 'pulsestack', mesh: { style: 'fins', sizeX: 100, sizeY: 120, base: 3, relief: 14, finThickness: 1.2 },
              heights: { floorPct: 30, clipPct: 99.95, gamma: 0.8, sigma: 0.6, invert: false, log: false } },
    litho:  { label: 'Lithophane (backlit plate)', mesh: { style: 'smooth', sizeX: 150, sizeY: 100, base: 0.8, relief: 2.4, upsample: 2 },
              heights: { floorPct: 2, clipPct: 99.5, gamma: 0.8, sigma: 0.6, invert: true, log: false }, labels: false },
    tower:  { label: 'Lighthouse tower (polar)', kind: 'pulsestack', mesh: { style: 'polar', polar: { innerRadius: 20, amplitude: 14, height: 80, plinth: 4 } },
              heights: { floorPct: 30, clipPct: 99.95, gamma: 0.8, sigma: 0.8, invert: false, log: false } },
  };

  // Per-file memory of the period / DM the user settled on (localStorage).
  // Keyed by file name, size and start MJD, so a renamed copy is a new file.
  const MEMO_KEY = 'pulsarWeb.files';
  const memo = {
    key: (file, h) => `${file.name}|${file.size}|${(+h.tstart || 0).toFixed(8)}`,
    all() { try { return JSON.parse(localStorage.getItem(MEMO_KEY) || '{}'); } catch (e) { return {}; } },
    get(k) { return this.all()[k] || null; },
    put(k, rec) {
      const a = this.all();
      if (rec) a[k] = rec; else delete a[k];
      try { localStorage.setItem(MEMO_KEY, JSON.stringify(a)); } catch (e) { /* private window */ }
    },
  };
  const KDM = 4.148808e-3;   // s GHz² per unit DM

  function defaults() {
    return {
      kind: 'waterfall',
      plot: { cmap: 'Greys', vminPct: 5, vmaxPct: 99.5, style: 'heatmap', lineAmp: 3, lineCount: 0,
              showSeries: true, seriesPos: 'above', flipY: false },
      heights: { floorPct: 5, clipPct: 99.9, gamma: 0.5, sigma: 0, log: false, invert: false, maxCells: 300,
                 aa: 'peak', aaOversample: 4, aaWidth: 1 },
      mesh: { style: 'blocks', sizeX: 120, sizeY: 80, base: 3, relief: 15, upsample: 3,
              finThickness: 1.2, finSink: 1.0, finUpsample: 2, finFill: true,
              // integrated pulse (column average) as an extra strip / ridge at one end
              avg: { show: false, edge: 'back', gap: 3, depth: 8, height: 1 },
              polar: { innerRadius: 20, amplitude: 14, height: 80, plinth: 4 },
              colorBy: 'cmap' },
      labels: {
        enabled: true, relief: 0.8, tickLen: 1.5, tickWidth: 0.8, fitBase: true, margin: 6,
        title: { show: true, auto: true, text: '', edge: 'back', face: 'side', size: 6 },
        // braille copy of the plot title (uncontracted UEB); edge 'auto' = the edge with no other text
        braille: { show: true, auto: true, text: '', edge: 'auto', face: 'side', dotHeight: 0.8, cellPitch: 6.0 },
        x: { show: true, edge: 'front', face: 'side', title: '', units: '', origin: 'start', numbers: true, marks: true,
             mode: 'auto', count: 5, step: 0, list: '', decimals: -1, minor: 1, labelSize: 4.5, tickSize: 4, showTitle: true },
        y: { show: true, edge: 'left', face: 'side', title: '', units: '', origin: 'start', numbers: true, marks: true,
             mode: 'auto', count: 4, step: 0, list: '', decimals: -1, minor: 1, labelSize: 4.5, tickSize: 4, showTitle: true },
      },
      printer: 'K2',
      bowtie: { nDM: 128, nsub: 64 },
      audio: { mode: 'whistle', speed: 0.1, loop: false, volume: 0.8 },
      live3D: true,
    };
  }

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  /** The embossing font is plain ASCII: spell out superscripts and Greek. */
  function fontSafe(s) {
    const map = { '⁻': '-', '¹': '1', '²': '2', '³': '3', 'µ': 'u', 'μ': 'u', '×': 'x', 'ν': 'nu', '–': '-', '—': '-', '·': '.' };
    return String(s || '').replace(/[^\x20-\x7e]/g, (c) => map[c] != null ? map[c] : '');
  }
  /** Average every `f` consecutive rows of a row-major grid. */
  function averageRows(a, nx, ny, f) {
    const oy = Math.ceil(ny / f), out = new Float32Array(nx * oy);
    for (let j = 0; j < oy; j++) {
      const y1 = Math.min(ny, (j + 1) * f), n = y1 - j * f;
      for (let y = j * f; y < y1; y++) for (let x = 0; x < nx; x++) out[j * nx + x] += a[y * nx + x] / n;
    }
    return { grid: out, ny: oy };
  }
  /** Columns [i0, i1) of a row-major grid. */
  function cropCols(a, nx, ny, i0, i1) {
    const w = i1 - i0, out = new Float32Array(w * ny);
    for (let j = 0; j < ny; j++) out.set(a.subarray(j * nx + i0, j * nx + i1), j * w);
    return out;
  }
  /** Phase window [lo, hi] (cycles) as whole bins [i0, i1) of nb, or null for the full turn. */
  function phaseBins(nb, lo, hi) {
    lo = clamp(lo == null ? 0 : lo, 0, 1); hi = clamp(hi == null ? 1 : hi, 0, 1);
    if (!(hi > lo)) return null;
    const i0 = clamp(Math.floor(lo * nb + 1e-6), 0, nb - 2);
    const i1 = clamp(Math.ceil(hi * nb - 1e-6), i0 + 2, nb);
    return (i0 === 0 && i1 === nb) ? null : [i0, i1];
  }
  /** Keep bins [i0, i1) of a fold product (grid, profile strip and phase axis). */
  function cropPhase(p, i0, i1) {
    const nb = p.nx, x = p.x, span = x.max - x.min;
    p.grid = cropCols(p.grid, nb, p.ny, i0, i1);
    if (p.series && p.series.length === nb) p.series = p.series.slice(i0, i1);
    p.nx = i1 - i0;
    p.x = Object.assign({}, x, { min: x.min + span * i0 / nb, max: x.min + span * i1 / nb });
    if (p.seriesX) p.seriesX = { min: p.x.min, max: p.x.max };
    p.meta.phaseWin = { i0, i1, nb };
    return p;
  }
  function divisors(n) { const d = []; for (let i = 1; i <= n; i++) if (n % i === 0) d.push(i); return d; }
  function nearestDivisor(n, want) {
    let best = 1;
    for (const d of divisors(n)) if (Math.abs(Math.log(d / want)) < Math.abs(Math.log(best / want))) best = d;
    return best;
  }

  // Build plates (mm) of the printers we know; '' = no printer (bed grows with the model)
  const PRINTERS = { K2: { label: 'Creality K2', bed: 260 }, 'K2 Pro': { label: 'Creality K2 Pro', bed: 300 },
                     'K2 Plus': { label: 'Creality K2 Plus', bed: 350 } };

  // Unit choices for the printed axes, as factors from the product's own unit
  const UNIT_CONV = { s: { s: 1, ms: 1e3 }, MHz: { MHz: 1, GHz: 1e-3 }, cycles: { cycles: 1, degrees: 360 } };

  /** Axis range + title as printed: optional time origin at the view start and unit change. */
  function printedAxis(ax, A) {
    let min = ax.min, max = ax.max, unit = ax.unit || '';
    if (unit === 's' && A.origin === 'start') { max -= min; min = 0; }
    const f = UNIT_CONV[ax.unit] && A.units ? UNIT_CONV[ax.unit][A.units] : null;
    if (f) { min *= f; max *= f; unit = A.units; }
    const title = A.title || (unit && unit !== 'arb.' ? `${ax.label} (${unit})` : ax.label);
    return { min, max, unit, title };
  }

  function fmtTick(v, A, all) {
    if (A.decimals >= 0) return v.toFixed(A.decimals);
    const step = all.length > 1 ? Math.abs(all[1] - all[0]) : Math.abs(v) || 1;
    if (Math.abs(v) < step * 1e-6) return '0';
    const d = Math.max(0, Math.min(6, -Math.floor(Math.log10(step) + 1e-9)));
    return (+v.toFixed(d)).toString();
  }

  /** Tick list [{pos 0..1, text, minor}] for a printed axis of length lenMM. */
  function axisTicks(lo, hi, A, lenMM) {
    if (!(hi > lo)) return [];
    const span = hi - lo;
    const inRange = (v) => v >= lo - span * 1e-9 && v <= hi + span * 1e-9;
    let major = [], step = 0;
    if (A.mode === 'list') {
      major = String(A.list || '').split(/[\s,;]+/).map(parseFloat).filter(v => isFinite(v) && inRange(v)).sort((a, b) => a - b);
    } else if (A.mode === 'step' && A.step > 0 && span / A.step <= 400) {
      step = A.step;
      for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + step * 1e-9; v += step) major.push(v);
    } else if (A.mode === 'count') {
      major = PW.ui.niceTicks(lo, hi, Math.max(1, A.count || 5)).filter(inRange);
    } else {
      // auto: the most ticks whose numbers still fit along the printed length
      for (let n = 8; n >= 2; n--) {
        major = PW.ui.niceTicks(lo, hi, n).filter(inRange);
        const chars = Math.max(...major.map(v => fmtTick(v, A, major).length));
        const gap = major.length > 1 ? (major[1] - major[0]) / span * lenMM : lenMM;
        if (gap >= (chars * 0.62 + 1.0) * (A.tickSize || 4) || n === 2) break;      // bold digit ~0.56 em wide
      }
    }
    if (!step && major.length > 1 && A.mode !== 'list') step = major[1] - major[0];
    const out = major.map(v => ({ pos: (v - lo) / span, text: A.numbers === false ? '' : fmtTick(v, A, major) }));
    const nm = Math.max(0, Math.round(A.minor || 0));
    if (nm && step > 0 && major.length) {
      const ms = step / (nm + 1), first = Math.ceil((lo - major[0]) / ms - 1e-9);
      for (let k = first; k < first + 4000; k++) {
        const v = major[0] + k * ms;
        if (v > hi + span * 1e-9) break;
        if (((k % (nm + 1)) + nm + 1) % (nm + 1) !== 0 && inRange(v)) out.push({ pos: (v - lo) / span, minor: true });
      }
    }
    return out;
  }

  class App {
    /**
     * opts = { plotEl, view3dEl, fontScale, maxValues, defaultLoadSec }
     */
    constructor(opts) {
      this.opts = Object.assign({ maxValues: 120e6, defaultLoadSec: 10 }, opts || {});
      this.state = defaults();
      this.datasets = [];
      this.ds = null;
      this.product = null;
      this.meshData = null;
      this.listeners = {};
      this.plot = opts.plotEl ? new PW.Plot2D(opts.plotEl, { fontScale: opts.fontScale || 1 }) : null;
      this.view3d = opts.view3dEl ? new PW.View3D(opts.view3dEl, opts.view3dOpts) : null;
      this._meshTimer = null;
      this._busy = 0;
    }

    // ── events ──────────────────────────────────────────────────────────
    on(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); return this; }
    emit(ev, a) { for (const fn of (this.listeners[ev] || [])) { try { fn(a); } catch (e) { console.error(e); } } }
    status(msg, kind) { this.emit('status', { msg, kind: kind || 'info' }); }

    // ── datasets ────────────────────────────────────────────────────────
    /** Open a .fil File: new worker, header, catalogue lookup, default load. */
    async openFile(file, loadOpts) {
      const engine = new PW.Engine();
      let res;
      try { res = await engine.open(file); }
      catch (e) { engine.terminate(); throw new Error(`${file.name}: ${e.message || e}`); }
      const header = res.header || res;
      // by source name, then the file name, then the pointing
      const cat = g.identifyPulsar ? g.identifyPulsar(header, file.name) : g.findPulsar ? g.findPulsar(header.source_name) : null;
      const src = cat && cat.matchedBy !== 'name' ? cat.jname : (header.source_name || file.name.replace(/\.fil$/i, ''));
      const memoKey = memo.key(file, header), saved = memo.get(memoKey);
      let period = (cat && g.periodAt) ? g.periodAt(cat, header.tstart) : (header.period || null);
      let periodSource = cat ? 'catalogue' : (period ? 'header' : 'none');
      const refDM = (cat && cat.DM != null) ? cat.DM : (saved && saved.dm != null) ? saved.dm : (header.refdm || 0);
      let dm = refDM;
      if (saved) {
        if (saved.period) { period = saved.period; periodSource = 'saved'; }
        if (saved.dm != null) dm = saved.dm;
      }
      const ds = {
        id: Math.random().toString(36).slice(2, 8),
        file, name: file.name, src, header, engine, cat, memoKey, saved, predispersed: !!(saved && saved.predispersed),
        refDM, dm, period, periodSource,
        wfDispersed: false, bandpass: true, mask: new Uint8Array(header.nchans),
        tscrunch: 1, fscrunch: nearestDivisor(header.nchans, header.nchans / 256),
        view: { time: { start: 0, dur: 1 }, fold: { start: 0, dur: 1 } },
        fold: { nbins: 256, phaseShift: 0, pulsesPerRow: 1, autoCentre: true, phaseLo: 0, phaseHi: 1 },
        bowtie: { dmMin: 0, dmMax: Math.max(10, refDM * 2) },
        loaded: null, loadReq: null,
      };
      this.datasets.push(ds);
      this.emit('datasets', this.datasets);
      const dur = header.duration || (header.nsamplesTotal * header.tsamp);
      const lo = Object.assign({ tstart: 0, nsec: Math.min(dur, this.opts.defaultLoadSec), tdec: 'auto', maxValues: this.opts.maxValues }, loadOpts || {});
      await this.select(ds.id, true);
      await this.loadSection(lo);
      if (cat && !saved && this.opts.checkOnOpen !== false) await this.checkCatalogue(ds);
      return ds;
    }

    /**
     * After opening a catalogue pulsar: if the data fold far better at DM 0 than
     * at the catalogue DM, the file was dedispersed when it was recorded
     * (coherent dedispersion) and DM 0 is used; then the period is refined for
     * the Doppler shift (Earth's motion, binary orbits), if that clearly helps.
     */
    checkCatalogue(ds) { return this._queued(() => this._checkCatalogue(ds)); }
    async _checkCatalogue(ds) {
      if (!ds.loaded || !ds.period || this.ds !== ds) return;
      const notes = [];
      try {
        if (ds.refDM >= 1) {
          const r = await ds.engine.compute(this._searchReq(ds, { kind: 'dmsearch', dmMin: 0, dmMax: ds.refDM, nDM: 2,
            dm0: ds.refDM, exact: true, period: ds.period }), 'search');
          if (r && !r.stale && r.snr[0] > 8 && r.snr[0] > 2 * r.snr[1]) {
            ds.dm = 0; ds.predispersed = true;
            notes.push(`the pulse is sharpest at DM 0, not the catalogue's ${ds.refDM.toFixed(2)}: this file was dedispersed when it was recorded`);
          }
        }
        const P0 = ds.period, P = await this._findPeriod({ auto: true });
        if (P) notes.push(`period refined by ${((P / P0 - 1) * 100).toFixed(4)} % for the Doppler shift`);
      } catch (e) { console.warn('checkCatalogue', e); }
      if (notes.length) {
        this.status(`${ds.src}: ${notes.join('; ')}.`);
        this.emit('dataset', ds);
        if (this.ds === ds) this.update('compute');
      }
    }

    /**
     * Searches run one after another: they share the worker's 'search' channel
     * (a newer request there makes a waiting one stale) and change ds.dm/period.
     */
    _queued(fn) {
      const run = (this._searchTail || Promise.resolve()).then(() => { this._busy++; return fn(); }).finally(() => { this._busy--; });
      this._searchTail = run.catch(() => {});
      return run;
    }

    /** Request fields shared by the searches: the fold window (or all of memory), no scrunching. */
    _searchReq(ds, extra) {
      const v = ds.period ? ds.view.fold : { start: 0, dur: ds.loaded.nsec };
      return Object.assign({ dm: ds.dm, viewStart: v.start, viewDur: v.dur, bandpass: ds.bandpass, mask: ds.mask.slice(),
        tscrunch: 1, fscrunch: 1, nbins: Math.min(128, ds.fold.nbins) }, extra);
    }

    /** Store fields (period, dm, ...) for this file; they are applied when it is opened again. */
    rememberFile(fields, ds) {
      ds = ds || this.ds;
      if (!ds) return null;
      const rec = Object.assign({}, ds.saved || {}, fields, { src: ds.src, savedAt: new Date().toISOString() });
      memo.put(ds.memoKey, rec);
      ds.saved = rec;
      if (!ds.cat && rec.dm != null) ds.refDM = rec.dm;
      this.emit('dataset', ds);
      return rec;
    }

    forgetFile(ds) {
      ds = ds || this.ds;
      if (!ds) return;
      memo.put(ds.memoKey, null);
      ds.saved = null;
      this.emit('dataset', ds);
    }

    /** Switch active dataset. */
    async select(id, noCompute) {
      const ds = this.datasets.find(d => d.id === id);
      if (!ds) return;
      this.ds = ds;
      this.emit('dataset', ds);
      if (!noCompute && ds.loaded) this.update('compute');
    }

    closeDataset(id) {
      const i = this.datasets.findIndex(d => d.id === id);
      if (i < 0) return;
      this.datasets[i].engine.terminate();
      this.datasets.splice(i, 1);
      this.emit('datasets', this.datasets);
      if (this.ds && this.ds.id === id) {
        this.ds = this.datasets[0] || null;
        this.emit('dataset', this.ds);
        if (this.ds) this.update('compute');
      }
    }

    /** Load [tstart, tstart+nsec) of the active file into its worker. */
    async loadSection(lo) {
      const ds = this.ds;
      if (!ds) return;
      const pr = PW.ui ? PW.ui.progress(`Loading ${ds.name} …`) : null;
      this._busy++;
      try {
        const info = await ds.engine.load(lo, (f) => pr && pr.set(f, `Loading ${ds.name} … ${(100 * f).toFixed(0)}%`));
        ds.loaded = info;
        ds.loadReq = lo;
        this._defaultViews(ds);
        this.emit('loaded', ds);
        this.status(`Loaded ${info.nsec.toFixed(3)} s of ${ds.name} at ${(info.dt * 1e6).toFixed(1)} µs` +
          (info.tdec > 1 ? ` (pre-averaged ×${info.tdec})` : ' (full resolution)'));
        this.update('compute');
      } finally {
        this._busy--;
        pr && pr.done();
      }
    }

    _defaultViews(ds) {
      const L = ds.loaded, P = ds.period;
      const tdur = clamp(P ? P * 12 : 1, Math.min(L.nsec, 20 * L.dt), L.nsec);
      ds.view.time = { start: 0, dur: tdur };
      ds.view.fold = { start: 0, dur: L.nsec };
      ds.tscrunch = Math.max(1, Math.round(tdur / L.dt / 900));
      if (P) {
        ds.fold.nbins = clamp(Math.pow(2, Math.floor(Math.log2(P / L.dt))), 16, 256);
        ds.fold.pulsesPerRow = Math.max(1, Math.ceil(L.nsec / P / 256));   // millisecond pulsars: about 256 rows, not thousands
      }
      const span = Math.max(5, ds.refDM * 0.6);
      ds.bowtie = { dmMin: Math.max(0, ds.refDM - span), dmMax: ds.refDM + span };
    }

    // ── state helpers ───────────────────────────────────────────────────
    family(kind) { return FOLD_KINDS.includes(kind || this.state.kind) ? 'fold' : 'time'; }
    get view() { return this.ds ? this.ds.view[this.family()] : null; }
    needsPeriod(kind) { return FOLD_KINDS.includes(kind || this.state.kind); }

    /** Auto time-scrunch giving ~`cols` columns over the current view. */
    autoTscrunch(cols) {
      const ds = this.ds; if (!ds || !ds.loaded) return 1;
      return Math.max(1, Math.round(this.view.dur / ds.loaded.dt / (cols || 900)));
    }

    /**
     * Mark something dirty: 'compute' (new data product), 'mesh' (rebuild 3D
     * only), 'plot' (redraw 2D only).
     */
    update(level) {
      if (level === 'compute') return this._compute();
      if (level === 'mesh') return this._scheduleMesh();
      if (level === 'plot') return this._drawPlot();
    }

    buildRequest(extra) {
      const ds = this.ds, st = this.state, v = this.view;
      const req = {
        kind: st.kind, dm: ds.dm,
        viewStart: v.start, viewDur: v.dur,
        // folded kinds use the full loaded resolution (the engine would pre-smooth by tscrunch)
        tscrunch: FOLD_KINDS.includes(st.kind) ? 1 : ds.tscrunch, fscrunch: ds.fscrunch,
        bandpass: ds.bandpass, mask: ds.mask.slice(),
        period: ds.period || 1, nbins: ds.fold.nbins, phaseShift: ds.fold.phaseShift,
        pulsesPerRow: ds.fold.pulsesPerRow,
        dmMin: ds.bowtie.dmMin, dmMax: ds.bowtie.dmMax, nDM: st.bowtie.nDM,
        nsub: Math.min(st.bowtie.nsub, ds.header.nchans),
      };
      if (st.kind === 'waterfall' && ds.wfDispersed) req.wfDM = 0;
      return Object.assign(req, extra || {});
    }

    async _compute() {
      const ds = this.ds;
      if (!ds || !ds.loaded) return;
      if (this.needsPeriod() && !ds.period) {
        this.status('Folding needs a period: type one in (seconds) or use "Find period".', 'warn');
        return;
      }
      const req = this.buildRequest();
      const t0 = performance.now();
      let p;
      try { p = await ds.engine.compute(req, 'main'); }
      catch (e) { console.error(e); this.status('Compute failed: ' + (e.message || e), 'error'); return; }
      if (!p || p.stale || ds !== this.ds) return;
      p.meta = p.meta || {};
      p.meta.computeMs = performance.now() - t0;
      // First fold of a dataset: rotate the pulse to the middle of the phase axis
      if (FOLD_KINDS.includes(p.kind) && ds.fold.autoCentre && p.series) {
        ds.fold.autoCentre = false;
        const sh = this.centreShift(p);
        if (sh != null && Math.abs(sh - ds.fold.phaseShift) > 1 / p.series.length) {
          ds.fold.phaseShift = sh;
          this.emit('dataset', ds);
          return this._compute();
        }
      }
      if (FOLD_KINDS.includes(p.kind)) {
        p.meta.fullSeries = p.kind === 'profile' ? p.grid : p.series;
        const w = phaseBins(p.nx, ds.fold.phaseLo, ds.fold.phaseHi);
        if (w) cropPhase(p, w[0], w[1]);
      }
      this.product = p;
      this._drawPlot();
      this.emit('product', p);
      this._scheduleMesh();
    }

    /** Phase shift that puts the profile peak of a fold product at phase 0.5. */
    centreShift(p) {
      p = p || this.product;
      const ds = this.ds;
      if (!p || !FOLD_KINDS.includes(p.kind)) return null;
      const s = (p.meta && p.meta.fullSeries) || p.series;        // whole turn, even when zoomed in
      if (!s) return null;
      const n = s.length;
      // light circular smoothing so a noisy spike doesn't win
      let best = 0, bv = -Infinity;
      for (let i = 0; i < n; i++) {
        const v = s[(i - 1 + n) % n] + 2 * s[i] + s[(i + 1) % n];
        if (v > bv) { bv = v; best = i; }
      }
      const peak = (best + 0.5) / n;
      let sh = ds.fold.phaseShift + (0.5 - peak);   // u = t/P + shift, so +shift moves the pulse later
      return ((sh + 0.5) % 1 + 1) % 1 - 0.5;
    }

    /**
     * Extent of the pulse in the full folded profile, as phase distances left
     * and right of its peak: the bins above 15 % of the peak, padded by half
     * their width each side (so the pulse fills about half the window).
     */
    pulseExtent(p) {
      p = p || this.product;
      if (!p || !FOLD_KINDS.includes(p.kind)) return null;
      const r = (p.meta && p.meta.fullSeries) || p.series;
      if (!r) return null;
      const n = r.length, s = new Float32Array(n);
      for (let i = 0; i < n; i++) s[i] = (r[(i - 1 + n) % n] + 2 * r[i] + r[(i + 1) % n]) / 4;
      const sorted = Float32Array.from(s).sort();
      const base = sorted[n >> 1], top = sorted[n - 1];
      if (!(top > base)) return null;
      let pk = 0;
      for (let i = 1; i < n; i++) if (s[i] > s[pk]) pk = i;
      const thr = base + 0.15 * (top - base);
      let a = 0, b = 0;                                // bins left / right of the peak, circular
      while (a < n / 2 && s[(pk - a - 1 + n) % n] > thr) a++;
      while (b < n / 2 && s[(pk + b + 1) % n] > thr) b++;
      const pad = Math.max(2, Math.ceil(0.5 * (a + b + 1)));
      return { left: (a + pad + 0.5) / n, right: (b + pad + 0.5) / n };
    }

    /** Finest useful number of phase bins (one loaded sample per bin). */
    maxBins() {
      const ds = this.ds;
      return ds && ds.period && ds.loaded ? Math.max(16, Math.floor(ds.period / ds.loaded.dt)) : 8192;
    }

    plotTitle() {
      const ds = this.ds, p = this.product;
      if (!ds) return '';
      const nick = ds.cat && ds.cat.nickname ? `  ·  ${ds.cat.nickname}` : '';
      return `${ds.src}${nick}`;
    }
    plotSubtitle() {
      const ds = this.ds, p = this.product;
      if (!ds || !p) return '';
      const parts = [KIND_LABELS[p.kind] || p.kind];
      if (p.kind === 'waterfall' && ds.wfDispersed) parts.push(`image at DM 0 (dispersed), series at DM ${ds.dm.toFixed(2)}`);
      else if (p.kind !== 'bowtie') parts.push(`DM ${ds.dm.toFixed(2)}`);
      if (this.needsPeriod(p.kind) && ds.period) parts.push(`P ${(ds.period * 1e3).toFixed(4)} ms`);
      const binW = (p.x.max - p.x.min) / p.nx;     // seconds (time kinds) or cycles (fold kinds)
      if (PW.FOLD_KINDS.includes(p.kind) && ds.period) parts.push(`${(binW * ds.period * 1e3).toFixed(3)} ms/bin`);
      else if (!PW.FOLD_KINDS.includes(p.kind)) parts.push(`${(binW * 1e3).toFixed(3)} ms/bin`);
      if (p.meta && isFinite(p.meta.snr)) parts.push(`S/N ${p.meta.snr.toFixed(1)}`);
      return parts.join('  ·  ');
    }

    plotOptions(extra) {
      const st = this.state, ds = this.ds;
      const o = Object.assign({}, st.plot, { title: this.plotTitle(), subtitle: this.plotSubtitle() });
      if (this._overlayDisp && this.product && this.product.kind === 'waterfall') {
        o.overlay = { dispersion: Object.assign({ fhi: ds.header.fhi, flo: ds.header.flo }, this._overlayDisp) };
      }
      return Object.assign(o, extra || {});
    }

    /** Dispersion-curve overlay anchored at time t0 (product X units), or null. */
    setDispersionOverlay(t0, dm) {
      this._overlayDisp = (t0 == null) ? null : { t0, dm: dm != null ? dm : this.ds.refDM };
      this._drawPlot();
    }

    _drawPlot() {
      if (this.plot && this.product) this.plot.draw(this.product, this.plotOptions());
    }

    // ── 3D ──────────────────────────────────────────────────────────────
    _scheduleMesh() {
      if (!this.state.live3D || !this.view3d || !this.view3d.visible()) { this._meshDirty = true; return; }
      if (this._meshTimer) return;
      this._meshTimer = setTimeout(() => { this._meshTimer = null; this.rebuildMesh(); }, 30);
    }

    /** Called by UIs when the 3D panel becomes visible again. */
    show3D() { if (this._meshDirty || !this.meshData) this.rebuildMesh(); }

    /**
     * The braille title as it will be printed: { text, edge, cells, unicode, skipped },
     * or null when braille is off.  Text defaults to the source name at the head
     * of the plot title; edge 'auto' picks the first of right, left, back, front that has
     * no title or axis text on it (else it goes under the title).
     */
    brailleInfo(p) {
      const st = this.state, ds = this.ds, L = st.labels, B = L && L.braille;
      p = p || this.product;
      if (!B || !B.show || !L.enabled || st.mesh.style === 'polar' || !g.PW.braille) return null;
      const auto = ds ? String(ds.src || '') : '';      // nicknames are phrases: too long for one braille line
      const text = B.auto || !B.text ? auto : B.text;
      let edge = B.edge;
      if (!edge || edge === 'auto') {
        const used = new Set();
        if (L.title.show) used.add(L.title.edge);
        if (L.x.show) used.add(L.x.edge);
        if (L.y.show && !(p && p.ny <= 1)) used.add(L.y.edge);
        edge = ['right', 'left', 'back', 'front'].find(e => !used.has(e)) || L.title.edge || 'back';
      }
      return Object.assign({ text, edge }, g.PW.braille.translate(text));
    }

    /** yMap {off, frac}: the data occupies that fraction of the depth (the rest is the integrated pulse). */
    meshOptions(p, yMap) {
      const st = this.state, ds = this.ds;
      const m = JSON.parse(JSON.stringify(st.mesh));
      m.colorLUT = (st.mesh.colorBy === 'cmap' && g.COLORMAPS) ? g.COLORMAPS[st.plot.cmap] : null;
      const L = st.labels;
      if (L.enabled && p && m.style !== 'polar') {
        const out = { enabled: true, relief: L.relief, tickLen: L.tickLen, tickWidth: L.tickWidth, minorFrac: 0.55,
          fitBase: L.fitBase, margin: L.margin };
        for (const k of ['x', 'y']) {
          const A = L[k];
          if (!A || !A.show || (k === 'y' && p.ny <= 1)) { out[k] = null; continue; }
          const ax = printedAxis(p[k], A), ym = k === 'y' && yMap ? yMap : null;
          let ticks = (A.marks !== false || A.numbers !== false) ? axisTicks(ax.min, ax.max, A, k === 'x' ? m.sizeX : m.sizeY * (ym ? ym.frac : 1)) : [];
          if (ym) ticks = ticks.map(t => Object.assign({}, t, { pos: ym.off + t.pos * ym.frac }));
          out[k] = { edge: A.edge, face: A.face, label: A.showTitle === false ? '' : fontSafe(ax.title),
            labelSize: A.labelSize, tickSize: A.tickSize, marks: A.marks !== false, ticks };
        }
        const bi = this.brailleInfo(p);
        if (bi && bi.cells.some(c => c)) out.braille = { cells: bi.cells, edge: bi.edge, face: L.braille.face, dotHeight: L.braille.dotHeight, cellPitch: L.braille.cellPitch };
        const T = L.title;
        if (T && T.show) {
          out.titleText = fontSafe(T.auto || !T.text ? `${ds.src}${ds.cat && ds.cat.nickname ? '  ' + ds.cat.nickname : ''}  DM ${ds.dm.toFixed(2)}` : T.text);
          out.titleEdge = T.edge; out.titleFace = T.face; out.titleSize = T.size;
        }
        m.labels = out;
      } else m.labels = { enabled: false };
      return m;
    }

    /**
     * Oversampled copy of the current product for anti-aliased heights: the same
     * request with k-times finer time (or phase) bins, so heights.prepare can
     * reduce it with a ridge-preserving filter instead of a plain average.
     */
    async _fineSource(p) {
      const ds = this.ds, H = this.state.heights;
      if (!ds || !ds.loaded || !p.meta) return null;
      const pw = p.meta.phaseWin, nb = pw ? pw.nb : p.nx;     // fold kinds: bins over the whole turn
      let S = Math.max(1, Math.round(H.aaOversample || 4));
      while (S > 1 && nb * S * p.ny > 16e6) S--;
      let extra, k = 1;
      if (TIME_KINDS.includes(p.kind)) {
        const ts = p.meta.tscrunch || 1, tsf = Math.max(1, Math.round(ts / S));
        k = ts / tsf;                                   // may be fractional; heights.reduceX copes
        extra = { tscrunch: tsf };
      } else {
        const maxNb = ds.period ? Math.floor(ds.period / ds.loaded.dt) : nb;
        k = Math.min(S, Math.floor(maxNb / nb));
        extra = { nbins: nb * k };
      }
      if (k <= 1.01) return null;
      const req = this.buildRequest(extra);
      const key = JSON.stringify(req);
      if (this._fine && this._fine.key === key && this._fine.ds === ds) return this._fine.src;
      const r = await ds.engine.compute(req, 'mesh');
      if (!r || r.stale || r.ny !== p.ny) return null;
      // same span as the product: the phase window, or the whole columns of the time view
      const i0 = pw ? pw.i0 * k : 0, i1 = pw ? pw.i1 * k : Math.min(r.nx, Math.floor(p.nx * k + 1e-6));
      let grid = r.grid, series = r.kind === 'profile' ? r.grid : r.series;
      if (i0 !== 0 || i1 !== r.nx) {
        grid = cropCols(grid, r.nx, r.ny, i0, i1);
        series = series && series.length === r.nx ? series.slice(i0, i1) : null;
      }
      const src = { grid, nx: i1 - i0, ny: r.ny, factor: k, series };
      this._fine = { key, ds, src };
      return src;
    }

    async rebuildMesh() {
      const p = this.product;
      if (!p) return null;
      this._meshDirty = false;
      const seq = this._meshSeq = (this._meshSeq || 0) + 1;
      const t0 = performance.now();
      try {
        const H = this.state.heights;
        let src = { grid: p.grid, nx: p.nx, ny: p.ny, factor: 1, series: p.series };
        if (H.aa && H.aa !== 'off') {
          const fine = await this._fineSource(p).catch((e) => { console.warn(e); return null; });
          if (seq !== this._meshSeq || p !== this.product) return this.meshData;   // superseded
          if (fine) src = fine;
        }
        let grid = src.grid, ny = src.ny;
        const ms = this.state.mesh, avg = ms.avg && ms.avg.show && ny > 1 && ms.style !== 'polar';
        if (ms.style === 'fins' && ny > 1) {
          // Separate ridges closer than ~1.6x their thickness fuse together, and
          // touching ones narrower than 0.8 mm can't print: average rows down.
          const availY = avg ? Math.max(ms.sizeY * 0.3, ms.sizeY - ms.avg.gap) : ms.sizeY;
          const maxRows = Math.max(2, Math.floor(availY / (ms.finFill ? 0.8 : Math.max(0.8, ms.finThickness) * 1.6)));
          if (ny > maxRows) ({ grid, ny } = averageRows(grid, src.nx, ny, Math.ceil(ny / maxRows)));
        }
        const hopts = Object.assign({}, H, { targetNx: p.nx });
        let hm = PW.heights.prepare(grid, src.nx, ny, hopts), yMap = null, rowSkip = null;
        if (avg) ({ hm, yMap, rowSkip } = this._withAverage(hm, src, grid, ny, hopts));
        const mo = this.meshOptions(p, yMap);
        mo.rowSkip = rowSkip;
        const mesh = PW.mesh.build(hm, mo);
        mesh.buildMs = performance.now() - t0;
        mesh.oversample = src.factor;
        this.meshData = mesh;
        if (this.view3d) this.view3d.setMesh(mesh);
        this.emit('mesh', mesh);
        return mesh;
      } catch (e) {
        console.error(e);
        this.status('3D build failed: ' + (e.message || e), 'error');
        return null;
      }
    }

    /**
     * Add the integrated pulse to one end of a height map: the product's own
     * strip (dedispersed series / folded profile) where it has one, otherwise the
     * column average, scaled 0..1 on its own (linear, baseline at the 10th
     * percentile).  Rows keep the uniform row pitch: blocks / smooth get `depth`
     * mm of profile rows, ridges one extra ridge; `gap` mm of empty rows sit in
     * between (flat plate for blocks / smooth, no ridge at all for ridges).
     */
    _withAverage(hm, src, grid, ny, hopts) {
      const ms = this.state.mesh, A = ms.avg, nx = src.nx;
      let s = src.series && src.series.length === nx ? src.series : null;
      if (!s) {
        s = new Float32Array(nx);
        for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) s[i] += grid[j * nx + i] / ny;
      }
      const ph = PW.heights.prepare(s, nx, 1, Object.assign({}, hopts, { floorPct: 10, clipPct: 100, gamma: 1, log: false }));
      if (ph.nx !== hm.nx) return { hm, yMap: null, rowSkip: null };
      const fins = ms.style === 'fins', nyM = hm.ny, W = hm.nx;
      let pitch = fins ? (ms.sizeY - A.gap) / (nyM + 1) : (ms.sizeY - A.gap - A.depth) / nyM;
      if (!(pitch > 0)) pitch = ms.sizeY * 0.5 / nyM;
      const gR = Math.max(0, Math.round(A.gap / pitch));
      const pR = fins ? 1 : Math.max(1, Math.round(A.depth / pitch));
      const R = nyM + gR + pR, back = A.edge !== 'front';
      const z = new Float32Array(R * W);
      const m0 = back ? 0 : gR + pR, p0 = back ? nyM + gR : 0;
      z.set(hm.z, m0 * W);
      for (let j = 0; j < pR; j++) for (let i = 0; i < W; i++) z[(p0 + j) * W + i] = ph.z[i] * A.height;
      let rowSkip = null;
      if (fins && gR) { rowSkip = new Uint8Array(R); rowSkip.fill(1, back ? nyM : pR, back ? nyM + gR : pR + gR); }
      return { hm: { z, nx: W, ny: R, lo: hm.lo, hi: hm.hi }, yMap: { off: m0 / R, frac: nyM / R }, rowSkip };
    }

    applyMeshPreset(name) {
      const pr = MESH_PRESETS[name];
      if (!pr) return;
      const st = this.state;
      Object.assign(st.heights, pr.heights || {});
      const m = JSON.parse(JSON.stringify(pr.mesh || {}));
      if (m.polar) { Object.assign(st.mesh.polar, m.polar); delete m.polar; }
      Object.assign(st.mesh, m);
      if (pr.labels === false) st.labels.enabled = false;
      if (pr.kind && pr.kind !== st.kind && this.ds && (this.ds.period || !this.needsPeriod(pr.kind))) {
        st.kind = pr.kind;
        this.emit('kind', st.kind);
        this.update('compute');
      } else this.update('mesh');
      this.emit('state', st);
    }

    // ── tools ───────────────────────────────────────────────────────────
    /**
     * Refine the folding period by maximising profile S/N (two passes).
     * opts.auto: keep the result only if it is a clear detection that beats
     * the starting period, and leave the status line to the caller.
     */
    findPeriod(opts) { return this._queued(() => this._findPeriod(opts)); }
    async _findPeriod(opts) {
      const ds = this.ds, o = opts || {};
      if (!ds || !ds.loaded) return null;
      let P = ds.period;
      const P0 = P;
      if (!P) { this.status('Type in an approximate period first (the pulsar is not in the catalogue).', 'warn'); return null; }
      const base = this._searchReq(ds, { kind: 'periodsearch' });
      // Coarse: ±0.05 % covers Doppler (1e-4) + catalogue drift; fine pass ±0.002 %.
      let snr0 = null, best = 0;
      for (const [range, n] of [[5e-4, 401], [2e-5, 201]]) {
        const r = await ds.engine.compute(Object.assign({}, base, { period: P, range, nTrials: n }), 'search');
        if (!r || r.stale || !r.bestPeriod) return null;
        if (snr0 == null) snr0 = r.snr[(n - 1) >> 1];
        P = r.bestPeriod; best = r.bestSnr;
      }
      if (o.auto && !(best >= 7 && best > 1.15 * snr0 && ds.period === P0)) return null;
      ds.period = P; ds.periodSource = 'search';
      if (!o.auto) this.status(`Best folding period ${(P * 1e3).toFixed(6)} ms (S/N ${best.toFixed(1)})`);
      this.emit('dataset', ds);
      if (!o.auto && this.needsPeriod()) this.update('compute');
      return P;
    }

    /**
     * Find the DM that gives the sharpest pulse between lo and hi: the folded
     * profile when the period is known, else the brightest single pulse in
     * memory. Coarse pass over the range, then a fine pass around the peak.
     * Returns {dm, snr} or null.
     */
    findDM(lo, hi) { return this._queued(() => this._findDM(lo, hi)); }
    async _findDM(lo, hi) {
      const ds = this.ds;
      if (!ds || !ds.loaded) return null;
      const h = ds.header, L = ds.loaded;
      const sweep = KDM * (1e6 / (h.flo * h.flo) - 1e6 / (h.fhi * h.fhi));   // s across the band per unit DM
      const fine = L.dt / sweep;                                              // DM step that moves the sweep one sample
      const base = this._searchReq(ds, { kind: 'dmsearch', period: ds.period || null });
      lo = Math.max(0, lo || 0);
      const top = ds.period ? Infinity : Math.max(lo, 0.8 * base.viewDur / sweep);   // unfolded, the sweep must fit in memory
      const clipped = hi > top;
      hi = Math.min(hi, top);
      if (!(hi > lo)) { this.status('Load a longer section to search to higher DM.', 'warn'); return null; }
      this.status(`Searching DM ${lo.toFixed(1)}–${hi.toFixed(1)} …`);
      let r = null;
      if (ds.period) {
        // fold every channel once, then trials only rotate the channel profiles:
        // a coarse pass a phase bin apart, then a fine pass at 4x the bins
        const P = ds.period, pow2 = (x, a, b) => clamp(Math.pow(2, Math.floor(Math.log2(x))), a, b);
        const nb1 = pow2(P / L.dt, 16, 64), nb2 = pow2(P / L.dt, 16, 256);
        const nC = Math.min(6000, Math.ceil((hi - lo) / (P / nb1 / sweep)) + 1);
        r = await ds.engine.compute(Object.assign({}, base, { nbins: nb1, dmMin: lo, dmMax: hi, nDM: nC }), 'search');
        if (!r || r.stale) return null;
        const c = (hi - lo) / (nC - 1), a = Math.max(lo, r.bestDM - 2 * c), b = Math.min(hi, r.bestDM + 2 * c);
        const nF = Math.min(201, Math.max(9, Math.ceil((b - a) / (P / nb2 / sweep / 2)) + 1));
        r = await ds.engine.compute(Object.assign({}, base, { nbins: nb2, dmMin: a, dmMax: b, nDM: nF }), 'search');
      } else {
        // single pulses: subbands dedispersed at the centre of each of a few DM segments,
        // so the low-frequency subbands are not smeared far from it; then a fine pass at the peak
        const NS = 64, B = Math.max(1, Math.floor(h.nchans / NS)) * Math.abs(h.foff) / 1000, fl = h.flo / 1000;
        const smear = KDM * (1 / (fl * fl) - 1 / ((fl + B) * (fl + B))) / L.dt;   // samples per unit DM, lowest subband
        const nSeg = Math.min(8, Math.max(1, Math.ceil((hi - lo) * smear / 3)));
        const step = Math.max((hi - lo) / 120, 6 * fine);
        for (let k = 0; k < nSeg; k++) {
          const a = lo + (hi - lo) * k / nSeg, b = lo + (hi - lo) * (k + 1) / nSeg;
          const q = await ds.engine.compute(Object.assign({}, base, { dmMin: a, dmMax: b, nDM: Math.max(3, Math.ceil((b - a) / step) + 1), dm0: (a + b) / 2, nsub: NS }), 'search');
          if (!q || q.stale) return null;
          if (!r || q.bestSnr > r.bestSnr) r = q;
        }
        const a = Math.max(lo, r.bestDM - 2 * step), b = Math.min(hi, r.bestDM + 2 * step);
        const nF = Math.min(121, Math.max(9, Math.ceil((b - a) / (fine / 2)) + 1));
        r = await ds.engine.compute(Object.assign({}, base, { dmMin: a, dmMax: b, nDM: nF, dm0: r.bestDM, nsub: NS }), 'search');
      }
      if (!r || r.stale) return null;
      // the brightest of thousands of boxcars reaches ~5 by chance, so single pulses need more
      const what = ds.period ? 'folded pulse' : 'single pulse', need = ds.period ? 6 : 8;
      if (!(r.bestSnr >= need)) {
        this.status(`No clear ${what} between DM ${lo.toFixed(1)} and ${hi.toFixed(1)} (best S/N ${r.bestSnr.toFixed(1)}).`, 'warn');
        return null;
      }
      ds.dm = Math.max(0, +r.bestDM.toFixed(3));
      ds.predispersed = !!(ds.cat && ds.cat.DM >= 1 && ds.dm < 0.25 * ds.cat.DM);
      let msg = `Sharpest ${what} at DM ${ds.dm.toFixed(3)} (S/N ${r.bestSnr.toFixed(1)})`;
      if (ds.predispersed) msg += `; the catalogue says ${ds.cat.DM.toFixed(2)}, so this file was dedispersed when it was recorded`;
      if (clipped) msg += `; searched only up to ${hi.toFixed(1)}, as far as the section in memory allows`;
      this.status(msg + '.');
      this.emit('dataset', ds);
      this.update('compute');
      return { dm: ds.dm, snr: r.bestSnr };
    }

    /** Flag RFI channels automatically (adds to the current mask). */
    async autoZap(sigma) {
      const ds = this.ds;
      if (!ds || !ds.loaded) return 0;
      const r = await ds.engine.compute({ kind: 'rfi', rfiSigma: sigma || 6, bandpass: ds.bandpass,
        viewStart: 0, viewDur: ds.loaded.nsec, dm: 0, tscrunch: 1, fscrunch: 1 }, 'search');
      if (!r || r.stale || !r.mask) return 0;
      let n = 0;
      for (let c = 0; c < r.mask.length; c++) if (r.mask[c] && !ds.mask[c]) { ds.mask[c] = 1; n++; }
      this.status(n ? `Zapped ${n} channels` : 'No obvious RFI channels found');
      this.emit('dataset', ds);
      this.update('compute');
      return n;
    }

    clearMask() { if (!this.ds) return; this.ds.mask.fill(0); this.emit('dataset', this.ds); this.update('compute'); }

    /** Toggle the mask for the channel at frequency f (MHz). */
    zapFrequency(fMHz, width) {
      const ds = this.ds, h = ds.header;
      const c = Math.round((fMHz - h.fch1) / h.foff);
      const w = Math.max(1, width || ds.fscrunch);
      const c0 = Math.floor(c / w) * w;
      const val = ds.mask[clamp(c, 0, h.nchans - 1)] ? 0 : 1;
      for (let k = c0; k < c0 + w; k++) if (k >= 0 && k < h.nchans) ds.mask[k] = val;
      this.emit('dataset', ds);
      this.update('compute');
    }

    // ── audio ───────────────────────────────────────────────────────────
    /** Render audio for the current view. Returns {rendered, viewStart, speed}. */
    async renderAudio(aopts) {
      const ds = this.ds;
      if (!ds || !ds.loaded) return null;
      const o = Object.assign({}, PW.audio.DEFAULTS ? PW.audio.DEFAULTS[aopts.mode] : {}, aopts);
      const speed = o.speed || 1, maxDur = o.maxDuration || 30;
      const v = this.view, L = ds.loaded;
      // At least `minAudio` seconds of sound: a zoomed-in view (e.g. 70 ms of
      // J0437) would otherwise be over before anyone hears it. The window
      // grows to the right (and back to the left if the section ends).
      const minAudio = o.minAudio != null ? o.minAudio : 6;
      const dur = Math.min(L.nsec, Math.max(v.dur, minAudio * speed), maxDur * speed);
      const start = Math.max(0, Math.min(v.start, L.nsec - dur));
      // envelope sampled at >= ~2 kHz of *audio* time
      const ts = Math.max(1, Math.floor(speed / (2000 * L.dt)));
      const common = { dm: ds.dm, viewStart: start, viewDur: dur, tscrunch: ts, bandpass: ds.bandpass, mask: ds.mask.slice() };
      const tsP = await ds.engine.compute(Object.assign({ kind: 'timeseries', fscrunch: 1 }, common), 'audio');
      if (!tsP || tsP.stale) return null;
      let sub = null;
      if (o.mode === 'whistle' || o.mode === 'sweep') {
        const nsub = o.voices || 20;
        const fs = Math.max(1, Math.floor(ds.header.nchans / nsub));
        const dmSub = (this.state.kind === 'waterfall' && ds.wfDispersed) ? 0 : ds.dm;
        const sp = await ds.engine.compute(Object.assign({ kind: 'waterfall', fscrunch: fs }, common, { dm: dmSub }), 'audio');
        if (!sp || sp.stale) return null;
        sub = { grid: sp.grid, nx: sp.nx, ny: sp.ny };
      }
      const dt = (tsP.x.max - tsP.x.min) / tsP.nx;   // bin width after time scrunching
      const rendered = PW.audio.render({ ts: tsP.grid, dt, sub, period: ds.period || null }, o);
      return { rendered, viewStart: start, speed: rendered.speed || speed, dataDur: dur, dt };
    }

    // ── export ──────────────────────────────────────────────────────────
    baseName() {
      const ds = this.ds, st = this.state;
      if (!ds) return 'pulsar';
      return `${ds.src}_DM${ds.dm.toFixed(2)}_${st.kind}`.replace(/[^\w.+-]+/g, '_');
    }

    async exportSTL() {
      const m = this.meshData || await this.rebuildMesh();
      if (!m) return;
      const name = `${this.baseName()}_${this.state.mesh.style}.stl`;
      PW.ui.download(PW.mesh.toSTL(m, `${this.ds.src} DM ${this.ds.dm.toFixed(2)}`), name, 'model/stl');
      this.status(`Saved ${name} (${m.ntri.toLocaleString()} triangles)`);
    }

    async exportOBJ() {
      const m = this.meshData || await this.rebuildMesh();
      if (!m) return;
      const name = `${this.baseName()}_${this.state.mesh.style}.obj`;
      PW.ui.download(PW.mesh.toOBJ(m), name, 'text/plain');
      this.status(`Saved ${name}`);
    }

    /** 3MF: one object with the model and the raised labels as separate parts. */
    async export3MF() {
      const m = this.meshData || await this.rebuildMesh();
      if (!m) return;
      const name = `${this.baseName()}_${this.state.mesh.style}.3mf`;
      this.status(`Writing ${name} …`);
      await new Promise(r => setTimeout(r, 20));        // let the status paint
      const u8 = await PW.mesh.to3MF(m, { name: `${this.ds.src} DM ${this.ds.dm.toFixed(2)}` });
      PW.ui.download(new Blob([u8], { type: 'model/3mf' }), name);
      const lab = m.parts.find(q => q.name === 'labels');
      this.status(`Saved ${name}` + (lab ? ' (model and labels as two parts)' : ''));
    }

    async exportPNG(w, h) {
      if (!this.plot || !this.product) return;
      const blob = await this.plot.toPNG(w || 3840, h || 2160, this.plotOptions());
      const name = `${this.baseName()}_${w || 3840}x${h || 2160}.png`;
      PW.ui.download(blob, name, 'image/png');
      this.status(`Saved ${name}`);
    }

    async export3DPNG() {
      if (!this.view3d) return;
      const blob = await this.view3d.screenshot(2);
      PW.ui.download(blob, `${this.baseName()}_${this.state.mesh.style}_3d.png`, 'image/png');
    }

    /** Everything needed to reproduce the current model (not the data itself). */
    preset() {
      const ds = this.ds;
      const out = { app: 'pulsar_web', version: 1, savedAt: new Date().toISOString(), state: this.state };
      if (ds) {
        const maskList = []; ds.mask.forEach((m, i) => { if (m) maskList.push(i); });
        out.dataset = { file: ds.name, src: ds.src, load: ds.loadReq, dm: ds.dm, period: ds.period,
          wfDispersed: ds.wfDispersed, bandpass: ds.bandpass, mask: maskList, tscrunch: ds.tscrunch,
          fscrunch: ds.fscrunch, view: ds.view, fold: ds.fold, bowtie: ds.bowtie };
      }
      return out;
    }

    savePreset() {
      PW.ui.download(JSON.stringify(this.preset(), null, 2), `${this.baseName()}_preset.json`, 'application/json');
    }

    /** Apply a preset object. Reloads the section if it differs. */
    async applyPreset(pr) {
      if (!pr || !pr.state) throw new Error('Not a pulsar_web preset');
      const d0 = defaults();
      const merge = (a, b) => { for (const k in b) { if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && a[k] && typeof a[k] === 'object') merge(a[k], b[k]); else a[k] = b[k]; } return a; };
      this.state = merge(d0, pr.state);
      const ds = this.ds, d = pr.dataset;
      if (ds && d) {
        if (d.file && d.file !== ds.name) this.status(`Preset was made with ${d.file}; applying to ${ds.name}`, 'warn');
        const L = d.load;
        if (L && ds.loadReq && (Math.abs(L.tstart - ds.loadReq.tstart) > 1e-6 || Math.abs(L.nsec - ds.loadReq.nsec) > 1e-6 || L.tdec !== ds.loadReq.tdec)) {
          await this.loadSection(L);
        }
        Object.assign(ds, { dm: d.dm, period: d.period, wfDispersed: d.wfDispersed, bandpass: d.bandpass,
          tscrunch: d.tscrunch, fscrunch: d.fscrunch, view: d.view, fold: d.fold, bowtie: d.bowtie });
        ds.mask.fill(0); (d.mask || []).forEach(i => { if (i < ds.mask.length) ds.mask[i] = 1; });
        this.emit('dataset', ds);
      }
      this.emit('state', this.state);
      this.emit('kind', this.state.kind);
      this.update('compute');
    }
  }

  g.PW.App = App;
  g.PW.KIND_LABELS = KIND_LABELS;
  g.PW.TIME_KINDS = TIME_KINDS;
  g.PW.FOLD_KINDS = FOLD_KINDS;
  g.PW.MESH_PRESETS = MESH_PRESETS;
  g.PW.PRINTERS = PRINTERS;
  g.PW.UNIT_CONV = UNIT_CONV;
  g.PW.axisTicks = axisTicks;
  g.PW.divisors = divisors;
  g.PW.nearestDivisor = nearestDivisor;
})();
