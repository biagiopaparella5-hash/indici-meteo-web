/* Indici Meteo — © Biagio Paparella. Tutti i diritti riservati. */
/* Indici di instabilità — dati modello da Open-Meteo, indici calcolati qui */
(function (global) {
  'use strict';

  const MODELS = [
    ['best_match', 'Automatico (migliore)'],
    ['icon_seamless', 'ICON (DWD)'],
    ['italia_meteo_arpae_icon_2i', 'ICON-2I Italia (ARPAE)'],
    ['ecmwf_ifs025', 'ECMWF IFS'],
    ['gfs_seamless', 'GFS (NOAA)'],
    ['meteofrance_seamless', 'Météo-France (ARPEGE/AROME)'],
    ['ukmo_seamless', 'UK Met Office']
  ];

  const HOURLY = [
    'temperature_2m', 'dew_point_2m', 'surface_pressure', 'precipitation',
    'cape', 'lifted_index', 'convective_inhibition', 'freezing_level_height',
    'temperature_850hPa', 'dew_point_850hPa', 'temperature_700hPa', 'dew_point_700hPa',
    'temperature_500hPa', 'wind_speed_10m', 'wind_direction_10m',
    'wind_speed_850hPa', 'wind_direction_850hPa', 'wind_speed_500hPa', 'wind_direction_500hPa'
  ];

  const CITIES = [
    ['Aosta', 45.74, 7.32], ['Torino', 45.07, 7.69], ['Milano', 45.46, 9.19], ['Trento', 46.07, 11.12],
    ['Venezia', 45.44, 12.33], ['Trieste', 45.65, 13.78], ['Genova', 44.41, 8.93], ['Bologna', 44.49, 11.34],
    ['Firenze', 43.77, 11.25], ['Ancona', 43.62, 13.52], ['Perugia', 43.11, 12.39], ['Roma', 41.90, 12.50],
    ['Pescara', 42.46, 14.21], ['Napoli', 40.85, 14.27], ['Bari', 41.12, 16.87], ['Potenza', 40.64, 15.80],
    ['Catanzaro', 38.91, 16.59], ['Palermo', 38.12, 13.36], ['Catania', 37.50, 15.09], ['Cagliari', 39.22, 9.12]
  ];

  /* ---------- termodinamica ---------- */
  const Rd = 287.04, Cp = 1005.7, Lv = 2.501e6, EPS = 0.622, KAPPA = Rd / Cp;
  function es(Tc) { return 6.112 * Math.exp(17.67 * Tc / (Tc + 243.5)); } // hPa
  function mixr(Tc, p) { const e = es(Tc); return EPS * e / (p - e); }

  // Temperatura (°C) di una particella sollevata da (p0,T0,Td0) fino a pTop
  function liftParcel(p0, T0, Td0, pTop) {
    if ([p0, T0, Td0, pTop].some(v => v === null || v === undefined || !isFinite(v))) return null;
    Td0 = Math.min(Td0, T0);
    const TK = T0 + 273.15, TdK = Td0 + 273.15;
    const Tlcl = 1 / (1 / (TdK - 56) + Math.log(TK / TdK) / 800) + 56; // Bolton 1980
    const plcl = p0 * Math.pow(Tlcl / TK, 1 / KAPPA);
    if (plcl <= pTop) return TK * Math.pow(pTop / p0, KAPPA) - 273.15; // secca fino in cima
    let T = Tlcl, p = plcl;
    const dp = -2;
    while (p + dp > pTop) {
      T += dTdp(T, p) * dp; p += dp;
    }
    T += dTdp(T, p) * (pTop - p);
    return T - 273.15;
  }
  function dTdp(TK, p) { // pseudoadiabatica satura
    const rs = mixr(TK - 273.15, p);
    return (1 / p) * (Rd * TK + Lv * rs) / (Cp + (Lv * Lv * rs * EPS) / (Rd * TK * TK));
  }

  function kIndex(t850, td850, t700, td700, t500) {
    if ([t850, td850, t700, td700, t500].some(v => v === null || v === undefined)) return null;
    return (t850 - t500) + td850 - (t700 - td700);
  }
  function totalTotals(t850, td850, t500) {
    if ([t850, td850, t500].some(v => v === null || v === undefined)) return null;
    return t850 + td850 - 2 * t500;
  }
  function showalter(t850, td850, t500) {
    const tp = liftParcel(850, t850, td850, 500);
    return tp === null || t500 === null || t500 === undefined ? null : t500 - tp;
  }
  function surfaceLI(psfc, t2, td2, t500) {
    if (psfc === null || psfc === undefined || psfc <= 520) return null;
    const tp = liftParcel(psfc, t2, td2, 500);
    return tp === null || t500 === null || t500 === undefined ? null : t500 - tp;
  }
  function uv(speedKmh, dirDeg) {
    if (speedKmh === null || dirDeg === null || speedKmh === undefined || dirDeg === undefined) return null;
    const s = speedKmh / 3.6, r = dirDeg * Math.PI / 180;
    return [-s * Math.sin(r), -s * Math.cos(r)];
  }
  function shear(sp1, d1, sp2, d2) { // m/s
    const a = uv(sp1, d1), b = uv(sp2, d2);
    if (!a || !b) return null;
    return Math.hypot(b[0] - a[0], b[1] - a[1]);
  }

  /* ---------- livello di rischio indicativo ---------- */
  function risk(cape, li, sh, k) {
    let s = 0;
    if (cape !== null) s += cape >= 2500 ? 3 : cape >= 1500 ? 2 : cape >= 500 ? 1 : 0;
    if (li !== null) s += li <= -6 ? 3 : li <= -3 ? 2 : li < 0 ? 1 : 0;
    if (k !== null) s += k >= 35 ? 2 : k >= 28 ? 1 : 0;
    if (sh !== null && (cape || 0) >= 300) s += sh >= 20 ? 2 : sh >= 12 ? 1 : 0;
    if (s >= 8) return { lvl: 4, txt: 'Molto alto' };
    if (s >= 6) return { lvl: 3, txt: 'Alto' };
    if (s >= 4) return { lvl: 2, txt: 'Moderato' };
    if (s >= 2) return { lvl: 1, txt: 'Basso' };
    return { lvl: 0, txt: 'Assente' };
  }

  /* ---------- elaborazione risposta Open-Meteo ---------- */
  function process(json) {
    const h = json.hourly || {};
    const time = (h.time || []).map(t => Date.parse(t.length === 16 ? t + ':00Z' : t) );
    const g = k => (h[k] || []);
    const rows = time.map((x, i) => {
      const t850 = g('temperature_850hPa')[i], td850 = g('dew_point_850hPa')[i];
      const t700 = g('temperature_700hPa')[i], td700 = g('dew_point_700hPa')[i];
      const t500 = g('temperature_500hPa')[i];
      const liModel = g('lifted_index')[i];
      const liCalc = surfaceLI(g('surface_pressure')[i], g('temperature_2m')[i], g('dew_point_2m')[i], t500);
      const r = {
        x,
        cape: nz(g('cape')[i]),
        cin: nz(g('convective_inhibition')[i]),
        li: nz(liModel !== null && liModel !== undefined ? liModel : liCalc),
        liSrc: liModel !== null && liModel !== undefined ? 'modello' : 'calcolato',
        k: kIndex(t850, td850, t700, td700, t500),
        tt: totalTotals(t850, td850, t500),
        si: showalter(t850, td850, t500),
        shear: shear(g('wind_speed_10m')[i], g('wind_direction_10m')[i], g('wind_speed_500hPa')[i], g('wind_direction_500hPa')[i]),
        frz: nz(g('freezing_level_height')[i]),
        t850: nz(t850), t500: nz(t500),
        prec: nz(g('precipitation')[i])
      };
      r.risk = risk(r.cape, r.li, r.shear, r.k);
      return r;
    });
    return { rows, tz: json.timezone, offset: (json.utc_offset_seconds || 0) * 1000, elevation: json.elevation };
  }
  function nz(v) { return v === undefined || v === null || !isFinite(v) ? null : v; }

  function dailySummary(rows, offset) {
    const days = new Map();
    rows.forEach(r => {
      const d = Math.floor((r.x + (offset || 0)) / 864e5);
      if (!days.has(d)) days.set(d, []);
      days.get(d).push(r);
    });
    return Array.from(days.entries()).map(([d, rs]) => {
      const mx = k => { const v = rs.map(r => r[k]).filter(v => v !== null); return v.length ? Math.max.apply(null, v) : null; };
      const mn = k => { const v = rs.map(r => r[k]).filter(v => v !== null); return v.length ? Math.min.apply(null, v) : null; };
      const sum = k => rs.reduce((a, r) => a + (r[k] || 0), 0);
      const worst = rs.reduce((a, r) => (r.risk.lvl > a.lvl ? r.risk : a), { lvl: 0, txt: 'Assente' });
      return { day: d * 864e5, cape: mx('cape'), li: mn('li'), k: mx('k'), tt: mx('tt'), si: mn('si'), shear: mx('shear'), prec: sum('prec'), risk: worst };
    });
  }

  function forecastUrl(lat, lon, model, days) {
    return 'https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lon +
      '&hourly=' + HOURLY.join(',') + '&models=' + encodeURIComponent(model || 'best_match') +
      '&forecast_days=' + (days || 7) + '&timezone=auto';
  }
  function italyUrl(model) {
    return 'https://api.open-meteo.com/v1/forecast?latitude=' + CITIES.map(c => c[1]).join(',') +
      '&longitude=' + CITIES.map(c => c[2]).join(',') +
      '&hourly=cape,lifted_index,surface_pressure,temperature_2m,dew_point_2m,temperature_500hPa' +
      '&models=' + encodeURIComponent(model || 'best_match') + '&forecast_days=3&timezone=Europe%2FRome';
  }
  function geocodeUrl(q) {
    return 'https://geocoding-api.open-meteo.com/v1/search?count=8&language=it&format=json&name=' + encodeURIComponent(q);
  }
  function italySummary(json) {
    const arr = Array.isArray(json) ? json : [json];
    return arr.map((j, i) => {
      const h = j.hourly || {};
      const days = new Map();
      (h.time || []).forEach((t, k) => {
        const d = t.slice(0, 10);
        if (!days.has(d)) days.set(d, { cape: null, li: null });
        const o = days.get(d);
        const c = h.cape ? h.cape[k] : null;
        let li = h.lifted_index ? h.lifted_index[k] : null;
        if (li === null || li === undefined) li = surfaceLI(h.surface_pressure && h.surface_pressure[k], h.temperature_2m && h.temperature_2m[k], h.dew_point_2m && h.dew_point_2m[k], h.temperature_500hPa && h.temperature_500hPa[k]);
        if (c !== null && c !== undefined) o.cape = o.cape === null ? c : Math.max(o.cape, c);
        if (li !== null && li !== undefined) o.li = o.li === null ? li : Math.min(o.li, li);
      });
      return { name: CITIES[i] ? CITIES[i][0] : '?', days: Array.from(days.entries()).map(([d, o]) => ({ d, cape: o.cape, li: o.li, risk: risk(o.cape, o.li, null, null) })) };
    });
  }

  global.Instab = { MODELS, CITIES, process, dailySummary, forecastUrl, italyUrl, geocodeUrl, italySummary, liftParcel, kIndex, totalTotals, showalter, shear, risk };
  if (typeof module !== 'undefined') module.exports = global.Instab;
})(typeof window !== 'undefined' ? window : globalThis);
