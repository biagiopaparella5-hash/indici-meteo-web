/* Indici Meteo — © Biagio Paparella. Tutti i diritti riservati. */
/* Fonti dati e parser — Indici Meteo
 * Tutte le fonti sono pubbliche e gratuite (NOAA CPC, NOAA PSL, BoM, NOAA SWPC, Open-Meteo).
 * Se una fonte cambia indirizzo basta modificare SRC qui sotto.
 */
(function (global) {
  'use strict';

  const CPC = 'https://ftp.cpc.ncep.noaa.gov/cwlinks/';
  const LEV = { ao: 'z1000', nao: 'z500', pna: 'z500', aao: 'z700' };

  const SRC = {
    teleDaily: [CPC + 'norm.daily.ao.nao.pna.aao.gdas.120days.csv'],
    teleCdas: k => [CPC + 'norm.daily.' + k + '.cdas.' + LEV[k] + '.' + (k === 'aao' ? '19790101' : '19500101') + '_current.csv'],
    // per ogni modello: pagine da cui estrarre il diagramma di fase, in ordine di preferenza
    mjoPages: ['https://www.cpc.ncep.noaa.gov/products/precip/CWlink/MJO/CLIVAR/clivar_wh.shtml'],
    mjoGefsPages: ['https://www.cpc.ncep.noaa.gov/products/precip/CWlink/MJO/CLIVAR/ncpe.shtml',
                   'https://www.cpc.ncep.noaa.gov/products/precip/CWlink/MJO/foregfs.shtml',
                   'https://www.cpc.ncep.noaa.gov/products/precip/CWlink/MJO/CLIVAR/clivar_wh.shtml'],
    mjoEcmfPages: ['https://www.cpc.ncep.noaa.gov/products/precip/CWlink/MJO/CLIVAR/ecmf.shtml',
                   'https://www.cpc.ncep.noaa.gov/products/precip/CWlink/MJO/CLIVAR/clivar_wh.shtml'],
    gefs: k => [CPC + 'norm.daily.' + k + '.gefs.' + LEV[k] + '.120days.csv'],
    gfs: k => [CPC + 'norm.daily.' + k + '.gfs.' + LEV[k] + '.120days.csv'],
    wic: ['https://weatheriscool.com/'],
    wicPages: { epflux: 'https://weatheriscool.com/epflux/', waves: 'https://weatheriscool.com/waves/', maps: 'https://weatheriscool.com/page1/' },
    teleMonthly: ['https://ftp.cpc.ncep.noaa.gov/wd52dg/data/indices/tele_index.nh'],
    oni: ['https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt'],
    ninoWeekly: ['https://www.cpc.ncep.noaa.gov/data/indices/wksst9120.for'],
    rmm: ['https://www.bom.gov.au/clim_data/IDCKGEM000/rmm.74toRealtime.txt',
          'http://www.bom.gov.au/climate/mjo/graphics/rmm.74toRealtime.txt'],
    qbo: ['https://psl.noaa.gov/data/correlation/qbo.data'],
    dmi: ['https://psl.noaa.gov/gcos_wgsp/Timeseries/Data/dmi.had.long.data'],
    kp: ['https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json'],
    kpFc: ['https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json'],
    plasma: ['https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json'],
    mag: ['https://services.swpc.noaa.gov/json/rtsw/rtsw_mag_1m.json'],
    xray: ['https://services.swpc.noaa.gov/json/goes/primary/xrays-1-day.json'],
    cycleObs: ['https://services.swpc.noaa.gov/json/solar-cycle/observed-solar-cycle-indices.json'],
    cyclePred: ['https://services.swpc.noaa.gov/json/solar-cycle/predicted-solar-cycle.json'],
    f107: ['https://services.swpc.noaa.gov/json/f107_cm_flux.json']
  };

  const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

  /* ---------- utilità ---------- */
  function utc(y, m, d) { return Date.UTC(y, m, d || 1); }
  function num(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : parseFloat(String(v).trim());
    return isFinite(n) ? n : null;
  }
  function lines(text) { return String(text).split(/\r?\n/).filter(l => l.trim() !== ''); }
  function parseIsoDay(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s).trim());
    return m ? utc(+m[1], +m[2] - 1, +m[3]) : null;
  }
  function parseDMonY(s) { // 12Oct2023
    const m = /^(\d{1,2})([A-Za-z]{3})(\d{4})$/.exec(String(s).trim());
    if (!m) return null;
    const mo = MONTHS[m[2].toUpperCase()];
    return mo === undefined ? null : utc(+m[3], mo, +m[1]);
  }
  function parseSwpcTime(s) { // "2026-11-07 12:00:00.000" | "2026-11-07T12:00:00Z" | "2026-11"
    if (!s) return null;
    s = String(s).trim();
    if (/^\d{4}-\d{2}$/.test(s)) { const p = s.split('-'); return utc(+p[0], +p[1] - 1, 1); }
    s = s.replace(' ', 'T');
    if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) s += 'Z';
    const t = Date.parse(s);
    return isNaN(t) ? null : t;
  }
  /* SWPC pubblica sia array-di-array (con intestazione) sia array di oggetti */
  function toRows(json) {
    if (!Array.isArray(json) || !json.length) return [];
    if (Array.isArray(json[0])) {
      const h = json[0].map(String);
      return json.slice(1).map(r => { const o = {}; h.forEach((k, i) => { o[k] = r[i]; }); return o; });
    }
    return json;
  }
  function pick(o, keys) { for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k]; return undefined; }

  /* ---------- parser ---------- */

  // norm.daily.ao.nao.pna.aao.gdas.120days.csv  ->  {ao:[{x,y}], nao:[...], ...}
  function parseTeleDaily(text) {
    const L = lines(text);
    const head = L[0].split(',').map(s => s.trim().toLowerCase());
    const out = {};
    head.slice(1).forEach(k => { out[k] = []; });
    for (let i = 1; i < L.length; i++) {
      const p = L[i].split(',').map(s => s.trim());
      const t = parseDMonY(p[0]) || parseIsoDay(p[0]);
      if (t === null) continue;
      head.slice(1).forEach((k, j) => {
        const v = num(p[j + 1]);
        if (v !== null && v > -90) out[k].push({ x: t, y: v });
      });
    }
    return out;
  }

  // norm.daily.<x>.cdas....csv: year,month,day,<x>_index_cdas  -> ultime n righe
  function parseCdas(text, n) {
    const L = String(text).split(/\r?\n/);
    const out = [];
    for (let i = L.length - 1; i >= 0 && out.length < (n || 150); i--) {
      const p = L[i].split(',');
      if (p.length < 4 || !/^\s*\d{4}\s*$/.test(p[0])) continue;
      const v = num(p[3]);
      if (v === null || v < -90) continue;
      out.push({ x: utc(+p[0], +p[1] - 1, +p[2]), y: v });
    }
    return out.reverse();
  }

  // Cerca nelle pagine CPC le immagini del diagramma di fase MJO di un modello (NCPE, ECMF...)
  function findMjoImage(html, pageUrl, code) {
    const re = /["'(=]\s*([^"'()\s<>]*?\.(?:gif|png|jpg))/gi;
    const found = [];
    let m;
    while ((m = re.exec(html))) {
      const u = m[1];
      const U = u.toUpperCase();
      if (code ? U.indexOf(code) >= 0 : /PHASE/.test(U) && !/LOGO|NOAA|NWS/.test(U)) found.push(u);
    }
    if (!found.length) return null;
    const score = u => (/phase/i.test(u) ? 4 : 0) + (/full|large|big/i.test(u) ? 2 : 0) - (/small|thumb/i.test(u) ? 1 : 0);
    found.sort((a, b) => score(b) - score(a));
    try { return new URL(found[0], pageUrl).toString(); } catch (e) { return null; }
  }

  // weatheriscool.com: elenco delle corse disponibili (menu a tendina delle pagine)
  function parseWicSelect(html, id, n) {
    const m = new RegExp('<select[^>]*id=["\']' + id + '["\'][^>]*>([\\s\\S]*?)</select>', 'i').exec(String(html));
    if (!m) return [];
    const out = []; const re = /<option[^>]*value=["']?(\d{10})/gi; let o;
    while ((o = re.exec(m[1])) && out.length < (n || 12)) out.push(o[1]);
    return out;
  }
  function parseWicMaps(html) {
    const g = name => { const m = new RegExp(name + '\\s*=\\s*(\\{[\\s\\S]*?\\})\\s*;').exec(String(html)); if (!m) return null; try { return JSON.parse(m[1].replace(/'/g, '"')); } catch (e) { return null; } };
    const refs = g('modelRef') || {}, range = g('time_range') || {};
    const out = {};
    ['ECMWF', 'AIFS', 'GFS'].forEach(k => { if (refs[k] && refs[k].length) out[k] = { runs: refs[k].slice(0, 12).map(String), range: range[k] || (k === 'GFS' ? [0, 384, 12] : [0, 360, 24]) }; });
    return out;
  }

  // weatheriscool.com: riepilogo "Polar vortex status"
  function parseWic(html) {
    const t = String(html).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
    const g = (re) => { const m = re.exec(t); return m ? m : null; };
    const st = g(/Polar vortex status\s*(.*?)\s*The SSW probability/i);
    const pg = g(/SSW probability in GEFS is:\s*(-?[\d.]+)\s*\.?%/i);
    const pe = g(/SSW probability in ECEPS is:\s*(-?[\d.]+)\s*\.?%/i);
    const u = g(/10 hPa 60N is today \(GFS analysis\):\s*(-?[\d.]+)/i);
    const w = g(/Weakest zonal wind[^:]*:\s*(-?[\d.]+)\s*m\/s\s*(\d{4})/i);
    const sg = g(/Strongest zonal wind[^:]*:\s*(-?[\d.]+)\s*m\/s\s*(\d{4})/i);
    const out = {
      status: st ? st[1].trim() : null,
      sswGefs: pg ? parseFloat(pg[1]) : null, sswEcmwf: pe ? parseFloat(pe[1]) : null,
      u10: u ? parseFloat(u[1]) : null,
      weakest: w ? { v: parseFloat(w[1]), y: +w[2] } : null,
      strongest: sg ? { v: parseFloat(sg[1]), y: +sg[2] } : null
    };
    if (out.u10 === null && out.sswGefs === null) throw new Error('riepilogo non trovato nella pagina');
    return out;
  }

  // CSV previsioni GEFS/GFS: lead,member,time,<x>_index,valid_time
  // Restituisce la corsa più recente: {init, days:[{x, mean, min, max, n}]}
  function parseEnsCsv(text) {
    const L = String(text).split(/\r?\n/);
    let hi = 0;
    while (hi < L.length && !/time/i.test(L[hi])) hi++;
    const head = (L[hi] || '').split(',').map(s => s.trim().toLowerCase());
    const iTime = head.indexOf('time');
    const iValid = head.indexOf('valid_time');
    let iVal = head.findIndex(h => /index/.test(h));
    if (iVal < 0) iVal = head.length - 2;
    if (iTime < 0 || iValid < 0) throw new Error('Formato previsione non riconosciuto');
    let maxInit = '';
    let bucket = [];
    for (let i = hi + 1; i < L.length; i++) {
      const line = L[i];
      if (!line) continue;
      const p = line.split(',');
      const init = (p[iTime] || '').trim();
      if (init < maxInit) continue;
      if (init > maxInit) { maxInit = init; bucket = []; }
      const v = num(p[iVal]);
      if (v === null || v < -90) continue;
      bucket.push([(p[iValid] || '').trim(), v]);
    }
    const g = new Map();
    bucket.forEach(([vt, v]) => { if (!g.has(vt)) g.set(vt, []); g.get(vt).push(v); });
    const days = [];
    g.forEach((arr, vt) => {
      const x = parseIsoDay(vt);
      if (x === null) return;
      const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
      days.push({ x, mean, min: Math.min.apply(null, arr), max: Math.max.apply(null, arr), n: arr.length });
    });
    days.sort((a, b) => a.x - b.x);
    return { init: parseIsoDay(maxInit), days };
  }

  // tele_index.nh: yyyy mm NAO EA WP EP/NP PNA EA/WR SCA TNH POL Expl.Var
  const TELE_M = ['NAO', 'EA', 'WP', 'EPNP', 'PNA', 'EAWR', 'SCA', 'TNH', 'POL'];
  function parseTeleMonthly(text) {
    const out = {}; TELE_M.forEach(k => { out[k] = []; });
    lines(text).forEach(l => {
      const p = l.trim().split(/\s+/);
      if (p.length < 11 || !/^\d{4}$/.test(p[0]) || !/^\d{1,2}$/.test(p[1])) return;
      const y = +p[0], m = +p[1];
      if (m < 1 || m > 12) return;
      TELE_M.forEach((k, j) => {
        const v = num(p[j + 2]);
        if (v !== null && v > -90) out[k].push({ x: utc(y, m - 1, 1), y: v });
      });
    });
    return out;
  }

  // Formato standard PSL: prima riga "anno_inizio anno_fine", poi "anno v1..v12"
  function parsePsl(text) {
    const out = [];
    lines(text).forEach((l, idx) => {
      const p = l.trim().split(/\s+/);
      if (idx === 0 && p.length === 2) return;
      if (p.length !== 13 || !/^\d{4}$/.test(p[0])) return;
      for (let m = 0; m < 12; m++) {
        const v = num(p[m + 1]);
        if (v !== null && v > -99) out.push({ x: utc(+p[0], m, 1), y: v });
      }
    });
    return out;
  }

  // oni.ascii.txt: SEAS YR TOTAL ANOM  (DJF 1950 24.72 -1.53)
  const SEAS = ['DJF', 'JFM', 'FMA', 'MAM', 'AMJ', 'MJJ', 'JJA', 'JAS', 'ASO', 'SON', 'OND', 'NDJ'];
  function parseOni(text) {
    const out = [];
    lines(text).forEach(l => {
      const p = l.trim().split(/\s+/);
      const s = SEAS.indexOf((p[0] || '').toUpperCase());
      if (s < 0 || p.length < 4) return;
      const v = num(p[3]);
      if (v === null || v < -90) return;
      out.push({ x: utc(+p[1], s, 15), y: v, seas: p[0].toUpperCase(), year: +p[1] });
    });
    return out;
  }

  // wksst9120.for: " 03JAN1990     23.4-0.4     25.1-0.3     26.6 0.0     28.6 0.1"
  function parseNinoWeekly(text) {
    const out = { n12: [], n3: [], n34: [], n4: [] };
    lines(text).forEach(l => {
      const m = /^\s*(\d{2})([A-Za-z]{3})(\d{4})(.*)$/.exec(l);
      if (!m) return;
      const mo = MONTHS[m[2].toUpperCase()];
      if (mo === undefined) return;
      const t = utc(+m[3], mo, +m[1]);
      const n = (m[4].match(/-?\d+\.\d+/g) || []).map(Number);
      if (n.length < 8) return;
      out.n12.push({ x: t, y: n[1], sst: n[0] });
      out.n3.push({ x: t, y: n[3], sst: n[2] });
      out.n34.push({ x: t, y: n[5], sst: n[4] });
      out.n4.push({ x: t, y: n[7], sst: n[6] });
    });
    return out;
  }

  // rmm.74toRealtime.txt: year month day RMM1 RMM2 phase amplitude ...
  function parseRmm(text, keepDays) {
    const L = String(text).split(/\r?\n/);
    const out = [];
    for (let i = L.length - 1; i >= 0 && out.length < (keepDays || 180); i--) {
      const p = L[i].trim().split(/\s+/);
      if (p.length < 7 || !/^\d{4}$/.test(p[0])) continue;
      const r1 = num(p[3]), r2 = num(p[4]), ph = num(p[5]), amp = num(p[6]);
      if (r1 === null || r2 === null || amp === null || Math.abs(r1) > 900 || amp > 900) continue;
      out.push({ x: utc(+p[0], +p[1] - 1, +p[2]), rmm1: r1, rmm2: r2, phase: ph, amp: amp });
    }
    return out.reverse();
  }

  function parseKp(json) {
    return toRows(json).map(r => ({
      x: parseSwpcTime(pick(r, ['time_tag', 'time'])),
      y: num(pick(r, ['Kp', 'kp', 'kp_index'])),
      kind: String(pick(r, ['observed']) || 'observed').toLowerCase()
    })).filter(p => p.x !== null && p.y !== null);
  }

  function parseSolarWind(plasmaJson, magJson) {
    const clean = rows => {
      const hasActive = rows.some(r => r.active !== undefined);
      const by = new Map();
      rows.forEach(r => { if (hasActive && r.active === false) return; if (r.x !== null) by.set(r.x, r); });
      const a = Array.from(by.values()).sort((p, q) => p.x - q.x);
      const lastX = a.length ? a[a.length - 1].x : 0;
      return a.filter(r => r.x >= lastX - 864e5);
    };
    const pl = clean(toRows(plasmaJson).map(r => ({
      x: parseSwpcTime(r.time_tag), active: r.active,
      speed: num(pick(r, ['proton_speed', 'speed'])), density: num(pick(r, ['proton_density', 'density']))
    })));
    const mg = clean(toRows(magJson).map(r => ({
      x: parseSwpcTime(r.time_tag), active: r.active, bz: num(pick(r, ['bz_gsm', 'bz'])), bt: num(r.bt)
    })));
    return { plasma: downsample(pl, 240), mag: downsample(mg, 240) };
  }

  function parseXray(json) {
    return toRows(json)
      .filter(r => String(r.energy || '').indexOf('0.1-0.8') >= 0)
      .map(r => ({ x: parseSwpcTime(r.time_tag), y: num(pick(r, ['flux', 'observed_flux'])) }))
      .filter(p => p.x !== null && p.y !== null && p.y > 0);
  }

  function pos(v) { const n = num(v); return n === null || n < 0 ? null : n; } // SWPC usa -1 per "mancante"
  function parseCycle(obsJson, predJson) {
    const obs = toRows(obsJson).map(r => ({
      x: parseSwpcTime(r['time-tag'] || r.time_tag),
      ssn: pos(r.ssn), ssnS: pos(r.smoothed_ssn),
      f107: pos(r['f10.7']), f107S: pos(r['smoothed_f10.7'])
    })).filter(p => p.x !== null);
    const pred = toRows(predJson || []).map(r => ({
      x: parseSwpcTime(r['time-tag'] || r.time_tag),
      ssn: pos(r.predicted_ssn), hi: pos(r.high_ssn), lo: pos(r.low_ssn),
      f107: pos(r['predicted_f10.7'])
    })).filter(p => p.x !== null);
    return { obs, pred };
  }

  function parseF107Daily(json) {
    let rows = toRows(json);
    const has2800 = rows.some(r => String(r.frequency) === '2800');
    if (has2800) rows = rows.filter(r => String(r.frequency) === '2800');
    const byDay = new Map();
    rows.forEach(r => {
      const t = parseSwpcTime(r.time_tag);
      const v = num(pick(r, ['flux', 'f107', 'observed_flux']));
      if (t === null || v === null) return;
      const d = Math.floor(t / 864e5) * 864e5;
      byDay.set(d, v); // l'ultima misura del giorno
    });
    return Array.from(byDay.entries()).sort((a, b) => a[0] - b[0]).map(([x, y]) => ({ x, y }));
  }

  function downsample(arr, n) {
    if (arr.length <= n) return arr;
    const step = arr.length / n;
    const out = [];
    for (let i = 0; i < n; i++) out.push(arr[Math.floor(i * step)]);
    out.push(arr[arr.length - 1]);
    return out;
  }

  /* ---------- classificazioni ---------- */
  function xrayClass(f) {
    if (!f || f <= 0) return '—';
    const cls = [['X', 1e-4], ['M', 1e-5], ['C', 1e-6], ['B', 1e-7], ['A', 1e-8]];
    for (const [c, b] of cls) if (f >= b) return c + (f / b).toFixed(1);
    return '<A';
  }
  function gScale(kp) {
    if (kp >= 9) return 'G5'; if (kp >= 8) return 'G4'; if (kp >= 7) return 'G3';
    if (kp >= 6) return 'G2'; if (kp >= 5) return 'G1'; return '';
  }
  function ensoState(oni) {
    if (oni === null || oni === undefined) return '';
    if (oni >= 1.5) return 'El Niño forte'; if (oni >= 1.0) return 'El Niño moderato';
    if (oni >= 0.5) return 'El Niño debole'; if (oni <= -1.5) return 'La Niña forte';
    if (oni <= -1.0) return 'La Niña moderata'; if (oni <= -0.5) return 'La Niña debole';
    return 'Neutro';
  }

  global.MeteoData = {
    SRC, LEV, TELE_M,
    parseTeleDaily, parseCdas, findMjoImage, parseWic, parseWicSelect, parseWicMaps, parseEnsCsv, parseTeleMonthly, parsePsl, parseOni, parseNinoWeekly,
    parseRmm, parseKp, parseSolarWind, parseXray, parseCycle, parseF107Daily,
    toRows, parseSwpcTime, xrayClass, gScale, ensoState, downsample
  };
  if (typeof module !== 'undefined') module.exports = global.MeteoData;
})(typeof window !== 'undefined' ? window : globalThis);
