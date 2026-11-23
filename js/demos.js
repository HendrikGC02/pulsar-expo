// demos.js — example filterbanks shipped with the website (demo/ folder).
// Only offered when the page is served over http(s): from file:// the browser
// will not fetch local files, so the apps fall back to Open / drag-and-drop.
(function (g) {
  g.PW = g.PW || {};

  const DEMOS = [
    { file: 'J0437-4715.fil', name: 'J0437−4715', mb: 19.7,
      note: 'The brightest millisecond pulsar: 174 turns a second (whole 1 s recording)' },
    { file: 'J1909-3744_5s.fil', name: 'J1909−3744', mb: 25.1,
      note: 'A millisecond pulsar in a binary, one of the most precise clocks known (5 s)' },
    { file: 'vela_10s.fil', name: 'Vela', mb: 66.9,
      note: 'Vela pulsar, J0835−4510: young, bright, 11 turns a second (10 s)' },
    { file: 'B1919+21_10s.fil', name: 'B1919+21', mb: 66.9,
      note: 'CP 1919, the first pulsar ever discovered (1967): one pulse every 1.34 s (10 s)' },
  ];

  const available = /^https?:$/.test(location.protocol);

  /**
   * Download one demo and return it as a File (so the apps treat it like a
   * dropped file). onProgress(fraction 0..1) is called while it downloads.
   */
  async function fetchDemo(d, onProgress) {
    const url = 'demo/' + encodeURIComponent(d.file);
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${d.file}: download failed (${r.status})`);
    const total = +r.headers.get('content-length') || d.mb * 1e6;
    let blob;
    if (r.body && r.body.getReader && onProgress) {
      const rd = r.body.getReader(), parts = [];
      let got = 0;
      for (;;) {
        const { done, value } = await rd.read();
        if (done) break;
        parts.push(value); got += value.length;
        onProgress(Math.min(1, got / total));
      }
      blob = new Blob(parts);
    } else {
      blob = await r.blob();
    }
    if (onProgress) onProgress(1);
    return new File([blob], d.file, { type: 'application/octet-stream' });
  }

  g.PW.demos = { list: DEMOS, available, fetch: fetchDemo };
})(typeof self !== 'undefined' ? self : this);
