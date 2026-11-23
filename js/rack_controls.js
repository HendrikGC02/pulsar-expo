// rack_controls.js — the Expo's physical-looking controls, and their plain twins.
//
//   PW.rack.build(el, model)  turns <div class="c" data-p="dm" data-type="knob"> into a control
//   PW.rack.sync(el, model)   moves it to the model's current value
//
// model = { get(p), set(p, v), spec(p), plain }   where spec(p) = { label, min, max, step, log,
//   vals, names, fmt(v), bool }. Specs may change with the data (e.g. scrunch factors that
//   make sense for this file); a control whose value list changed is rebuilt by sync().
// Types: knob (continuous), rotary (chicken-head selector over `vals`), fader-h / fader-v,
//   toggle (bat-handle switch, boolean), patch (cord in Input or Bypass, boolean = bypassed).
(function () {
  const g = window;
  g.PW = g.PW || {};
  const NS = 'http://www.w3.org/2000/svg';
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function frac(s, v) {
    if (s.vals) return Math.max(0, s.vals.indexOf(v)) / Math.max(1, s.vals.length - 1);
    if (s.log) return clamp(Math.log(v / s.min) / Math.log(s.max / s.min), 0, 1);
    return clamp((v - s.min) / (s.max - s.min), 0, 1);
  }
  function fromFrac(s, f) {
    f = clamp(f, 0, 1);
    if (s.vals) return s.vals[Math.round(f * (s.vals.length - 1))];
    let v = s.log ? s.min * Math.pow(s.max / s.min, f) : s.min + f * (s.max - s.min);
    if (s.step) v = Math.round(v / s.step) * s.step;
    return +clamp(v, s.min, s.max).toPrecision(10);
  }
  const fmt = (s, v) => s.names && s.vals ? s.names[s.vals.indexOf(v)] ?? String(v) : s.fmt ? s.fmt(v) : String(v);
  const sig = s => JSON.stringify([s.vals || null, s.names || null, s.label]);
  function svg(w, h, inner) {
    const e = document.createElementNS(NS, 'svg');
    e.setAttribute('width', w); e.setAttribute('height', h); e.setAttribute('viewBox', `0 0 ${w} ${h}`);
    e.innerHTML = inner; return e;
  }
  function scaleOf(el) { const r = el.closest('.rack'); return (r && r.__scale) || 1; }

  // ── knob: printed scale + knurled skirt + machined aluminium cap ─────────
  function knobTicks(S, nt) {
    const c = S / 2, rk = S / 2 - 12; let t = '';
    for (let i = 0; i < nt; i++) {
      const a = (-135 + 270 * i / (nt - 1)) * Math.PI / 180, maj = nt < 12 || i % 5 === 0, r0 = rk + 3, r1 = rk + (maj ? 11 : 7);
      t += `<line x1="${c + r0 * Math.sin(a)}" y1="${c - r0 * Math.cos(a)}" x2="${c + r1 * Math.sin(a)}" y2="${c - r1 * Math.cos(a)}" stroke-width="${maj ? 1.8 : 1.1}"/>`;
    }
    return `<g class="tk">${t}</g>`;
  }
  function buildKnob(el, m, s) {
    const S = +(el.dataset.size || 70), W = S + 24;
    el.classList.add('knob');
    el.innerHTML = `<div class="v"></div><div class="kb" style="width:${W}px;height:${W}px;--k:${S - 0}px" tabindex="0" role="slider" aria-label="${s.label}"></div><div class="lbl">${el.dataset.label || s.label}</div>`;
    const kb = el.querySelector('.kb');
    kb.append(svg(W, W, knobTicks(W, +(el.dataset.ticks || (s.vals ? s.vals.length : 11)))));
    kb.insertAdjacentHTML('beforeend', '<div class="skirt"></div><div class="cap"></div><div class="ptr"></div>');
    dragTurn(kb, el, m, S);
  }
  function dragTurn(target, el, m, S) {
    const p = el.dataset.p; let y0 = null, f0 = 0;
    target.addEventListener('pointerdown', e => { if (e.target.tagName === 'text') return; y0 = e.clientY; f0 = frac(m.spec(p), m.get(p)); target.setPointerCapture(e.pointerId); e.preventDefault(); });
    target.addEventListener('pointermove', e => {
      if (y0 == null) return;
      const s = m.spec(p), k = (s.vals ? 1.3 : 1) * (e.shiftKey ? 0.15 : 1);
      m.set(p, fromFrac(s, f0 + (y0 - e.clientY) / scaleOf(el) / (S * 2.4) * k));
    });
    const end = () => { y0 = null; };
    target.addEventListener('pointerup', end); target.addEventListener('pointercancel', end);
    const nudge = d => { const s = m.spec(p), st = s.vals ? 1 / Math.max(1, s.vals.length - 1) : 0.005; m.set(p, fromFrac(s, frac(s, m.get(p)) + d * st)); };
    target.addEventListener('wheel', e => { e.preventDefault(); nudge((e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 5 : 1)); }, { passive: false });
    target.addEventListener('keydown', e => {
      const d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
      if (d) { e.preventDefault(); e.stopPropagation(); nudge(d * (e.shiftKey ? 5 : 1)); }
    });
  }

  // ── rotary selector with a bakelite chicken-head pointer ────────────────
  function buildRotary(el, m, s) {
    const S = +(el.dataset.size || 86), n = s.vals.length, span = Math.min(270, (n - 1) * (n > 6 ? 40 : 52));
    const ang = s.vals.map((_, i) => n === 1 ? 0 : -span / 2 + span * i / (n - 1));
    const lm = 46, R = S / 2, W = S + 2 * lm, c = W / 2;
    let t = '';
    s.vals.forEach((v, i) => {
      const a = ang[i] * Math.PI / 180, rx = c + (R + 13) * Math.sin(a), ry = c - (R + 13) * Math.cos(a);
      const anchor = Math.abs(Math.sin(a)) < 0.3 ? 'middle' : Math.sin(a) > 0 ? 'start' : 'end';
      t += `<circle class="dot" cx="${c + (R + 3) * Math.sin(a)}" cy="${c - (R + 3) * Math.cos(a)}" r="2.2"/><text data-i="${i}" x="${rx}" y="${ry + 5}" text-anchor="${anchor}">${fmt(s, v)}</text>`;
    });
    const head = `M${c},${c - R * .98} L${c + R * .2},${c - R * .2} Q${c + R * .25},${c + R * .55} ${c},${c + R * .58} Q${c - R * .25},${c + R * .55} ${c - R * .2},${c - R * .2} Z`;
    el.classList.add('rotary');
    const e = svg(W, W, `${t}<circle cx="${c}" cy="${c}" r="${R * .7}" fill="url(#gPlate)" stroke="rgba(0,0,0,.6)"/>
      <circle cx="${c}" cy="${c}" r="${R * .7 - 3}" fill="none" stroke="rgba(255,255,255,.12)"/>
      <g class="rot"><path d="${head}" transform="translate(1,6)" fill="#000" opacity=".55" filter="url(#fSh)"/>
      <circle cx="${c}" cy="${c}" r="${R * .34}" fill="url(#gBake)"/><path d="${head}" fill="url(#gBake)" stroke="#0a0806" stroke-width="1"/>
      <path d="${head}" fill="url(#gBakeHi)"/>
      <line x1="${c}" y1="${c - R * .86}" x2="${c}" y2="${c - R * .3}" stroke="#efe6cc" stroke-width="3" stroke-linecap="round"/></g>`);
    e.setAttribute('tabindex', '0'); e.setAttribute('role', 'slider'); e.setAttribute('aria-label', s.label);
    const l = document.createElement('div'); l.className = 'lbl'; l.style.marginTop = '-16px'; l.textContent = el.dataset.label || s.label;
    el.append(e, l); el.__W = W; el.__ang = ang;
    e.querySelectorAll('text').forEach(tx => tx.addEventListener('click', ev => { ev.stopPropagation(); m.set(el.dataset.p, m.spec(el.dataset.p).vals[+tx.dataset.i]); }));
    dragTurn(e, el, m, S);
  }

  // ── bat-handle toggle switch ────────────────────────────────────────────
  function buildToggle(el, m, s) {
    const W = 56, H = 76, c = W / 2, cy = H / 2;
    el.classList.add('toggle');
    const hex = [0, 1, 2, 3, 4, 5].map(i => { const a = i * Math.PI / 3 + Math.PI / 6; return `${c + 17 * Math.cos(a)},${cy + 17 * Math.sin(a)}`; }).join(' ');
    const e = svg(W, H, `<rect x="${c - 22}" y="${cy - 30}" width="44" height="60" rx="3" fill="url(#gPlate)" stroke="rgba(0,0,0,.5)"/>
      <polygon points="${hex}" fill="url(#gNut)" stroke="#3a3c38"/><circle cx="${c}" cy="${cy}" r="9" fill="#1b1d1b"/>
      <g class="lev"><path d="M${c - 3},${cy + 2} L${c - 2},${cy - 28} L${c + 2},${cy - 28} L${c + 3},${cy + 2} Z" fill="#000" opacity=".35" transform="translate(3,3)"/>
      <path d="M${c - 4.5},${cy} L${c - 3},${cy - 30} L${c + 3},${cy - 30} L${c + 4.5},${cy} Z" fill="url(#gLever)" stroke="#4a4c47" stroke-width=".6"/>
      <circle cx="${c}" cy="${cy - 31}" r="5.5" fill="url(#gNut)" stroke="#4a4c47" stroke-width=".6"/></g>`);
    e.setAttribute('tabindex', '0'); e.setAttribute('role', 'switch'); e.setAttribute('aria-label', s.label);
    el.innerHTML = `<div class="tl on-l">${el.dataset.on || 'On'}</div>`; el.append(e); el.insertAdjacentHTML('beforeend', `<div class="tl off-l">${el.dataset.off || 'Off'}</div>`);
    const flip = () => m.set(el.dataset.p, !m.get(el.dataset.p));
    e.addEventListener('click', flip);
    e.addEventListener('keydown', ev => { if (ev.key === ' ' || ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); flip(); } });
  }

  // ── patch cord: Input or Bypass ─────────────────────────────────────────
  function buildPatch(el, m, s) {
    const H = Math.max(120, (el.closest('.unit') ? el.closest('.unit').clientHeight : 200) - 50), W = 70, x = 24, j1 = 30, j2 = 104;
    el.classList.add('patch');
    const jack = (y, l) => `<circle cx="${x}" cy="${y}" r="13" fill="url(#gNut)" stroke="#3a3c38"/><circle cx="${x}" cy="${y}" r="9" fill="none" stroke="rgba(0,0,0,.35)"/>
      <circle cx="${x}" cy="${y}" r="5.5" fill="#050505"/><text data-l="${l}" x="${x}" y="${y + 31}" text-anchor="middle">${l}</text>`;
    const e = svg(W, H, `${jack(j1, 'Input')}${jack(j2, 'Bypass')}<g class="cord"></g>`);
    e.setAttribute('tabindex', '0'); e.setAttribute('role', 'switch'); e.setAttribute('aria-label', `${s.label}: input or bypass`);
    el.append(e); el.__patch = { x, j1, j2, H };
    e.addEventListener('click', ev => { const r = e.getBoundingClientRect(), y = (ev.clientY - r.top) / scaleOf(el); m.set(el.dataset.p, Math.abs(y - j2) < Math.abs(y - j1)); });
    e.addEventListener('keydown', ev => { if (ev.key === ' ' || ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); m.set(el.dataset.p, !m.get(el.dataset.p)); } });
  }
  const cord = (x, y, H) => `M${x},${y} C${x + 46},${y + 26} ${x + 40},${H - 30} ${x + 6},${H + 40}`;

  // ── faders ──────────────────────────────────────────────────────────────
  function buildFader(el, m, s, vert) {
    el.classList.add('fader', vert ? 'v' : 'h');
    el.innerHTML = `<div class="head"><span>${el.dataset.label || s.label}</span><b></b></div><div class="track" tabindex="0" role="slider" aria-label="${s.label}"><div class="scale"></div><div class="slot"></div><div class="cap"></div></div>`;
    const tr = el.querySelector('.track'), p = el.dataset.p; let drag = false;
    const at = e => {
      const r = tr.getBoundingClientRect(), k = scaleOf(el), pad = 14 * k;
      const f = vert ? 1 - (e.clientY - r.top - pad) / (r.height - 2 * pad) : (e.clientX - r.left - pad) / (r.width - 2 * pad);
      m.set(p, fromFrac(m.spec(p), f));
    };
    tr.addEventListener('pointerdown', e => { drag = true; tr.setPointerCapture(e.pointerId); at(e); e.preventDefault(); });
    tr.addEventListener('pointermove', e => drag && at(e));
    tr.addEventListener('pointerup', () => { drag = false; });
    tr.addEventListener('keydown', e => {
      const d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
      if (d) { e.preventDefault(); e.stopPropagation(); const s2 = m.spec(p); m.set(p, fromFrac(s2, frac(s2, m.get(p)) + d * (s2.vals ? 1 / (s2.vals.length - 1) : 0.02))); }
    });
  }

  // ── plain twins ─────────────────────────────────────────────────────────
  function buildPlain(el, m, s, type) {
    el.classList.add('pl');
    const p = el.dataset.p;
    if (s.bool) {
      const b = document.createElement('button'); b.className = 'chk'; b.textContent = el.dataset.plain || s.label;
      b.onclick = () => m.set(p, !m.get(p)); el.append(b); el.__inv = type === 'patch'; return;
    }
    el.innerHTML = `<div class="head"><span>${el.dataset.label || s.label}</span><b></b></div>`;
    if (s.vals && type === 'rotary') {
      const seg = document.createElement('div'); seg.className = 'seg';
      s.vals.forEach((v, i) => { const b = document.createElement('button'); b.textContent = fmt(s, v); b.dataset.i = i; b.onclick = () => m.set(p, m.spec(p).vals[i]); seg.append(b); });
      el.append(seg); return;
    }
    const inp = document.createElement('input'); inp.type = 'range'; inp.min = 0; inp.max = s.vals ? s.vals.length - 1 : 1000; inp.setAttribute('aria-label', s.label);
    inp.oninput = () => { const s2 = m.spec(p); m.set(p, s2.vals ? s2.vals[+inp.value] : fromFrac(s2, inp.value / 1000)); };
    el.append(inp);
  }

  function build(el, m) {
    const p = el.dataset.p, type = el.dataset.type, s = m.spec(p);
    el.innerHTML = ''; el.className = 'c'; el.__sig = sig(s);
    if (!s) return;
    if (m.plain) return buildPlain(el, m, s, type);
    if (type === 'knob') buildKnob(el, m, s);
    else if (type === 'rotary') buildRotary(el, m, s);
    else if (type === 'toggle') buildToggle(el, m, s);
    else if (type === 'patch') buildPatch(el, m, s);
    else if (type === 'fader-h' || type === 'fader-v') buildFader(el, m, s, type === 'fader-v');
  }

  function sync(el, m) {
    const p = el.dataset.p, s = m.spec(p);
    if (!s) return;
    if (el.__sig !== sig(s)) build(el, m);
    const v = m.get(p), txt = fmt(s, v), f = frac(s, v);
    el.classList.toggle('disabled', !!(s.disabled));
    if (el.classList.contains('pl')) {
      const b = el.querySelector('.chk'); if (b) { b.classList.toggle('on', el.__inv ? !v : !!v); return; }
      el.querySelector('.head b').textContent = txt;
      el.querySelectorAll('.seg button').forEach(x => x.classList.toggle('on', s.vals[+x.dataset.i] === v));
      const inp = el.querySelector('input'); if (inp && document.activeElement !== inp) inp.value = s.vals ? s.vals.indexOf(v) : Math.round(f * 1000);
      return;
    }
    if (el.classList.contains('knob')) {
      el.querySelector('.kb').style.setProperty('--a', (-135 + 270 * f) + 'deg');
      el.querySelector('.v').textContent = txt;
      el.querySelector('.kb').setAttribute('aria-valuetext', txt);
    } else if (el.classList.contains('rotary')) {
      const i = Math.max(0, s.vals.indexOf(v)), c = el.__W / 2;
      el.querySelector('.rot').setAttribute('transform', `rotate(${el.__ang[i]} ${c} ${c})`);
      el.querySelectorAll('text').forEach(t => t.classList.toggle('on', +t.dataset.i === i));
      el.querySelector('svg').setAttribute('aria-valuetext', txt);
    } else if (el.classList.contains('toggle')) {
      el.querySelector('.lev').setAttribute('transform', `rotate(${v ? 0 : 180} 28 38)`);
      el.querySelector('.on-l').classList.toggle('on', !!v); el.querySelector('.off-l').classList.toggle('on', !v);
      el.querySelector('svg').setAttribute('aria-checked', String(!!v));
    } else if (el.classList.contains('patch')) {
      const { x, j1, j2, H } = el.__patch, y = v ? j2 : j1, d = cord(x, y, H);
      el.querySelector('.cord').innerHTML = `<path d="${d}" fill="none" stroke="#3b1606" stroke-width="10" stroke-linecap="round"/><path d="${d}" fill="none" stroke="#c2531c" stroke-width="7" stroke-linecap="round"/>
        <path d="${d}" fill="none" stroke="#f0a070" stroke-opacity=".35" stroke-width="2" stroke-linecap="round" transform="translate(-1.5,-1.5)"/>
        <circle cx="${x + 1}" cy="${y + 5}" r="15" fill="#000" opacity=".5" filter="url(#fSh)"/><circle cx="${x}" cy="${y}" r="14" fill="url(#gPlug)" stroke="#5a2309"/>
        <circle cx="${x}" cy="${y}" r="8" fill="none" stroke="#f3b27d" stroke-opacity=".5"/><circle cx="${x - 4}" cy="${y - 5}" r="3" fill="#fff" opacity=".25"/>`;
      el.querySelectorAll('text').forEach(t => t.classList.toggle('on', (t.dataset.l === 'Bypass') === !!v));
      el.querySelector('svg').setAttribute('aria-checked', String(!!v));
    } else if (el.classList.contains('fader')) {
      const cap = el.querySelector('.cap');
      if (el.classList.contains('v')) cap.style.top = `calc(14px + ${1 - f} * (100% - 28px))`; else cap.style.left = `calc(14px + ${f} * (100% - 28px))`;
      el.querySelector('.head b').textContent = txt;
    }
  }

  g.PW.rack = { build, sync, frac, fromFrac, fmt };
})();
