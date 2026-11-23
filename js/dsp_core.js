// dsp_core.js -- pulsar filterbank DSP core (port of filview.py).
//
// `PW_dspCore` is ONE self-contained top-level function so the engine can ship
// it into a Web Worker via PW_dspCore.toString().  It must not reference any
// variable outside its own body (only standard JS and FileReader[Sync]).
//
// Storage model: the loaded section is kept channel-major (raw[c*N + t]),
// optionally pre-decimated in time by an integer `tdec` (sums of tdec samples).
// All kernels are channel-outer / time-inner so memory access is contiguous.
//
// Conventions:
//   * channel index c is the FILE channel index (c = 0 is fch1);
//   * output frequency axes are always LOW -> HIGH (row 0 = lowest frequency);
//   * all times in requests are seconds relative to the loaded section start.
function PW_dspCore() {
  'use strict';

  const KDM = 4.148808e-3;            // dispersion constant, s GHz^2 cm^3 / pc
  const CHUNK_BYTES = 32 * 1024 * 1024;

  // ------------------------------------------------------------------ reader
  // reader(file, start, end) -> ArrayBuffer | Promise<ArrayBuffer>
  let reader = null;

  /** Inject a custom reader (Node tests). */
  function setReader(fn) { reader = fn; }

  function defaultRead(file, start, end) {
    if (typeof FileReaderSync !== 'undefined') {
      return new FileReaderSync().readAsArrayBuffer(file.slice(start, end));
    }
    if (typeof FileReader !== 'undefined') {
      return new Promise(function (resolve, reject) {
        const fr = new FileReader();
        fr.onload = function () { resolve(fr.result); };
        fr.onerror = function () { reject(fr.error || new Error('read failed')); };
        fr.readAsArrayBuffer(file.slice(start, end));
      });
    }
    throw new Error('No file reader available (use setReader)');
  }

  function readBytes(file, start, end) {
    return (reader || defaultRead)(file, start, end);
  }

  // ------------------------------------------------------------------ header
  const DOUBLE_KEYS = ['az_start', 'za_start', 'src_raj', 'src_dej', 'tstart',
    'tsamp', 'fch1', 'foff', 'refdm', 'period', 'freq'];
  const INT_KEYS = ['machine_id', 'telescope_id', 'data_type', 'nchans', 'nbits',
    'nifs', 'nbeams', 'ibeam', 'nsamples', 'barycentric', 'pulsarcentric'];

  /**
   * Parse a sigproc header (same keys as filview.read_fil_header).
   * @param {ArrayBuffer} buf   first bytes of the file
   * @param {number} [fileSize] total file size, to derive nsamplesTotal
   */
  function parseHeader(buf, fileSize) {
    const dv = new DataView(buf);
    const u8 = new Uint8Array(buf);
    let pos = 0;
    function readString() {
      if (pos + 4 > u8.length) return '';
      const n = dv.getInt32(pos, true); pos += 4;
      if (n > 200 || n < 1) return '';
      let s = '';
      for (let i = 0; i < n; i++) s += String.fromCharCode(u8[pos + i]);
      pos += n;
      return s;
    }
    const h = {};
    const first = readString();
    if (first !== 'HEADER_START') {
      throw new Error('Not a filterbank file (got "' + first + '")');
    }
    for (;;) {
      if (pos >= u8.length) throw new Error('HEADER_END not found');
      const key = readString();
      if (key === 'HEADER_END') break;
      if (key === 'source_name' || key === 'rawdatafile') {
        h[key] = readString();
      } else if (DOUBLE_KEYS.indexOf(key) >= 0) {
        h[key] = dv.getFloat64(pos, true); pos += 8;
      } else if (INT_KEYS.indexOf(key) >= 0) {
        h[key] = dv.getInt32(pos, true); pos += 4;
      }
    }
    h.header_size = pos;
    // derived
    const bits = h.nchans * h.nbits;
    h.bytesPerSample = bits / 8;
    if (fileSize != null) {
      h.fileSize = fileSize;
      h.nsamplesTotal = Math.floor((fileSize - pos) / h.bytesPerSample);
      h.duration = h.nsamplesTotal * h.tsamp;
    }
    const last = h.fch1 + (h.nchans - 1) * h.foff;
    h.fhi = Math.max(h.fch1, last);
    h.flo = Math.min(h.fch1, last);
    return h;
  }

  /** Read and parse the header of `file` (needs file.size). */
  async function readHeader(file) {
    let n = 16384;
    for (;;) {
      const end = Math.min(file.size, n);
      const buf = await readBytes(file, 0, end);
      try {
        return parseHeader(buf, file.size);
      } catch (e) {
        if (end >= file.size || n >= (1 << 22)) throw e;
        n *= 4;
      }
    }
  }

  // -------------------------------------------------------------------- load
  /**
   * Load [tstart, tstart+nsec) transposed (and optionally time-decimated).
   * params: { tstart, nsec, tdec: 'auto'|int, maxValues }
   * Returns the section state (keep it; pass to compute()).
   */
  async function load(file, header, params, onProgress) {
    params = params || {};
    const nchans = header.nchans, nbits = header.nbits, tsamp = header.tsamp;
    if ((nchans * nbits) % 8 !== 0) throw new Error('nchans*nbits must be a multiple of 8');
    if ([1, 2, 4, 8, 16, 32].indexOf(nbits) < 0) throw new Error('Unsupported nbits=' + nbits);
    const bps = nchans * nbits / 8;
    const total = header.nsamplesTotal != null ? header.nsamplesTotal
      : Math.floor((file.size - header.header_size) / bps);
    let start = 0;
    if (params.tstart > 0) start = Math.min(Math.trunc(params.tstart / tsamp), total);
    let nsamp = total - start;
    if (params.nsec > 0) nsamp = Math.min(nsamp, Math.trunc(params.nsec / tsamp));
    if (nsamp < 1) throw new Error('Nothing to load (tstart beyond end of file?)');

    const maxValues = params.maxValues > 0 ? params.maxValues : 120e6;
    let tdec = params.tdec;
    if (tdec === 'auto' || tdec == null) {
      tdec = Math.max(1, Math.ceil(nsamp * nchans / maxValues));
      // make sure floor(nsamp/tdec)*nchans <= maxValues
      while (Math.floor(nsamp / tdec) * nchans > maxValues) tdec++;
    }
    tdec = Math.max(1, Math.round(tdec));
    const N = Math.floor(nsamp / tdec);
    if (N < 1) throw new Error('tdec too large for the loaded section');

    const maxval = nbits <= 8 ? (Math.pow(2, nbits) - 1) : Infinity;
    let raw;
    if (nbits <= 8 && tdec === 1) raw = new Uint8Array(nchans * N);
    else if (nbits <= 8 && tdec * maxval <= 65535) raw = new Uint16Array(nchans * N);
    else raw = new Float32Array(nchans * N);

    const usedSamples = N * tdec;
    const perChunk = Math.max(1, Math.floor(CHUNK_BYTES / bps));
    const fileOff = header.header_size + start * bps;
    let done = 0;
    while (done < usedSamples) {
      const ns = Math.min(perChunk, usedSamples - done);
      const buf = await readBytes(file, fileOff + done * bps, fileOff + (done + ns) * bps);
      if (buf.byteLength < ns * bps) throw new Error('Short read from file');
      unpackChunk(buf, ns, done, nbits, nchans, bps, tdec, N, raw);
      done += ns;
      if (onProgress) onProgress(0.95 * done / usedSamples);
    }

    // per-channel statistics (of the decimated, per-sample-mean data)
    const chanMean = new Float32Array(nchans), chanStd = new Float32Array(nchans);
    for (let c = 0; c < nchans; c++) {
      let s = 0, s2 = 0;
      const o = c * N;
      for (let t = 0; t < N; t++) { const v = raw[o + t]; s += v; s2 += v * v; }
      const m = s / N;
      const varr = Math.max(0, s2 / N - m * m);
      chanMean[c] = m / tdec;
      chanStd[c] = Math.sqrt(varr) / tdec;
    }
    if (onProgress) onProgress(1);

    return {
      header: header, raw: raw, N: N, nchans: nchans, tdec: tdec,
      dt: tsamp * tdec, tsamp: tsamp, startSample: start,
      tstart: start * tsamp, chanMean: chanMean, chanStd: chanStd,
      nsampFile: usedSamples,
    };
  }

  /** Summary of a loaded state (what Engine.load resolves with). */
  function stateInfo(st) {
    return {
      tdec: st.tdec, dt: st.dt, nsamp: st.N, tstart: st.tstart,
      nsec: st.N * st.dt, nchans: st.nchans,
      chanMean: st.chanMean, chanStd: st.chanStd,
    };
  }

  // Unpack one chunk of ns samples into raw (channel-major, += accumulate).
  function unpackChunk(buf, ns, s0, nbits, nchans, bps, tdec, N, raw) {
    let bytes = null, u16 = null, f32 = null;
    if (nbits === 16) u16 = new Uint16Array(buf, 0, ns * nchans);
    else if (nbits === 32) f32 = new Float32Array(buf, 0, ns * nchans);
    else bytes = new Uint8Array(buf, 0, ns * bps);
    for (let s = 0; s < ns; s++) {
      const to = Math.floor((s0 + s) / tdec);
      if (to >= N) break;
      let idx = to;
      if (nbits === 8) {
        const bo = s * bps;
        for (let c = 0; c < nchans; c++, idx += N) raw[idx] += bytes[bo + c];
      } else if (nbits === 2) {
        // LSB-first: bits 1:0 = first channel
        const bo = s * bps;
        for (let j = 0; j < bps; j++) {
          const b = bytes[bo + j];
          raw[idx] += b & 3; idx += N;
          raw[idx] += (b >> 2) & 3; idx += N;
          raw[idx] += (b >> 4) & 3; idx += N;
          raw[idx] += (b >> 6) & 3; idx += N;
        }
      } else if (nbits === 4) {
        // high nibble first
        const bo = s * bps;
        for (let j = 0; j < bps; j++) {
          const b = bytes[bo + j];
          raw[idx] += (b >> 4) & 15; idx += N;
          raw[idx] += b & 15; idx += N;
        }
      } else if (nbits === 1) {
        const bo = s * bps;
        for (let j = 0; j < bps; j++) {
          const b = bytes[bo + j];
          for (let k = 0; k < 8; k++) { raw[idx] += (b >> k) & 1; idx += N; }
        }
      } else if (nbits === 16) {
        const bo = s * nchans;
        for (let c = 0; c < nchans; c++, idx += N) raw[idx] += u16[bo + c];
      } else {
        const bo = s * nchans;
        for (let c = 0; c < nchans; c++, idx += N) raw[idx] += f32[bo + c];
      }
    }
  }

  // ----------------------------------------------------------------- helpers
  function chanFreqMHz(st, c) { return st.header.fch1 + c * st.header.foff; }

  /** Delay in loaded samples of every channel relative to the highest frequency. */
  function delaySamples(st, dm) {
    const n = st.nchans, d = new Int32Array(n);
    if (!(dm > 0)) return d;
    const fref = st.header.fhi / 1000;
    const iref = 1 / (fref * fref);
    for (let c = 0; c < n; c++) {
      const f = chanFreqMHz(st, c) / 1000;
      d[c] = Math.round(KDM * dm * (1 / (f * f) - iref) / st.dt);
    }
    return d;
  }

  function sortedCopy(a) {
    const b = new Float64Array(a.length);
    for (let i = 0; i < a.length; i++) b[i] = a[i];
    b.sort();
    return b;
  }
  function medianSorted(b) {
    const n = b.length;
    if (n === 0) return 0;
    return n & 1 ? b[(n - 1) >> 1] : 0.5 * (b[n / 2 - 1] + b[n / 2]);
  }
  /** (max - median) / (1.4826 MAD) */
  function robustSnr(a) {
    const n = a.length;
    if (n === 0) return 0;
    const b = sortedCopy(a);
    const med = medianSorted(b);
    let mx = -Infinity;
    for (let i = 0; i < n; i++) { const v = a[i]; if (v > mx) mx = v; }
    for (let i = 0; i < n; i++) b[i] = Math.abs(b[i] - med);
    b.sort();
    let mad = 1.4826 * medianSorted(b);
    if (!(mad > 0)) {
      // degenerate (flat) data: fall back to std
      let s = 0, s2 = 0;
      for (let i = 0; i < n; i++) { s += a[i]; s2 += a[i] * a[i]; }
      mad = Math.sqrt(Math.max(0, s2 / n - (s / n) * (s / n)));
      if (!(mad > 0)) return 0;
    }
    return (mx - med) / mad;
  }

  /** Per-channel weights on the stored (summed) data. */
  function makeWeights(st, bandpass, mask) {
    const n = st.nchans, w = new Float32Array(n);
    for (let c = 0; c < n; c++) {
      if (mask && mask[c]) { w[c] = 0; continue; }
      if (bandpass) {
        const m = st.chanMean[c];
        w[c] = 1 / ((m === 0 ? 1 : m) * st.tdec);
      } else w[c] = 1 / st.tdec;
    }
    return w;
  }

  /**
   * Channel grouping.  fs >= 1: groups of fs consecutive FILE channels
   * (remainder dropped from the end, like filview); fs = 0: one group of all
   * channels.  Output row 0 is the LOWEST frequency.
   */
  function makeGroups(st, fs, mask) {
    const n = st.nchans, foff = st.header.foff;
    const ocOf = new Int32Array(n).fill(-1);
    let ng, gs;
    if (!fs) { ng = 1; gs = n; } else { gs = Math.min(fs, n); ng = Math.floor(n / gs); }
    const nActive = new Int32Array(ng);
    const fcen = new Float64Array(ng);
    const used = ng * gs;
    for (let c = 0; c < used; c++) {
      const g = Math.floor(c / gs);
      const oc = foff < 0 ? ng - 1 - g : g;
      fcen[oc] += chanFreqMHz(st, c) / gs;
      if (mask && mask[c]) continue;
      ocOf[c] = oc;
      nActive[oc]++;
    }
    let nTot = 0;
    for (let g = 0; g < ng; g++) nTot += nActive[g];
    const f0 = chanFreqMHz(st, 0), f1 = chanFreqMHz(st, used - 1);
    const half = Math.abs(foff) / 2;
    return {
      ocOf: ocOf, ncOut: ng, gs: gs, nActive: nActive, nActiveTotal: nTot,
      fcen: fcen, fmin: Math.min(f0, f1) - half, fmax: Math.max(f0, f1) + half,
    };
  }

  /**
   * Choose the view: t0 (loaded samples) and nview (fine samples) such that all
   * channels have data for every DM in `dms`; trims the end like filview.
   */
  function planView(st, req, dms, mask) {
    const N = st.N, dt = st.dt;
    let t0 = Math.round((req.viewStart || 0) / dt);
    t0 = Math.min(Math.max(0, t0), N - 1);
    const want = (req.viewDur > 0 && isFinite(req.viewDur))
      ? Math.max(1, Math.round(req.viewDur / dt)) : N - t0;
    let maxD = 0;
    for (let i = 0; i < dms.length; i++) {
      const d = delaySamples(st, dms[i]);
      for (let c = 0; c < st.nchans; c++) {
        if (mask && mask[c]) continue;
        if (d[c] > maxD) maxD = d[c];
      }
    }
    const avail = N - t0 - maxD;
    if (avail <= 0) throw new Error('Loaded section too short for this DM (max delay ' + maxD + ' samples)');
    const nview = Math.min(want, avail);
    return { t0: t0, nview: nview, maxDelay: maxD, trimmed: nview < want, want: want };
  }

  // ---------------------------------------------------------------- kernels
  // Regular (block) scrunch: out[to*ncOut + oc] += sum_{k<ts} raw[c, t0+d+to*ts+k]*w
  function accumBlock(st, w, ocOf, ncOut, d, t0, nt, ts, out) {
    const raw = st.raw, N = st.N, nch = st.nchans;
    for (let c = 0; c < nch; c++) {
      const oc = ocOf[c];
      if (oc < 0) continue;
      const wc = w[c];
      let p = c * N + t0 + d[c];
      if (ts === 1) {
        if (ncOut === 1) {
          for (let to = 0; to < nt; to++) out[to] += raw[p + to] * wc;
        } else {
          for (let to = 0, o = oc; to < nt; to++, o += ncOut) out[o] += raw[p + to] * wc;
        }
      } else {
        for (let to = 0, o = oc; to < nt; to++, o += ncOut) {
          let s = 0;
          for (let k = 0; k < ts; k++) s += raw[p++];
          out[o] += s * wc;
        }
      }
    }
  }

  // Target-map scrunch (fold): out[tgt[t]*ncOut + oc] += raw[c, t0+d+t]*w
  function accumTgt(st, w, ocOf, ncOut, d, t0, nview, tgt, out) {
    const raw = st.raw, N = st.N, nch = st.nchans;
    for (let c = 0; c < nch; c++) {
      const oc = ocOf[c];
      if (oc < 0) continue;
      const wc = w[c];
      const p = c * N + t0 + d[c];
      for (let t = 0; t < nview; t++) {
        const r = tgt[t];
        if (r >= 0) out[r * ncOut + oc] += raw[p + t] * wc;
      }
    }
  }

  // Fine-resolution subbands, subband-major: out[oc*stride + 1 + t] (stride = nview+1)
  function accumSub(st, w, ocOf, d, t0, nview, stride, out) {
    const raw = st.raw, N = st.N, nch = st.nchans;
    for (let c = 0; c < nch; c++) {
      const oc = ocOf[c];
      if (oc < 0) continue;
      const wc = w[c];
      const p = c * N + t0 + d[c];
      const o = oc * stride + 1;
      for (let t = 0; t < nview; t++) out[o + t] += raw[p + t] * wc;
    }
  }

  // Frequency-averaged fine dedispersed time series (Float64Array(nview)).
  function fineSeries(st, dm, w, mask, t0, nview, ts) {
    const g = makeGroups(st, 0, mask);
    if (g.nActiveTotal === 0) throw new Error('All channels are masked');
    const nt = Math.floor(nview / ts);
    const out = new Float64Array(nt);
    accumBlock(st, w, g.ocOf, 1, delaySamples(st, dm), t0, nt, ts, out);
    const norm = 1 / (ts * g.nActiveTotal);
    for (let i = 0; i < nt; i++) out[i] *= norm;
    return out;
  }

  // Circular linear interpolation of empty entries.  vals/cnt: arrays indexed
  // off + i*stride, i < n.
  function fillGaps(vals, cnt, off, n, stride) {
    let any = false;
    for (let i = 0; i < n; i++) if (cnt[off + i * stride] > 0) { any = true; break; }
    if (!any) return;
    const prev = new Int32Array(n), next = new Int32Array(n);
    let last = -1;
    for (let i = 0; i < 2 * n; i++) {
      const j = i % n;
      if (cnt[off + j * stride] > 0) last = i;
      if (i >= n) prev[j] = last - n; // may be negative index (wrap)
    }
    last = -1;
    for (let i = 2 * n - 1; i >= 0; i--) {
      const j = i % n;
      if (cnt[off + j * stride] > 0) last = i;
      if (i < n) next[j] = last;
    }
    for (let j = 0; j < n; j++) {
      if (cnt[off + j * stride] > 0) continue;
      const pi = prev[j], ni = next[j];
      const pv = vals[off + (((pi % n) + n) % n) * stride];
      const nv = vals[off + (ni % n) * stride];
      const a = j - pi, b = ni - j;
      vals[off + j * stride] = (pv * b + nv * a) / (a + b);
    }
  }

  function axisTime(label, min, max) { return { label: 'Time', unit: 's', min: min, max: max }; }
  const Y_INT = function () { return { label: 'Intensity', unit: 'arb.', min: 0, max: 1 }; };

  // -------------------------------------------------------------- product kinds
  function prepCommon(st, req) {
    const c = {};
    c.ts = Math.max(1, Math.round(req.tscrunch || 1));
    c.fs = Math.max(1, Math.round(req.fscrunch || 1));
    c.dm = Math.max(0, +req.dm || 0);
    c.bandpass = req.bandpass !== false;
    c.mask = req.mask || null;
    c.w = makeWeights(st, c.bandpass, c.mask);
    return c;
  }

  function baseMeta(st, c, v) {
    return {
      dm: c.dm, dt: st.dt, tscrunch: c.ts, fscrunch: c.fs,
      viewStart: v.t0 * st.dt, viewDur: v.nview * st.dt, trimmed: v.trimmed,
      maxDelaySamples: v.maxDelay, bandpass: c.bandpass, tdec: st.tdec,
      snr: 0, nPulses: 0, period: null,
    };
  }

  function kWaterfall(st, req) {
    const c = prepCommon(st, req);
    const wfDM = req.wfDM != null ? Math.max(0, +req.wfDM) : c.dm;
    const v = planView(st, req, [c.dm, wfDM], c.mask);
    const nt = Math.floor(v.nview / c.ts);
    if (nt < 1) throw new Error('tscrunch larger than the view');
    const g = makeGroups(st, c.fs, c.mask);
    if (g.nActiveTotal === 0) throw new Error('All channels are masked');
    const ncOut = g.ncOut;
    const grid = new Float32Array(nt * ncOut);
    accumBlock(st, c.w, g.ocOf, ncOut, delaySamples(st, wfDM), v.t0, nt, c.ts, grid);
    // normalise to a mean, then flip to row-major with row 0 = lowest frequency
    // (already low->high since ocOf is low->high); layout here is [t][oc], need [oc][t]
    const out = new Float32Array(nt * ncOut);
    for (let oc = 0; oc < ncOut; oc++) {
      const nrm = g.nActive[oc] > 0 ? 1 / (c.ts * g.nActive[oc]) : 0;
      const ob = oc * nt;
      for (let t = 0; t < nt; t++) out[ob + t] = grid[t * ncOut + oc] * nrm;
    }
    // series: freq-averaged at c.dm
    let series;
    if (wfDM === c.dm) {
      series = new Float32Array(nt);
      let tot = 0;
      for (let oc = 0; oc < ncOut; oc++) tot += g.nActive[oc];
      for (let oc = 0; oc < ncOut; oc++) {
        const f = g.nActive[oc] / tot, ob = oc * nt;
        if (f === 0) continue;
        for (let t = 0; t < nt; t++) series[t] += out[ob + t] * f;
      }
    } else {
      series = Float32Array.from(fineSeries(st, c.dm, c.w, c.mask, v.t0, v.nview, c.ts));
    }
    const x0 = v.t0 * st.dt, x1 = (v.t0 + nt * c.ts) * st.dt;
    const meta = baseMeta(st, c, v);
    meta.wfDM = wfDM; meta.viewDur = nt * c.ts * st.dt;
    meta.snr = robustSnr(series);
    meta.nchansUsed = g.nActiveTotal;
    return {
      kind: 'waterfall', grid: out, nx: nt, ny: ncOut,
      x: { label: 'Time', unit: 's', min: x0, max: x1 },
      y: { label: 'Frequency', unit: 'MHz', min: g.fmin, max: g.fmax },
      series: series, seriesX: { min: x0, max: x1 }, meta: meta,
    };
  }

  function kTimeseries(st, req) {
    const c = prepCommon(st, req);
    const v = planView(st, req, [c.dm], c.mask);
    const nt = Math.floor(v.nview / c.ts);
    if (nt < 1) throw new Error('tscrunch larger than the view');
    const grid = Float32Array.from(fineSeries(st, c.dm, c.w, c.mask, v.t0, v.nview, c.ts));
    const x0 = v.t0 * st.dt, x1 = (v.t0 + nt * c.ts) * st.dt;
    const meta = baseMeta(st, c, v);
    meta.viewDur = nt * c.ts * st.dt;
    meta.snr = robustSnr(grid);
    return {
      kind: 'timeseries', grid: grid, nx: nt, ny: 1,
      x: { label: 'Time', unit: 's', min: x0, max: x1 },
      y: Y_INT(), series: null, seriesX: null, meta: meta,
    };
  }

  // boxcar smoothing (centred) of a Float64Array, width m
  function boxcar(a, m) {
    if (m <= 1) return a;
    const n = a.length, out = new Float64Array(n), h = m >> 1;
    const P = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) P[i + 1] = P[i] + a[i];
    for (let i = 0; i < n; i++) {
      const lo = Math.max(0, i - h), hi = Math.min(n, i - h + m);
      out[i] = (P[hi] - P[lo]) / (hi - lo);
    }
    return out;
  }

  function foldParams(req, st) {
    const P = +req.period;
    if (!(P > 0)) throw new Error('period required for fold kinds');
    const nbins = Math.max(2, Math.round(req.nbins || 64));
    return { P: P, nbins: nbins, shift: +req.phaseShift || 0 };
  }

  // Fold a fine series (Float64Array, sample i at absolute time (t0+i)*dt)
  function foldProfile(ts, t0, dt, P, nbins, shift) {
    const sum = new Float64Array(nbins), cnt = new Float64Array(nbins);
    const n = ts.length;
    for (let i = 0; i < n; i++) {
      const u = (t0 + i) * dt / P + shift;
      let b = Math.floor((u - Math.floor(u)) * nbins);
      if (b >= nbins) b = nbins - 1;
      sum[b] += ts[i]; cnt[b]++;
    }
    const prof = new Float32Array(nbins);
    for (let b = 0; b < nbins; b++) prof[b] = cnt[b] > 0 ? sum[b] / cnt[b] : 0;
    fillGaps(prof, cnt, 0, nbins, 1);
    return prof;
  }

  function kPulsestack(st, req) {
    const c = prepCommon(st, req);
    const f = foldParams(req, st);
    const v = planView(st, req, [c.dm], c.mask);
    let ser = fineSeries(st, c.dm, c.w, c.mask, v.t0, v.nview, 1);
    if (c.ts > 1) ser = boxcar(ser, c.ts);
    const dt = st.dt, P = f.P, nbins = f.nbins;
    const ppr = Math.max(1, Math.round(req.pulsesPerRow || 1));
    const tA = v.t0 * dt, tB = (v.t0 + v.nview) * dt;
    const kFirst = Math.ceil(tA / P + f.shift - 1e-9);
    const kLastEx = Math.floor(tB / P + f.shift + 1e-9);   // exclusive
    const nPulses = kLastEx - kFirst;
    const rows = Math.floor(nPulses / ppr);
    if (rows < 1) throw new Error('View contains fewer than ' + ppr + ' complete pulse(s) at this period');
    const used = rows * ppr;
    const sum = new Float64Array(rows * nbins), cnt = new Float64Array(rows * nbins);
    const tsum = new Float64Array(nbins), tcnt = new Float64Array(nbins);
    const n = ser.length;
    for (let i = 0; i < n; i++) {
      const u = (v.t0 + i) * dt / P + f.shift;
      const k = Math.floor(u);
      const kk = k - kFirst;
      if (kk < 0 || kk >= used) continue;
      let b = Math.floor((u - k) * nbins);
      if (b >= nbins) b = nbins - 1;
      const r = Math.floor(kk / ppr), o = r * nbins + b;
      const val = ser[i];
      sum[o] += val; cnt[o]++;
      tsum[b] += val; tcnt[b]++;
    }
    const grid = new Float32Array(rows * nbins);
    for (let i = 0; i < grid.length; i++) grid[i] = cnt[i] > 0 ? sum[i] / cnt[i] : 0;
    for (let r = 0; r < rows; r++) fillGaps(grid, cnt, r * nbins, nbins, 1);
    const prof = new Float32Array(nbins);
    for (let b = 0; b < nbins; b++) prof[b] = tcnt[b] > 0 ? tsum[b] / tcnt[b] : 0;
    fillGaps(prof, tcnt, 0, nbins, 1);
    const meta = baseMeta(st, c, v);
    meta.period = P; meta.nPulses = used; meta.nbins = nbins; meta.pulsesPerRow = ppr;
    meta.phaseShift = f.shift; meta.firstPulse = kFirst;
    meta.snr = robustSnr(prof);
    return {
      kind: 'pulsestack', grid: grid, nx: nbins, ny: rows,
      x: { label: 'Pulse phase', unit: 'cycles', min: 0, max: 1 },
      y: { label: 'Pulse number', unit: '', min: kFirst, max: kFirst + used },
      series: prof, seriesX: { min: 0, max: 1 }, meta: meta,
    };
  }

  function kProfile(st, req) {
    const c = prepCommon(st, req);
    const f = foldParams(req, st);
    const v = planView(st, req, [c.dm], c.mask);
    const ser = fineSeries(st, c.dm, c.w, c.mask, v.t0, v.nview, 1);
    const prof = foldProfile(ser, v.t0, st.dt, f.P, f.nbins, f.shift);
    const meta = baseMeta(st, c, v);
    meta.period = f.P; meta.nbins = f.nbins; meta.phaseShift = f.shift;
    meta.nPulses = Math.floor(v.nview * st.dt / f.P);
    meta.snr = robustSnr(prof);
    return {
      kind: 'profile', grid: prof, nx: f.nbins, ny: 1,
      x: { label: 'Pulse phase', unit: 'cycles', min: 0, max: 1 },
      y: Y_INT(), series: null, seriesX: null, meta: meta,
    };
  }

  function kFoldspec(st, req) {
    const c = prepCommon(st, req);
    const f = foldParams(req, st);
    const v = planView(st, req, [c.dm], c.mask);
    const g = makeGroups(st, c.fs, c.mask);
    if (g.nActiveTotal === 0) throw new Error('All channels are masked');
    const nb = f.nbins, ncOut = g.ncOut, dt = st.dt;
    const tgt = new Int32Array(v.nview);
    const rowCnt = new Float64Array(nb);
    for (let i = 0; i < v.nview; i++) {
      const u = (v.t0 + i) * dt / f.P + f.shift;
      let b = Math.floor((u - Math.floor(u)) * nb);
      if (b >= nb) b = nb - 1;
      tgt[i] = b; rowCnt[b]++;
    }
    const acc = new Float64Array(nb * ncOut);
    accumTgt(st, c.w, g.ocOf, ncOut, delaySamples(st, c.dm), v.t0, v.nview, tgt, acc);
    // [bin][oc] -> [oc][bin], normalise
    const grid = new Float32Array(nb * ncOut);
    const prof = new Float32Array(nb);
    let tot = 0;
    for (let oc = 0; oc < ncOut; oc++) tot += g.nActive[oc];
    for (let oc = 0; oc < ncOut; oc++) {
      const ob = oc * nb;
      const fr = g.nActive[oc] / tot;
      for (let b = 0; b < nb; b++) {
        const nrm = rowCnt[b] > 0 && g.nActive[oc] > 0 ? 1 / (rowCnt[b] * g.nActive[oc]) : 0;
        grid[ob + b] = acc[b * ncOut + oc] * nrm;
      }
      fillGaps(grid, rowCnt, ob, nb, 1);
      for (let b = 0; b < nb; b++) prof[b] += grid[ob + b] * fr;
    }
    const meta = baseMeta(st, c, v);
    meta.period = f.P; meta.nbins = nb; meta.phaseShift = f.shift;
    meta.nPulses = Math.floor(v.nview * dt / f.P);
    meta.snr = robustSnr(prof);
    return {
      kind: 'foldspec', grid: grid, nx: nb, ny: ncOut,
      x: { label: 'Pulse phase', unit: 'cycles', min: 0, max: 1 },
      y: { label: 'Frequency', unit: 'MHz', min: g.fmin, max: g.fmax },
      series: prof, seriesX: { min: 0, max: 1 }, meta: meta,
    };
  }

  function kBowtie(st, req) {
    const c = prepCommon(st, req);
    const dmMin = Math.max(0, req.dmMin != null ? +req.dmMin : 0);
    let dmMax = req.dmMax != null ? +req.dmMax : dmMin + 100;
    if (dmMax < dmMin) dmMax = dmMin;
    const nDM = Math.max(2, Math.round(req.nDM || 128));
    const v = planView(st, req, [dmMax, c.dm], c.mask);
    const nt = Math.floor(v.nview / c.ts);
    if (nt < 1) throw new Error('tscrunch larger than the view');
    const nsubReq = Math.max(1, Math.round(req.nsub || 64));
    const gs = Math.max(1, Math.floor(st.nchans / Math.min(nsubReq, st.nchans)));
    const g = makeGroups(st, gs, c.mask);
    const ns = g.ncOut, nfine = v.nview + v.maxDelay, stride = nfine + 1;
    // subbands at DM 0 (plain sums), then prefix sums per subband
    const P = new Float64Array(ns * stride);
    accumSub(st, c.w, g.ocOf, new Int32Array(st.nchans), v.t0, nfine, stride, P);
    const subOK = new Uint8Array(ns);
    let nSubOK = 0;
    for (let s = 0; s < ns; s++) {
      subOK[s] = g.nActive[s] > 0 ? 1 : 0;
      if (!subOK[s]) continue;
      nSubOK++;
      const nrm = 1 / g.nActive[s], o = s * stride;
      for (let t = 1; t <= nfine; t++) P[o + t] = P[o + t - 1] + P[o + t] * nrm;
    }
    if (nSubOK === 0) throw new Error('All channels are masked');
    const fhi = st.header.fhi / 1000, iref = 1 / (fhi * fhi);
    const grid = new Float32Array(nDM * nt);
    const dmStep = (dmMax - dmMin) / (nDM - 1);
    const rowAcc = new Float64Array(nt);
    const inv = 1 / (c.ts * nSubOK);
    for (let r = 0; r < nDM; r++) {
      const dm = dmMin + r * dmStep;
      rowAcc.fill(0);
      for (let s = 0; s < ns; s++) {
        if (!subOK[s]) continue;
        const fc = g.fcen[s] / 1000;
        const d = Math.round(KDM * dm * (1 / (fc * fc) - iref) / st.dt);
        const o = s * stride + d;
        for (let t = 0, b = 0; t < nt; t++, b += c.ts) rowAcc[t] += P[o + b + c.ts] - P[o + b];
      }
      const ob = r * nt;
      for (let t = 0; t < nt; t++) grid[ob + t] = rowAcc[t] * inv;
    }
    const series = Float32Array.from(fineSeries(st, c.dm, c.w, c.mask, v.t0, v.nview, c.ts));
    const x0 = v.t0 * st.dt, x1 = (v.t0 + nt * c.ts) * st.dt;
    const meta = baseMeta(st, c, v);
    meta.viewDur = nt * c.ts * st.dt; meta.nsub = ns; meta.dmMin = dmMin; meta.dmMax = dmMax;
    meta.snr = robustSnr(series);
    const hs = nDM > 1 ? dmStep / 2 : 0.5;
    return {
      kind: 'bowtie', grid: grid, nx: nt, ny: nDM,
      x: { label: 'Time', unit: 's', min: x0, max: x1 },
      y: { label: 'DM', unit: 'pc cm⁻³', min: dmMin - hs, max: dmMax + hs },
      series: series, seriesX: { min: x0, max: x1 }, meta: meta,
    };
  }

  function kPeriodsearch(st, req) {
    const c = prepCommon(st, req);
    const P0 = +req.period;
    if (!(P0 > 0)) throw new Error('period required for periodsearch');
    const range = req.range > 0 ? +req.range : 0.002;
    const nT = Math.max(3, Math.round(req.nTrials || 401));
    const nbins = Math.max(8, Math.round(req.nbins || 64));
    const v = planView(st, req, [c.dm], c.mask);
    // decimate so that there are >= ~2 samples per phase bin
    const dec = Math.max(1, Math.floor(P0 / st.dt / (2 * nbins)));
    const ser = fineSeries(st, c.dm, c.w, c.mask, v.t0, v.nview, dec);
    const dtd = st.dt * dec, tA = v.t0 * st.dt;
    const periods = new Float64Array(nT), snr = new Float32Array(nT);
    const sum = new Float64Array(nbins), cnt = new Float64Array(nbins);
    const prof = new Float32Array(nbins);
    let best = 0, bestSnr = -Infinity;
    for (let i = 0; i < nT; i++) {
      const P = P0 * (1 + range * (2 * i / (nT - 1) - 1));
      periods[i] = P;
      sum.fill(0); cnt.fill(0);
      const inv = 1 / P;
      for (let j = 0; j < ser.length; j++) {
        const u = (tA + (j + 0.5) * dtd) * inv;
        let b = Math.floor((u - Math.floor(u)) * nbins);
        if (b >= nbins) b = nbins - 1;
        sum[b] += ser[j]; cnt[b]++;
      }
      for (let b = 0; b < nbins; b++) prof[b] = cnt[b] > 0 ? sum[b] / cnt[b] : 0;
      const s = robustSnr(prof);
      snr[i] = s;
      if (s > bestSnr) { bestSnr = s; best = i; }
    }
    let bp = periods[best];
    if (best > 0 && best < nT - 1) {      // parabolic refinement
      const a = snr[best - 1], b = snr[best], d = snr[best + 1];
      const den = a - 2 * b + d;
      if (den < 0) bp += 0.5 * (a - d) / den * (periods[1] - periods[0]);
    }
    const meta = baseMeta(st, c, v);
    meta.period = P0; meta.nbins = nbins; meta.snr = bestSnr; meta.bestIndex = best;
    meta.periodStep = periods[1] - periods[0];
    return {
      kind: 'periodsearch', bestPeriod: bp, bestSnr: bestSnr, periods: periods, snr: snr,
      // generic-product fields so 1D consumers can plot it directly
      grid: snr, nx: nT, ny: 1,
      x: { label: 'Period', unit: 's', min: periods[0], max: periods[nT - 1] },
      y: { label: 'S/N', unit: '', min: 0, max: 1 },
      series: null, seriesX: null, meta: meta,
    };
  }

  /**
   * S/N against DM.  Channels are summed into `nsub` subbands dedispersed
   * inside each subband at `dm0`; every trial then only shifts the subbands, so
   * trials near dm0 are exact and far ones slightly smeared (run a second pass
   * around the best).  req.exact: dedisperse every channel for every trial
   * instead (for a handful of trials).  With a period the S/N is that of the
   * folded profile; without one it is the brightest `width`-second boxcar of
   * the time series.
   */
  function kDmsearch(st, req) {
    if (+req.period > 0 && !req.exact && !req.subbands) return kDmsearchFolded(st, req);
    const c = prepCommon(st, req);
    const dmMin = Math.max(0, +req.dmMin || 0);
    const dmMax = Math.max(dmMin, req.dmMax != null ? +req.dmMax : dmMin + 100);
    const nDM = Math.max(2, Math.round(req.nDM || 100));
    const dm0 = Math.min(dmMax, Math.max(dmMin, req.dm0 != null ? +req.dm0 : (dmMin + dmMax) / 2));
    const v = planView(st, req, [dmMax, dm0], c.mask);
    const n = st.nchans, N = st.N, dt = st.dt;
    const gs = Math.max(1, Math.floor(n / Math.min(Math.max(1, Math.round(req.nsub || 64)), n)));
    const g = makeGroups(st, gs, c.mask);
    if (g.nActiveTotal === 0) throw new Error('All channels are masked');
    const ns = g.ncOut, fhi = st.header.fhi / 1000, iref = 1 / (fhi * fhi);
    const d0 = delaySamples(st, dm0);
    // each subband is aligned on its highest channel
    const topCh = new Int32Array(ns).fill(-1);
    for (let ch = 0; ch < ns * gs; ch++) {
      const oc = st.header.foff < 0 ? ns - 1 - Math.floor(ch / gs) : Math.floor(ch / gs);
      if (topCh[oc] < 0 || chanFreqMHz(st, ch) > chanFreqMHz(st, topCh[oc])) topCh[oc] = ch;
    }
    const shiftAt = (s, dm) => { const f = chanFreqMHz(st, topCh[s]) / 1000; return Math.round(KDM * dm * (1 / (f * f) - iref) / dt); };
    let extra = 0;
    for (let s = 0; s < ns; s++) extra = Math.max(extra, shiftAt(s, dmMax));
    const L = v.nview + extra;
    const sub = new Float32Array(req.exact ? 0 : ns * L);
    for (let ch = 0; ch < n && !req.exact; ch++) {
      const oc = g.ocOf[ch];
      if (oc < 0) continue;
      const wc = c.w[ch] / g.nActiveTotal, p = ch * N + v.t0 + d0[ch] - d0[topCh[oc]], o = oc * L;
      const m = Math.min(L, N - (v.t0 + d0[ch] - d0[topCh[oc]]));
      for (let t = 0; t < m; t++) sub[o + t] += st.raw[p + t] * wc;
    }
    const P = +req.period > 0 ? +req.period : 0;
    const nbins = Math.max(8, Math.round(req.nbins || 64));
    const width = Math.max(1, Math.round((req.width > 0 ? +req.width : 1e-3) / dt));
    // average in time while that keeps >= 2 samples per phase bin (or 4 per boxcar)
    const dec = req.exact ? 1 : Math.max(1, Math.floor(P ? P / dt / (2 * nbins) : width / 4));
    const nv = Math.floor(v.nview / dec), Ld = Math.floor(L / dec);
    if (dec > 1) {
      for (let s = 0; s < ns; s++) {
        const o = s * L, od = s * Ld;
        for (let k = 0; k < Ld; k++) { let a = 0; for (let j = o + k * dec, e = j + dec; j < e; j++) a += sub[j]; sub[od + k] = a / dec; }
      }
    }
    let bin = null;
    if (P) {
      bin = new Int32Array(nv);
      for (let t = 0; t < nv; t++) {
        const u = (v.t0 + (t + 0.5) * dec) * dt / P;
        bin[t] = Math.min(nbins - 1, Math.floor((u - Math.floor(u)) * nbins));
      }
    }
    const box = Math.max(1, Math.round(width / dec));
    const dms = new Float64Array(nDM), snr = new Float32Array(nDM);
    const ser = new Float64Array(nv), sum = new Float64Array(nbins), cnt = new Float64Array(nbins);
    const prof = new Float32Array(nbins);
    const step = nDM > 1 ? (dmMax - dmMin) / (nDM - 1) : 0;
    let best = 0;
    for (let i = 0; i < nDM; i++) {
      const dm = dmMin + i * step;
      dms[i] = dm;
      if (req.exact) ser.set(fineSeries(st, dm, c.w, c.mask, v.t0, v.nview, 1));
      else {
        ser.fill(0);
        for (let s = 0; s < ns; s++) {
          if (!g.nActive[s]) continue;
          const o = s * Ld + Math.min(Ld - nv, Math.round(shiftAt(s, dm) / dec));
          for (let t = 0; t < nv; t++) ser[t] += sub[o + t];
        }
      }
      if (P) {
        sum.fill(0); cnt.fill(0);
        for (let t = 0; t < nv; t++) { sum[bin[t]] += ser[t]; cnt[bin[t]]++; }
        for (let b = 0; b < nbins; b++) prof[b] = cnt[b] > 0 ? sum[b] / cnt[b] : 0;
        snr[i] = robustSnr(prof);
      } else {
        const nb = Math.floor(nv / box), bx = new Float32Array(nb);
        for (let k = 0; k < nb; k++) { let a = 0; for (let j = k * box; j < (k + 1) * box; j++) a += ser[j]; bx[k] = a; }
        snr[i] = robustSnr(bx);
      }
      if (snr[i] > snr[best]) best = i;
    }
    let bestDM = dms[best];
    if (best > 0 && best < nDM - 1) {        // parabolic refinement
      const a = snr[best - 1], b = snr[best], d = snr[best + 1], den = a - 2 * b + d;
      if (den < 0) bestDM += 0.5 * (a - d) / den * step;
    }
    const meta = baseMeta(st, c, v);
    meta.dm0 = dm0; meta.nsub = ns; meta.dmStep = step; meta.dec = dec; meta.snr = snr[best]; meta.bestIndex = best; meta.folded = !!P;
    return {
      kind: 'dmsearch', bestDM: bestDM, bestSnr: snr[best], dms: dms, snr: snr,
      grid: snr, nx: nDM, ny: 1,
      x: { label: 'DM', unit: 'pc cm⁻³', min: dmMin, max: dmMax },
      y: { label: 'S/N', unit: '', min: 0, max: 1 },
      series: null, seriesX: null, meta: meta,
    };
  }

  /**
   * S/N of the folded profile against DM, pdmp-style: every channel is folded
   * once at req.period (nbins bins), then each trial only rotates the channel
   * profiles by their dispersion delay (linear interpolation between bins) and
   * adds them. Trials cost nchans x nbins, so thousands are cheap, and the result
   * is exact to a fraction of a bin. Folding wraps, so no data are trimmed.
   */
  function kDmsearchFolded(st, req) {
    const c = prepCommon(st, req);
    const P = +req.period, nb = Math.max(8, Math.round(req.nbins || 64));
    const dmMin = Math.max(0, +req.dmMin || 0);
    const dmMax = Math.max(dmMin, req.dmMax != null ? +req.dmMax : dmMin + 100);
    const nDM = Math.max(2, Math.round(req.nDM || 100));
    const v = planView(st, req, [0], c.mask);
    const g = makeGroups(st, 1, c.mask);
    if (g.nActiveTotal === 0) throw new Error('All channels are masked');
    const nc = g.ncOut, dt = st.dt;
    const tgt = new Int32Array(v.nview), rowCnt = new Float64Array(nb);
    for (let i = 0; i < v.nview; i++) {
      const u = (v.t0 + i) * dt / P;
      const b = Math.min(nb - 1, Math.floor((u - Math.floor(u)) * nb));
      tgt[i] = b; rowCnt[b]++;
    }
    const acc = new Float64Array(nb * nc);
    accumTgt(st, c.w, g.ocOf, nc, new Int32Array(st.nchans), v.t0, v.nview, tgt, acc);
    // channel-major profiles, mean per bin, each channel's mean removed
    const X = new Float64Array(nc * nb), live = [];
    for (let oc = 0; oc < nc; oc++) {
      if (!g.nActive[oc]) continue;
      live.push(oc);
      let m = 0;
      for (let b = 0; b < nb; b++) { const x = rowCnt[b] > 0 ? acc[b * nc + oc] / rowCnt[b] : 0; X[oc * nb + b] = x; m += x; }
      m /= nb;
      for (let b = 0; b < nb; b++) X[oc * nb + b] -= m;
    }
    const fhi = st.header.fhi / 1000, iref = 1 / (fhi * fhi);
    const kb = new Float64Array(nc);           // delay in bins per unit DM
    for (const oc of live) { const f = g.fcen[oc] / 1000; kb[oc] = KDM * (1 / (f * f) - iref) / P * nb; }
    const dms = new Float64Array(nDM), snr = new Float32Array(nDM), prof = new Float64Array(nb);
    const step = (dmMax - dmMin) / (nDM - 1);
    let best = 0;
    for (let i = 0; i < nDM; i++) {
      const dm = dmMin + i * step;
      dms[i] = dm;
      prof.fill(0);
      for (const oc of live) {
        const sh = kb[oc] * dm, s0 = Math.floor(sh), fr = sh - s0, o = oc * nb;
        let j = ((s0 % nb) + nb) % nb;
        for (let b = 0; b < nb; b++) {
          const j1 = j + 1 === nb ? 0 : j + 1;
          prof[b] += X[o + j] + fr * (X[o + j1] - X[o + j]);
          j = j1;
        }
      }
      snr[i] = robustSnr(prof);
      if (snr[i] > snr[best]) best = i;
    }
    let bestDM = dms[best];
    if (best > 0 && best < nDM - 1) {
      const a = snr[best - 1], b = snr[best], d = snr[best + 1], den = a - 2 * b + d;
      if (den < 0) bestDM += 0.5 * (a - d) / den * step;
    }
    const meta = baseMeta(st, c, v);
    meta.dmStep = step; meta.snr = snr[best]; meta.bestIndex = best; meta.folded = true; meta.nbins = nb;
    return {
      kind: 'dmsearch', bestDM: bestDM, bestSnr: snr[best], dms: dms, snr: snr,
      grid: snr, nx: nDM, ny: 1,
      x: { label: 'DM', unit: 'pc cm⁻³', min: dmMin, max: dmMax },
      y: { label: 'S/N', unit: '', min: 0, max: 1 },
      series: null, seriesX: null, meta: meta,
    };
  }

  function kRfi(st, req) {
    const n = st.nchans, sigma = req.rfiSigma > 0 ? +req.rfiSigma : 4;
    const feats = [st.chanMean, st.chanStd, new Float32Array(n)];
    for (let c = 0; c < n; c++) feats[2][c] = st.chanMean[c] > 0 ? st.chanStd[c] / st.chanMean[c] : 0;
    const score = new Float32Array(n);
    const half = Math.max(2, Math.min(15, n >> 3));
    const win = new Float64Array(2 * half + 1);
    for (let f = 0; f < feats.length; f++) {
      const a = feats[f], res = new Float64Array(n);
      // detrend by running median (removes the bandpass shape)
      for (let c = 0; c < n; c++) {
        const lo = Math.max(0, c - half), hi = Math.min(n, c + half + 1), m = hi - lo;
        const w = win.subarray(0, m);
        for (let i = 0; i < m; i++) w[i] = a[lo + i];
        w.sort();
        res[c] = a[c] - medianSorted(w);
      }
      const b = Float64Array.from(res, Math.abs);
      b.sort();
      let mad = 1.4826 * medianSorted(b);
      if (!(mad > 0)) mad = 1e-9;
      for (let c = 0; c < n; c++) {
        const z = Math.abs(res[c]) / mad;
        if (z > score[c]) score[c] = z;
      }
    }
    const mask = new Uint8Array(n);
    let nm = 0;
    for (let c = 0; c < n; c++) {
      if (st.chanStd[c] === 0 || score[c] > sigma) { mask[c] = 1; nm++; }
    }
    return { kind: 'rfi', mask: mask, score: score, meta: { nMasked: nm, sigma: sigma, nchans: n } };
  }

  /** Compute a product from the loaded state.  See SPEC.md section A. */
  function compute(st, req) {
    switch (req.kind) {
      case 'waterfall': return kWaterfall(st, req);
      case 'timeseries': return kTimeseries(st, req);
      case 'pulsestack': return kPulsestack(st, req);
      case 'foldspec': return kFoldspec(st, req);
      case 'profile': return kProfile(st, req);
      case 'bowtie': return kBowtie(st, req);
      case 'periodsearch': return kPeriodsearch(st, req);
      case 'dmsearch': return kDmsearch(st, req);
      case 'rfi': return kRfi(st, req);
      default: throw new Error('Unknown product kind: ' + req.kind);
    }
  }

  return {
    setReader: setReader, parseHeader: parseHeader, readHeader: readHeader,
    load: load, stateInfo: stateInfo, compute: compute,
    delaySamples: delaySamples, robustSnr: robustSnr,
  };
}

(function () {
  const g = (typeof self !== 'undefined') ? self
    : (typeof window !== 'undefined') ? window : globalThis;
  g.PW = g.PW || {};
  g.PW.dspCoreFactory = PW_dspCore;
  if (typeof module !== 'undefined' && module.exports) module.exports = PW_dspCore;
})();
