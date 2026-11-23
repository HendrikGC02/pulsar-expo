// engine.js -- PW.Engine: main-thread async API over the DSP worker.
//
// The worker is built from a Blob made of PW_dspCore.toString() plus the
// stringified PW_engineHandler (below), so it works from file://.  If a Worker
// cannot be created, the same handler runs on the main thread (FileReader).
(function () {
  const g = (typeof self !== 'undefined') ? self
    : (typeof window !== 'undefined') ? window : globalThis;
  g.PW = g.PW || {};

  // Message handler shared by the worker and the main-thread fallback.
  // SELF-CONTAINED (it is stringified into the worker).
  // post(msg, transferList) sends a message back to the Engine.
  function PW_engineHandler(core, post) {
    let file = null, header = null, state = null;

    // collect transferable buffers of typed arrays found in obj (2 levels)
    function transfers(obj, list, seen) {
      if (!obj || typeof obj !== 'object') return;
      for (const k in obj) {
        const v = obj[k];
        if (v && ArrayBuffer.isView(v)) {
          if (v.byteOffset === 0 && v.byteLength === v.buffer.byteLength &&
              !seen.has(v.buffer)) { seen.add(v.buffer); list.push(v.buffer); }
        } else if (v && typeof v === 'object' && !Array.isArray(v) && k !== 'meta') {
          transfers(v, list, seen);
        }
      }
    }

    return async function handle(msg) {
      const id = msg.id;
      try {
        let result;
        if (msg.op === 'setReader') {
          // not supported across threads; present for symmetry
          result = null;
        } else if (msg.op === 'open') {
          file = msg.file; state = null;
          header = await core.readHeader(file);
          result = { header: header };
        } else if (msg.op === 'load') {
          state = null;
          state = await core.load(file, header, msg.params, function (f) {
            post({ id: id, type: 'progress', frac: f });
          });
          const info = core.stateInfo(state);
          // the worker keeps its own chanMean/chanStd; send copies
          info.chanMean = info.chanMean.slice();
          info.chanStd = info.chanStd.slice();
          result = info;
        } else if (msg.op === 'compute') {
          if (!state) throw new Error('No data loaded');
          result = core.compute(state, msg.req);
        } else {
          throw new Error('Unknown op ' + msg.op);
        }
        const list = [];
        transfers(result, list, new Set());
        post({ id: id, type: 'result', result: result }, list);
      } catch (e) {
        post({ id: id, type: 'error', message: (e && e.message) || String(e) });
      }
    };
  }

  function workerSource() {
    return PW_dspCoreSource() + '\n' + PW_engineHandler.toString() + '\n' +
      '(function(){var h=PW_engineHandler(PW_dspCore(),function(m,t){self.postMessage(m,t||[]);});' +
      'self.onmessage=function(e){h(e.data);};self.postMessage({type:"ready"});})();';
  }
  function PW_dspCoreSource() { return g.PW.dspCoreFactory.toString(); }

  class Engine {
    /** @param {{forceMain?: boolean}} [opts] */
    constructor(opts) {
      opts = opts || {};
      this.header = null;
      this.info = null;
      this.usingWorker = false;
      this._nextId = 1;
      this._pending = new Map();      // id -> {resolve, reject, onProgress}
      this._control = [];             // FIFO of {msg, transfer, job}
      this._chan = new Map();         // channel -> {inflight, queued}
      this._order = [];               // channel names, round-robin
      this._rr = 0;
      this._busy = false;
      this._ready = false;
      this._transport = null;
      this._file = null;
      this._start(!!opts.forceMain);
    }

    _start(forceMain) {
      if (!forceMain && typeof Worker !== 'undefined' && typeof Blob !== 'undefined' &&
          typeof URL !== 'undefined' && URL.createObjectURL) {
        try {
          const url = URL.createObjectURL(new Blob([workerSource()], { type: 'application/javascript' }));
          const w = new Worker(url);
          this.usingWorker = true;
          this._worker = w;
          w.onmessage = (e) => {
            if (e.data && e.data.type === 'ready') {
              this._ready = true; clearTimeout(this._readyTimer); this._pump(); return;
            }
            this._onMessage(e.data);
          };
          w.onerror = (e) => {
            if (!this._ready) {
              this._fallback('worker error: ' + (e && e.message));
            } else {
              console.error('PW.Engine worker error', e && e.message);
            }
          };
          this._transport = (msg, tr) => w.postMessage(msg, tr || []);
          this._readyTimer = setTimeout(() => {
            if (!this._ready) this._fallback('worker start timeout');
          }, 5000);
          return;
        } catch (err) {
          console.warn('PW.Engine: worker unavailable, using main thread:', err && err.message);
        }
      }
      this._fallback(null);
    }

    _fallback(why) {
      if (why) console.warn('PW.Engine: falling back to main thread (' + why + ')');
      if (this._worker) { try { this._worker.terminate(); } catch (e) { /* ignore */ } this._worker = null; }
      clearTimeout(this._readyTimer);
      this.usingWorker = false;
      const core = g.PW.dspCoreFactory();
      const handler = PW_engineHandler(core, (msg) => {
        setTimeout(() => this._onMessage(msg), 0);
      });
      this._transport = (msg) => { setTimeout(() => handler(msg), 0); };
      this._ready = true;
      this._pump();
    }

    _onMessage(m) {
      const p = this._pending.get(m.id);
      if (!p) return;
      if (m.type === 'progress') { if (p.onProgress) p.onProgress(m.frac); return; }
      this._pending.delete(m.id);
      this._busy = false;
      if (m.type === 'error') p.reject(new Error(m.message));
      else p.resolve(m.result);
      this._pump();
    }

    // send the next job if the worker is idle: control ops first, then channels
    _pump() {
      if (this._busy || !this._ready) return;
      let job = this._control.shift();
      if (!job) {
        const n = this._order.length;
        for (let i = 0; i < n && !job; i++) {
          const name = this._order[(this._rr + i) % n];
          const ch = this._chan.get(name);
          if (ch.queued) {
            job = ch.queued; ch.queued = null;
            ch.inflight = job;
            this._rr = (this._rr + i + 1) % n;
            const done = () => { if (ch.inflight === job) ch.inflight = null; };
            job.promise.then(done, done);
          }
        }
      }
      if (!job) return;
      this._busy = true;
      this._pending.set(job.id, job);
      this._transport(job.msg, job.transfer);
    }

    _job(msg, onProgress) {
      const id = this._nextId++;
      msg.id = id;
      const job = { id: id, msg: msg, onProgress: onProgress, transfer: null };
      job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
      return job;
    }

    /** Open a File and read its header. Resolves { header }. */
    open(file) {
      const job = this._job({ op: 'open', file: file });
      this._control.push(job);
      this._pump();
      return job.promise.then((r) => { this._file = file; this.header = r.header; this.info = null; return r; });
    }

    /**
     * Load a section: { tstart, nsec, tdec: 'auto'|int, maxValues }.
     * Resolves { tdec, dt, nsamp, tstart, nsec, nchans, chanMean, chanStd }.
     */
    load(params, onProgress) {
      const job = this._job({ op: 'load', params: params || {} }, onProgress);
      this._control.push(job);
      this._pump();
      return job.promise.then((r) => { this.info = r; return r; });
    }

    /**
     * Compute a product.  Latest request per channel wins: a queued request that
     * is replaced resolves { stale: true }.
     */
    compute(req, channel) {
      channel = channel || 'main';
      let ch = this._chan.get(channel);
      if (!ch) { ch = { inflight: null, queued: null }; this._chan.set(channel, ch); this._order.push(channel); }
      if (ch.queued) ch.queued.resolve({ stale: true });
      const job = this._job({ op: 'compute', req: req });
      ch.queued = job;
      this._pump();
      return job.promise;
    }

    /** Shut the worker down; pending promises reject. */
    terminate() {
      if (this._worker) { this._worker.terminate(); this._worker = null; }
      clearTimeout(this._readyTimer);
      const err = new Error('Engine terminated');
      this._pending.forEach((p) => p.reject(err));
      this._pending.clear();
      this._control.forEach((j) => j.reject(err));
      this._control.length = 0;
      this._chan.forEach((ch) => { if (ch.queued) ch.queued.reject(err); ch.queued = null; });
      this._transport = () => { };
    }
  }

  g.PW.Engine = Engine;
  g.PW.engineHandlerFactory = PW_engineHandler;
  g.PW.engineWorkerSource = workerSource;
})();
