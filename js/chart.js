/* Indici Meteo — © Biagio Paparella. Tutti i diritti riservati. */
/* Grafici SVG leggeri, senza librerie esterne */
(function (global) {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const MESI = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];

  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function niceTicks(min, max, n) {
    if (min === max) { min -= 1; max += 1; }
    const span = max - min, raw = span / (n || 5);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / mag;
    const step = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag;
    const out = [];
    for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(+v.toFixed(10));
    return out;
  }
  function fmtDate(t, span) {
    const d = new Date(t);
    if (span > 400 * 864e5) return MESI[d.getUTCMonth()] + ' ' + String(d.getUTCFullYear()).slice(2);
    if (span > 3 * 864e5) return d.getUTCDate() + '/' + (d.getUTCMonth() + 1);
    return String(d.getUTCHours()).padStart(2, '0') + ':00';
  }
  function fmtFull(t, span) {
    const d = new Date(t);
    const base = d.getUTCDate() + ' ' + MESI[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
    if (span < 20 * 864e5) return base + ' ' + String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
    return base;
  }

  /**
   * opts: {height, series:[{name,type:'line'|'bar'|'band'|'dots',color,data:[{x,y}|{x,lo,hi}],dash,width,colorFn}],
   *        yMin,yMax, zero:true, log:false, hLines:[{y,color,label}], vLine:x, yFmt, unit}
   */
  function draw(container, opts) {
    container.innerHTML = '';
    const W = 360, H = opts.height || 200, L = 38, R = 8, T = 18, B = 22;
    const pw = W - L - R, ph = H - T - B;
    const svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'chart', preserveAspectRatio: 'none' }, container);
    const tr = v => (opts.log ? Math.log10(v) : v);

    let xs = [], ys = [];
    opts.series.forEach(s => s.data.forEach(p => {
      if (p.x === null || p.x === undefined) return;
      xs.push(p.x);
      ['y', 'lo', 'hi'].forEach(k => { if (p[k] !== null && p[k] !== undefined && (!opts.log || p[k] > 0)) ys.push(tr(p[k])); });
    }));
    if (!xs.length || !ys.length) { el('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'ax' }, svg).textContent = 'Nessun dato'; return; }
    let x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
    const hasBar = opts.series.some(s => s.type === 'bar');
    let barW = 0;
    if (hasBar) {
      const bx = opts.series.filter(s => s.type === 'bar')[0].data.map(p => p.x).sort((a, b) => a - b);
      let md = Infinity; for (let i = 1; i < bx.length; i++) md = Math.min(md, bx[i] - bx[i - 1]);
      if (!isFinite(md)) md = 864e5;
      x0 -= md / 2; x1 += md / 2; barW = md;
    }
    if (x1 === x0) x1 = x0 + 1;
    let y0 = opts.yMin !== undefined ? tr(opts.yMin) : Math.min.apply(null, ys);
    let y1 = opts.yMax !== undefined ? tr(opts.yMax) : Math.max.apply(null, ys);
    if (opts.zero !== false && !opts.log) { y0 = Math.min(y0, 0); y1 = Math.max(y1, 0); }
    (opts.hLines || []).forEach(h => { if (opts.yMin === undefined) y0 = Math.min(y0, tr(h.y)); if (opts.yMax === undefined) y1 = Math.max(y1, tr(h.y)); });
    const pad = (y1 - y0) * 0.06 || 1; if (opts.yMin === undefined) y0 -= pad; if (opts.yMax === undefined) y1 += pad;

    const X = x => L + (x - x0) / (x1 - x0) * pw;
    const Y = v => T + (1 - (tr(v) - y0) / (y1 - y0)) * ph;
    const Yt = v => T + (1 - (v - y0) / (y1 - y0)) * ph;

    // griglia Y
    const yt = opts.log ? range(Math.ceil(y0), Math.floor(y1)) : niceTicks(y0, y1, 5);
    yt.forEach(v => {
      el('line', { x1: L, x2: W - R, y1: Yt(v), y2: Yt(v), class: 'grid' }, svg);
      const t = el('text', { x: L - 4, y: Yt(v) + 3, 'text-anchor': 'end', class: 'ax' }, svg);
      t.textContent = opts.log ? (opts.logLabel ? opts.logLabel(Math.pow(10, v)) : '1e' + v) : (opts.yFmt ? opts.yFmt(v) : fmtNum(v));
    });
    if (opts.zero !== false && !opts.log && y0 < 0 && y1 > 0) el('line', { x1: L, x2: W - R, y1: Yt(0), y2: Yt(0), class: 'zero' }, svg);
    (opts.hLines || []).forEach(h => {
      el('line', { x1: L, x2: W - R, y1: Y(h.y), y2: Y(h.y), stroke: h.color || '#888', 'stroke-dasharray': '3 3', 'stroke-width': 1 }, svg);
      if (h.label) { const t = el('text', { x: W - R - 2, y: Y(h.y) - 2, 'text-anchor': 'end', class: 'ax', fill: h.color || '#888' }, svg); t.textContent = h.label; }
    });
    // asse X
    const span = x1 - x0;
    const nX = 5;
    for (let i = 0; i <= nX; i++) {
      const xv = x0 + span * i / nX;
      const t = el('text', { x: X(xv), y: H - 6, 'text-anchor': i === 0 ? 'start' : i === nX ? 'end' : 'middle', class: 'ax' }, svg);
      t.textContent = opts.xFmt ? opts.xFmt(xv) : fmtDate(xv, span);
    }
    if (opts.vLine !== undefined && opts.vLine >= x0 && opts.vLine <= x1) {
      el('line', { x1: X(opts.vLine), x2: X(opts.vLine), y1: T, y2: T + ph, class: 'now' }, svg);
    }

    const clip = 'c' + Math.random().toString(36).slice(2);
    const defs = el('defs', {}, svg);
    const cp = el('clipPath', { id: clip }, defs);
    el('rect', { x: L, y: T, width: pw, height: ph }, cp);
    const g = el('g', { 'clip-path': 'url(#' + clip + ')' }, svg);

    opts.series.forEach(s => {
      const d = s.data.filter(p => p.x !== null && p.x !== undefined);
      if (s.type === 'band') {
        const ok = d.filter(p => p.lo !== null && p.hi !== null);
        if (!ok.length) return;
        const pts = ok.map(p => X(p.x) + ',' + Y(p.hi)).concat(ok.slice().reverse().map(p => X(p.x) + ',' + Y(p.lo)));
        el('polygon', { points: pts.join(' '), fill: s.color, opacity: s.opacity || 0.2 }, g);
      } else if (s.type === 'bar') {
        const bw = Math.max(1, barW / (x1 - x0) * pw * 0.8);
        const base = opts.log ? y0 : Math.max(y0, Math.min(0, y1));
        d.forEach(p => {
          if (p.y === null) return;
          const yv = Y(p.y), yb = Yt(base);
          el('rect', { x: X(p.x) - bw / 2, y: Math.min(yv, yb), width: bw, height: Math.max(0.5, Math.abs(yb - yv)), fill: s.colorFn ? s.colorFn(p) : s.color }, g);
        });
      } else if (s.type === 'dots') {
        d.forEach(p => { if (p.y !== null) el('circle', { cx: X(p.x), cy: Y(p.y), r: s.r || 2, fill: s.colorFn ? s.colorFn(p) : s.color }, g); });
      } else {
        let path = '', pen = false;
        d.forEach(p => {
          if (p.y === null || (opts.log && p.y <= 0)) { pen = false; return; }
          path += (pen ? 'L' : 'M') + X(p.x).toFixed(1) + ',' + Y(p.y).toFixed(1);
          pen = true;
        });
        el('path', { d: path, fill: 'none', stroke: s.color, 'stroke-width': s.width || 1.6, 'stroke-dasharray': s.dash || '', 'stroke-linejoin': 'round' }, g);
      }
    });

    // legenda
    const named = opts.series.filter(s => s.name);
    if (named.length > 1 || opts.legend) {
      let lx = L;
      named.forEach(s => {
        el('rect', { x: lx, y: 4, width: 10, height: 6, fill: s.color, opacity: s.type === 'band' ? 0.4 : 1 }, svg);
        const t = el('text', { x: lx + 13, y: 10, class: 'ax' }, svg); t.textContent = s.name;
        lx += 18 + s.name.length * 5.2;
      });
    }

    // interazione: tocco = valore
    const cross = el('line', { y1: T, y2: T + ph, class: 'cross', visibility: 'hidden' }, svg);
    const tip = document.createElement('div'); tip.className = 'tip'; container.appendChild(tip);
    const all = opts.series.filter(s => s.type !== 'band' || s.name);
    function show(evt) {
      const r = svg.getBoundingClientRect();
      const cx = ((evt.touches ? evt.touches[0].clientX : evt.clientX) - r.left) / r.width * W;
      const xv = x0 + (cx - L) / pw * (x1 - x0);
      let best = null;
      all.forEach(s => s.data.forEach(p => { if (p.x !== null && (best === null || Math.abs(p.x - xv) < Math.abs(best - xv))) best = p.x; }));
      if (best === null) return;
      cross.setAttribute('x1', X(best)); cross.setAttribute('x2', X(best)); cross.setAttribute('visibility', 'visible');
      const parts = [fmtFull(best, x1 - x0)];
      all.forEach(s => {
        const p = s.data.find(q => q.x === best);
        if (!p) return;
        const f = opts.tipFmt || fmtNum;
        if (s.type === 'band') parts.push((s.name || '') + ' ' + f(p.lo) + '…' + f(p.hi));
        else if (p.y !== null) parts.push('<b style="color:' + (s.colorFn ? s.colorFn(p) : s.color) + '">' + (s.name || '') + '</b> ' + f(p.y) + (opts.unit ? ' ' + opts.unit : ''));
      });
      tip.innerHTML = parts.join(' · ');
      tip.style.display = 'block';
    }
    svg.addEventListener('click', show);
    svg.addEventListener('touchmove', show, { passive: true });
    svg.addEventListener('touchstart', show, { passive: true });
  }

  function range(a, b) { const o = []; for (let i = a; i <= b; i++) o.push(i); return o; }
  function fmtNum(v) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    const a = Math.abs(v);
    if (a >= 1000) return Math.round(v).toLocaleString('it-IT');
    if (a >= 100) return v.toFixed(0);
    if (a >= 10) return v.toFixed(1).replace('.', ',');
    return v.toFixed(2).replace('.', ',');
  }

  /* Diagramma di fase MJO (Wheeler-Hendon) */
  function mjoDiagram(container, pts) {
    container.innerHTML = '';
    const S = 320, C = S / 2, sc = S / 8.4;
    const svg = el('svg', { viewBox: '0 0 ' + S + ' ' + S, class: 'chart mjo' }, container);
    const P = (a, b) => [C + a * sc, C - b * sc];
    el('rect', { x: C - 4 * sc, y: C - 4 * sc, width: 8 * sc, height: 8 * sc, class: 'frame' }, svg);
    el('line', { x1: C - 4 * sc, x2: C + 4 * sc, y1: C, y2: C, class: 'grid' }, svg);
    el('line', { y1: C - 4 * sc, y2: C + 4 * sc, x1: C, x2: C, class: 'grid' }, svg);
    el('line', { x1: C - 4 * sc, y1: C - 4 * sc, x2: C + 4 * sc, y2: C + 4 * sc, class: 'grid' }, svg);
    el('line', { x1: C - 4 * sc, y1: C + 4 * sc, x2: C + 4 * sc, y2: C - 4 * sc, class: 'grid' }, svg);
    el('circle', { cx: C, cy: C, r: sc, class: 'unit' }, svg);
    const ang = [202.5, 247.5, 292.5, 337.5, 22.5, 67.5, 112.5, 157.5];
    ang.forEach((a, i) => {
      const r = 3.5, rad = a * Math.PI / 180;
      const [x, y] = P(r * Math.cos(rad), r * Math.sin(rad));
      const t = el('text', { x, y: y + 5, 'text-anchor': 'middle', class: 'phase' }, svg); t.textContent = i + 1;
    });
    const lab = [['Oceano Indiano', C, C + 4 * sc - 6], ['Pacifico occ.', C, C - 4 * sc + 14], ['Continente marittimo', C + 4 * sc - 4, C, 90], ['Emisfero occ. / Africa', C - 4 * sc + 12, C, -90]];
    lab.forEach(([s, x, y, rot]) => {
      const t = el('text', { x, y, 'text-anchor': 'middle', class: 'ax', transform: rot ? 'rotate(' + rot + ' ' + x + ' ' + y + ')' : '' }, svg); t.textContent = s;
    });
    if (!pts.length) return;
    const cl = v => Math.max(-4, Math.min(4, v));
    const d = pts.map((p, i) => (i ? 'L' : 'M') + P(cl(p.rmm1), cl(p.rmm2)).join(',')).join('');
    el('path', { d, fill: 'none', stroke: '#7aa2ff', 'stroke-width': 1.6 }, svg);
    pts.forEach((p, i) => {
      const [x, y] = P(cl(p.rmm1), cl(p.rmm2));
      el('circle', { cx: x, cy: y, r: i === pts.length - 1 ? 5 : 2, fill: i === pts.length - 1 ? '#ff6b6b' : '#7aa2ff' }, svg);
    });
    const [sx, sy] = P(cl(pts[0].rmm1), cl(pts[0].rmm2));
    el('circle', { cx: sx, cy: sy, r: 5, fill: 'none', stroke: '#ffd43b', 'stroke-width': 2 }, svg);
  }

  global.Chart = { draw, mjoDiagram, fmtNum, fmtFull, MESI };
})(window);
