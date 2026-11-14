/* Indici Meteo — interfaccia
 * © Biagio Paparella. Tutti i diritti riservati. Vietata la copia o la modifica senza autorizzazione dell'autore. */
(function () {
  'use strict';
  const D = window.MeteoData, I = window.Instab, C = window.Chart, SRC = D.SRC;
  const $ = (s, r) => (r || document).querySelector(s);
  const H = 3600e3, DAY = 864e5;
  const IS_APP = !!window.Android || location.hostname === 'appassets.androidplatform.net';
  const MESI = C.MESI;

  /* ================= rete e cache ================= */
  const LASTMOD = {}; // data di pubblicazione dei file (intestazione Last-Modified)
  async function fetchText(urls, timeout, range) {
    let last;
    for (const url of [].concat(urls)) {
      try {
        const u = IS_APP ? '/proxy?u=' + encodeURIComponent(url) + (range ? '&range=' + encodeURIComponent(range) : '') : url;
        const ctl = new AbortController();
        const tm = setTimeout(() => ctl.abort(), timeout || 45000);
        const r = await fetch(u, { signal: ctl.signal, cache: 'no-store' });
        clearTimeout(tm);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const lm = r.headers.get('last-modified');
        if (lm && !isNaN(Date.parse(lm))) LASTMOD[url] = Date.parse(lm);
        return await r.text();
      } catch (e) { last = e; }
    }
    throw last || new Error('errore di rete');
  }
  const fetchJson = async (u, t) => JSON.parse(await fetchText(u, t));

  const store = {
    get(k) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* spazio pieno: ignora */ } }
  };

  /* ================= dataset ================= */
  const fcLoader = k => async () => {
    const gefs = D.parseEnsCsv(await fetchText(SRC.gefs(k), 90000));
    let gfs = null;
    try { gfs = D.parseEnsCsv(await fetchText(SRC.gfs(k))); } catch (e) { /* facoltativo */ }
    return { gefs, gfs };
  };
  const DS = {
    teleDaily: { ttl: 3 * H, src: SRC.teleCdas('nao'), load: async () => {
      // file giornalieri ufficiali CPC (uno per indice); si scarica solo la parte finale del file
      const out = {}; let errs = [];
      await Promise.all(['nao', 'ao', 'pna', 'aao'].map(async k => {
        try { out[k] = D.parseCdas(await fetchText(SRC.teleCdas(k), 90000, 'bytes=-12000'), 150); if (!out[k].length) throw new Error('file vuoto'); }
        catch (e) { errs.push(k.toUpperCase() + ': ' + (e.message || e)); delete out[k]; }
      }));
      if (Object.keys(out).length < 4) { // ripiego sul file riassuntivo, se esiste
        try { const g = D.parseTeleDaily(await fetchText(SRC.teleDaily)); for (const k in g) if (!out[k] && g[k].length) out[k] = g[k]; } catch (e) { /* */ }
      }
      if (!Object.keys(out).length) throw new Error(errs.join(' · ') || 'nessun dato');
      return out;
    } },
    fc_nao: { ttl: 6 * H, src: SRC.gefs('nao'), load: fcLoader('nao') },
    fc_ao: { ttl: 6 * H, src: SRC.gefs('ao'), load: fcLoader('ao') },
    fc_pna: { ttl: 6 * H, src: SRC.gefs('pna'), load: fcLoader('pna') },
    fc_aao: { ttl: 6 * H, src: SRC.gefs('aao'), load: fcLoader('aao') },
    teleMonthly: { ttl: 12 * H, src: SRC.teleMonthly, load: async () => trimObj(D.parseTeleMonthly(await fetchText(SRC.teleMonthly)), 120) },
    oni: { ttl: 12 * H, src: SRC.oni, load: async () => D.parseOni(await fetchText(SRC.oni)).slice(-240) },
    nino: { ttl: 6 * H, src: SRC.ninoWeekly, load: async () => trimObj(D.parseNinoWeekly(await fetchText(SRC.ninoWeekly)), 156) },
    rmm: { ttl: 4 * H, src: SRC.rmm, load: async () => D.parseRmm(await fetchText(SRC.rmm, 120000, 'bytes=-25000'), 180) },
    wic: { ttl: 2 * H, src: SRC.wic, load: async () => D.parseWic(await fetchText(SRC.wic)) },
    namDate: { ttl: 2 * H, src: ['https://stratobserve.com/anom_ts_diags'], load: async () => {
      // trova la corsa più recente pubblicata su StratObserve (provando l'immagine NAM di GFS)
      for (let i = 0; i < 8; i++) {
        const d = new Date(Date.now() - i * DAY).toISOString().slice(0, 10).replace(/-/g, '');
        if (await imgOk(namUrl(d, 'gfs', 'namindex'))) return { date: d };
      }
      throw new Error('nessuna corsa trovata negli ultimi 8 giorni');
    } },
    mjoFc2: { ttl: 3 * H, src: SRC.mjoGefsPages, load: async () => {
      const find = async (pages, code) => {
        for (const page of pages) {
          try {
            const html = await fetchText([page]);
            const u = D.findMjoImage(html, page, code) || (page.indexOf('clivar_wh') < 0 ? D.findMjoImage(html, page, '') : null);
            if (u) return u;
          } catch (e) { /* prova la pagina successiva */ }
        }
        return null;
      };
      // prima gli indirizzi diretti delle immagini del CPC (stesso schema dell'ECMWF: /mjo/img/<CODICE>.png)
      const IMG = 'https://www.cpc.ncep.noaa.gov/products/precip/mjo/img/';
      const firstOk = async list => { for (const u of list) if (await imgOk(u + '?t=' + Date.now())) return u; return null; };
      const [g0, e0] = await Promise.all([firstOk([IMG + 'NCPE.png', IMG + 'NCPE.gif', IMG + 'GEFS.png', IMG + 'GMON.png']), firstOk([IMG + 'ECMF.png'])]);
      const [gefs, ecmf] = await Promise.all([g0 || find(SRC.mjoGefsPages, 'NCPE'), e0 || find(SRC.mjoEcmfPages, 'ECMF')]);
      if (!gefs && !ecmf) throw new Error('immagini di previsione non trovate');
      return { gefs, ecmf };
    } },
    qbo: { ttl: 12 * H, src: SRC.qbo, load: async () => D.parsePsl(await fetchText(SRC.qbo)).slice(-240) },
    dmi: { ttl: 12 * H, src: SRC.dmi, load: async () => D.parsePsl(await fetchText(SRC.dmi)).slice(-240) },
    kp: { ttl: 0.25 * H, src: SRC.kp, load: async () => {
      const obs = D.parseKp(await fetchJson(SRC.kp));
      let fc = []; try { fc = D.parseKp(await fetchJson(SRC.kpFc)); } catch (e) { /* */ }
      return { obs, fc };
    } },
    wind: { ttl: 0.25 * H, src: SRC.plasma, load: async () => D.parseSolarWind(await fetchJson(SRC.plasma), await fetchJson(SRC.mag)) },
    xray: { ttl: 0.25 * H, src: SRC.xray, load: async () => D.downsample(D.parseXray(await fetchJson(SRC.xray)), 360) },
    cycle: { ttl: 12 * H, src: SRC.cycleObs, load: async () => {
      let pred = []; try { pred = await fetchJson(SRC.cyclePred); } catch (e) { /* */ }
      const c = D.parseCycle(await fetchJson(SRC.cycleObs), pred);
      c.obs = c.obs.filter(p => p.x >= Date.UTC(1996, 0, 1));
      let f107 = []; try { f107 = D.parseF107Daily(await fetchJson(SRC.f107)).slice(-120); } catch (e) { /* */ }
      c.f107d = f107;
      return c;
    } }
  };
  function namUrl(d, model, diag) { return 'https://stratobserve.com/plots/' + d + '/tseries/anoms/' + model + '_nh-' + diag + '_' + d + '.png'; }
  function imgOk(u) {
    return new Promise(res => {
      const i = new Image(); const t = setTimeout(() => res(false), 20000);
      i.onload = () => { clearTimeout(t); res(i.naturalWidth > 0); };
      i.onerror = () => { clearTimeout(t); res(false); };
      i.src = u;
    });
  }
  function trimObj(o, n) { const r = {}; for (const k in o) r[k] = o[k].slice(-n); return r; }

  const inflight = {};
  function cached(id) { return store.get('ds:' + id); }
  async function getDS(id, force) {
    const c = cached(id);
    if (!force && c && c.data && !c.err && Date.now() - c.t < DS[id].ttl) return c;
    if (!force && c && c.err && c.tErr && Date.now() - c.tErr < 10 * 60e3) return c;
    if (inflight[id]) return inflight[id];
    inflight[id] = (async () => {
      try {
        const data = await DS[id].load();
        const lms = [].concat(DS[id].src).map(u => LASTMOD[u]).filter(Boolean);
        const v = { t: Date.now(), data, lm: lms.length ? Math.max.apply(null, lms) : null };
        store.set('ds:' + id, v);
        return v;
      } catch (e) {
        console.warn(id, e);
        const err = String(e.message || e);
        const v = c ? Object.assign({}, c, { err, tErr: Date.now() }) : { t: 0, data: null, err, tErr: Date.now() };
        store.set('ds:' + id, v);
        return v;
      } finally { delete inflight[id]; }
    })();
    return inflight[id];
  }

  /* ================= formattazione ================= */
  const f1 = v => v === null || v === undefined || !isFinite(v) ? '—' : v.toFixed(1).replace('.', ',');
  const f2 = v => v === null || v === undefined || !isFinite(v) ? '—' : v.toFixed(2).replace('.', ',');
  const f0 = v => v === null || v === undefined || !isFinite(v) ? '—' : Math.round(v).toLocaleString('it-IT');
  const sgn = (v, f) => (v > 0 ? '+' : '') + (f || f2)(v);
  function dDay(t) { const d = new Date(t); return d.getUTCDate() + ' ' + MESI[d.getUTCMonth()] + ' ' + d.getUTCFullYear(); }
  function dMonth(t) { const d = new Date(t); return MESI[d.getUTCMonth()] + ' ' + d.getUTCFullYear(); }
  function dHour(t) { const d = new Date(t); return d.getUTCDate() + ' ' + MESI[d.getUTCMonth()] + ' ' + String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0') + ' UTC'; }
  function ago(t) {
    if (!t) return 'mai';
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return 'ora'; if (m < 60) return m + ' min fa';
    const h = Math.round(m / 60); if (h < 48) return h + ' h fa';
    return Math.round(h / 24) + ' giorni fa';
  }
  const last = a => (a && a.length ? a[a.length - 1] : null);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const FG = () => (getComputedStyle(document.documentElement).getPropertyValue('--fg') || '#e9ecef').trim();

  /* ---------- immagini dai siti: data di ripiego e download ---------- */
  // <img> che, se l'immagine manca, prova le date precedenti (formato YYYYMMDD nell'indirizzo)
  window.__imgFallback = function (img) {
    const tries = +(img.dataset.tries || 0);
    const d = img.dataset.date;
    if (d && tries < 4) {
      const prev = new Date(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8)) - DAY).toISOString().slice(0, 10).replace(/-/g, '');
      img.dataset.tries = tries + 1;
      img.dataset.date = prev;
      img.src = img.dataset.tpl.split('{D}').join(prev);
      const note = img.parentNode.querySelector('.imgnote');
      if (note) note.textContent = 'Corsa più recente non ancora pubblicata: mostro quella del ' + prev.slice(6, 8) + '/' + prev.slice(4, 6);
      return;
    }
    const box = document.createElement('div'); box.className = 'err'; box.textContent = img.dataset.name + ': grafico non disponibile al momento';
    const w = img.parentNode; w.innerHTML = ''; w.appendChild(box);
  };
  window.__download = function (btn) {
    // il grafico è quello nello stesso riquadro del pulsante (non il primo della pagina)
    const wrap = btn.closest('.imgwrap');
    let img = wrap && wrap.querySelector('img');
    if (!img) { let p = btn.previousElementSibling; while (p && !img) { img = p.tagName === 'IMG' ? p : p.querySelector && p.querySelector('img'); p = p.previousElementSibling; } }
    if (!img) { btn.textContent = 'Grafico non disponibile'; return; }
    const url = img.currentSrc || img.src;
    const name = (btn.dataset.file || 'grafico') + '_' + new Date().toISOString().slice(0, 10) + '.' + ((url.match(/\.(png|gif|jpe?g)(\?|$)/i) || [, 'png'])[1].toLowerCase());
    if (window.Android && Android.saveImage) { Android.saveImage(url, name); btn.textContent = '✓ Download avviato'; setTimeout(() => { btn.textContent = '⬇ Scarica grafico'; }, 4000); }
    else { const a = document.createElement('a'); a.href = url; a.download = name; a.target = '_blank'; document.body.appendChild(a); a.click(); a.remove(); }
  };
  // tpl: indirizzo con {D} al posto della data (oppure indirizzo fisso); date: YYYYMMDD o null
  function extImg(tpl, name, file, date, bust) {
    const src = date ? tpl.split('{D}').join(date) : tpl + (bust ? (tpl.indexOf('?') < 0 ? '?' : '&') + 't=' + bust : '');
    return '<div class="imgwrap"><img class="sun zimg" loading="lazy" src="' + src + '" data-tpl="' + esc(tpl) + '" data-date="' + (date || '') + '" data-name="' + esc(name) + '" alt="" onerror="__imgFallback(this)">' +
      '<div class="imgnote"></div><button class="dl" data-file="' + esc(file) + '" onclick="__download(this)">⬇ Scarica grafico</button></div>';
  }
  function bindZoom(el) { el.querySelectorAll('.zimg:not([data-z])').forEach(i => { i.dataset.z = 1; i.addEventListener('click', () => i.classList.toggle('zoom')); }); }
  const dayBust = () => new Date().toISOString().slice(0, 13).replace(/\D/g, '');

  const posNeg = v => (v >= 0 ? 'var(--pos)' : 'var(--neg)');

  /* ================= "NUOVO" ================= */
  function isNew(cardId, stamp) {
    if (!stamp) return false;
    const seen = store.get('seen') || {};
    if (seen[cardId] === undefined) { seen[cardId] = stamp; store.set('seen', seen); return false; }
    return seen[cardId] !== stamp;
  }
  function markSeen(cardId, stamp) { if (!stamp) return; const s = store.get('seen') || {}; s[cardId] = stamp; store.set('seen', s); }

  /* ================= testi esplicativi ================= */
  const INFO = {
    nao: 'Differenza di pressione tra la zona dell\'Islanda e quella delle Azzorre. <b>NAO positiva</b>: anticiclone delle Azzorre robusto e correnti occidentali spostate verso il Nord Europa; sull\'Italia tempo spesso più stabile e asciutto e inverni più miti. <b>NAO negativa</b>: correnti atlantiche più meridionali, più perturbazioni sul Mediterraneo e maggiori possibilità di irruzioni fredde, soprattutto in inverno.',
    ao: 'Oscillazione Artica: indica quanto è compatto il vortice polare nei bassi strati. <b>AO positiva</b>: aria fredda confinata alle alte latitudini. <b>AO negativa</b>: vortice più debole e ondulato, più probabili le discese di aria artica verso le medie latitudini, Europa compresa.',
    pna: 'Pattern Pacifico–Nord America. Agisce soprattutto sul Nord America, ma cambiando l\'andamento della corrente a getto modifica a cascata la circolazione sull\'Atlantico e quindi sull\'Europa, con qualche giorno di ritardo.',
    aao: 'Oscillazione Antartica (Southern Annular Mode): l\'equivalente australe dell\'AO. Utile per l\'emisfero sud, effetto sull\'Italia trascurabile.',
    monthly: 'Pattern di teleconnessione mensili calcolati dal CPC (valori standardizzati). <b>EA</b> (Est Atlantico) positivo: temperature sopra media in Europa, piogge più abbondanti al Nord Europa e scarse al Sud. <b>SCA</b> (Scandinavo) positivo: alta pressione/blocco sulla Scandinavia, temperature sotto media nell\'Europa occidentale e più precipitazioni nel Sud Europa. <b>EA/WR</b> (Est Atlantico/Russia occidentale) positivo: alta pressione sull\'Europa occidentale e bassa verso il Caspio. <b>WP</b>, <b>EP/NP</b>, <b>TNH</b>: pattern del Pacifico. <b>POL</b>: pattern polare/euroasiatico.',
    enso: 'Anomalia della temperatura superficiale del Pacifico equatoriale (regione Niño 3.4). L\'<b>ONI</b> è la media mobile su 3 mesi: ≥ +0,5 °C El Niño, ≤ −0,5 °C La Niña. Il dato settimanale anticipa la tendenza. L\'effetto sull\'Europa è debole e indiretto, ma ENSO conta molto su scala globale e per le previsioni stagionali.',
    mjo: 'Oscillazione Madden-Julian: un\'area di convezione tropicale che si sposta verso est in 30–60 giorni. Il diagramma mostra la fase (1–8) e l\'ampiezza: dentro il cerchio (ampiezza &lt; 1) la MJO è debole. Diversi studi indicano che le fasi 3–4 tendono a favorire una NAO positiva e le fasi 6–7 una NAO negativa circa 1–2 settimane dopo: utile per la tendenza a medio-lungo termine.',
    qbo: 'Oscillazione Quasi-Biennale: vento medio a 30 hPa sopra l\'equatore (m/s). Valori positivi = fase occidentale, negativi = fase orientale. Con QBO orientale il vortice polare invernale tende a essere più debole e i riscaldamenti stratosferici improvvisi più probabili (effetto Holton-Tan).',
    iod: 'Dipolo dell\'Oceano Indiano (DMI): differenza di anomalia termica tra Oceano Indiano occidentale e orientale. Influenza soprattutto Africa orientale, India e Australia; può modulare indirettamente la circolazione globale.',
    aam: 'Il <b>GLAAM</b> (momento angolare atmosferico globale) misura quanto "girano" i venti occidentali di tutta l\'atmosfera. <b>GLAAM positivo</b>: correnti a getto più forti e distese, tipico di El Niño. <b>GLAAM negativo</b>: getto più debole e ondulato, con più blocchi e saccature alle medie latitudini, tipico di La Niña. La <b>GWO</b> (Global Wind Oscillation) segue il ciclo del GLAAM in 8 fasi, come la MJO. Per il vortice polare il legame è indiretto: un getto troposferico ondulato (GLAAM basso) favorisce onde planetarie più ampie, che possono disturbare il vortice stratosferico; un GLAAM alto tende invece ad accompagnare un vortice più compatto.',
    vortex: 'Il vento zonale medio a 10 hPa e 60°N misura la forza del vortice polare stratosferico. Quando questo vento si inverte (diventa negativo, da occidentale a orientale) si parla di <b>riscaldamento stratosferico improvviso (SSW)</b>: nelle 2–6 settimane successive aumentano le probabilità di AO/NAO negativa e di irruzioni fredde verso l\'Europa, anche se non accade sempre. La probabilità di SSW è la quota dei membri dell\'ensemble che prevedono l\'inversione del vento.',
    nam: 'Il <b>NAM</b> (Northern Annular Mode, modo anulare nord) misura la forza del vortice polare a tutte le quote, dal suolo (1000 hPa) alla stratosfera (1 hPa). Colori <b>blu/positivi</b>: vortice forte e compatto, aria fredda chiusa sull\'Artico. Colori <b>arancio/negativi</b>: vortice debole o disturbato. Quando un\'anomalia negativa forte nasce in stratosfera e "scende" verso la troposfera nelle settimane successive, aumentano le probabilità di AO/NAO negativa e di irruzioni fredde verso l\'Europa. La linea tratteggiata separa l\'analisi (a sinistra) dalla previsione (a destra). I grafici collegati mostrano vento a 60°N (inversione da occidentale a orientale = riscaldamento stratosferico improvviso), temperatura della calotta polare, onde planetarie 1 e 2 e flusso di calore, che indica quanta energia le onde portano verso la stratosfera.',
    strat: 'Lo stato del vortice polare stratosferico (temperatura a 10 hPa, vento a 60°N) è decisivo per le tendenze invernali: un riscaldamento stratosferico improvviso può precedere di 2–4 settimane fasi di AO/NAO negativa. <b>Temperatura</b> della calotta polare in rapido aumento e <b>vento a 60°N</b> che scende sotto lo zero indicano un riscaldamento stratosferico. Il <b>flusso di calore v\'T\'</b> elevato indica onde planetarie che salgono e disturbano il vortice. Nei grafici le linee mostrano analisi e previsione rispetto al clima.',
    kp: 'Indice planetario dell\'attività geomagnetica (0–9) ogni 3 ore. Kp ≥ 5 indica una tempesta geomagnetica (scala NOAA G1–G5). Dall\'Italia le aurore sono visibili solo con tempeste molto forti (Kp 8–9).',
    wind: 'Vento solare misurato dai satelliti nel punto L1, circa un\'ora prima che raggiunga la Terra. Velocità alta (&gt; 500 km/s) e, soprattutto, campo magnetico <b>Bz negativo</b> (verso sud) per molte ore favoriscono le tempeste geomagnetiche.',
    xray: 'Flusso di raggi X misurato dai satelliti GOES (0,1–0,8 nm). Classi dei brillamenti: A, B, C (minori), M (moderati), X (forti). Ogni classe vale 10 volte la precedente.',
    cycle: 'Numero medio mensile di macchie solari (SSN) e flusso radio a 10,7 cm (F10.7, in sfu), con la previsione NOAA dell\'andamento del ciclo solare. Il grafico in basso mostra l\'F10.7 giornaliero.',
    sunimg: 'Immagini più recenti del Sole dai satelliti SDO (NASA) e SOHO (ESA/NASA): fotosfera con le macchie, corona in ultravioletto e coronografo LASCO C3 per le espulsioni di massa coronale.'
  };

  /* ================= stato UI ================= */
  const app = $('#app');
  let route = '';
  function go(h) { if (location.hash !== h) location.hash = h; else render(); }
  window.addEventListener('hashchange', render);

  function setNav(tab) {
    document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  }
  document.querySelectorAll('nav button').forEach(b => b.addEventListener('click', () => go('#/' + b.dataset.tab)));
  $('#refresh').addEventListener('click', () => refreshCurrent(true));

  function status(msg) { const s = $('#status'); s.textContent = msg || ''; s.style.display = msg ? 'block' : 'none'; }

  /* ================= definizione card ================= */
  const TELE_CARDS = [
    { id: 'nao', title: 'NAO', sub: 'Oscillazione Nord Atlantica', ds: ['teleDaily', 'fc_nao'] },
    { id: 'ao', title: 'AO', sub: 'Oscillazione Artica', ds: ['teleDaily', 'fc_ao'] },
    { id: 'pna', title: 'PNA', sub: 'Pacifico – Nord America', ds: ['teleDaily', 'fc_pna'] },
    { id: 'nam', title: 'NAM', sub: 'Modo anulare nord · GFS e GEOS', ds: ['namDate'] },
    { id: 'vortex', title: 'Vortice polare', sub: 'Vento 10 hPa 60°N · probabilità SSW', ds: ['wic'] },
    { id: 'aam', title: 'GLAAM · GWO', sub: 'Momento angolare atmosferico', ds: [] },
    { id: 'mjo', title: 'MJO', sub: 'Madden-Julian (RMM)', ds: ['rmm', 'mjoFc2'] },
    { id: 'enso', title: 'ENSO', sub: 'El Niño / La Niña', ds: ['oni', 'nino'] },
    { id: 'monthly', title: 'EA · SCA · EA/WR', sub: 'Altri pattern (mensili)', ds: ['teleMonthly'] },
    { id: 'qbo', title: 'QBO', sub: 'Quasi-Biennale 30 hPa', ds: ['qbo'] },
    { id: 'iod', title: 'IOD', sub: 'Dipolo Oceano Indiano', ds: ['dmi'] },
    { id: 'aao', title: 'AAO', sub: 'Oscillazione Antartica', ds: ['teleDaily', 'fc_aao'] },
    { id: 'strat', title: 'Stratosfera', sub: 'Vortice polare · emisfero nord', ds: [] }
  ];
  const SUN_CARDS = [
    { id: 'kp', title: 'Kp', sub: 'Attività geomagnetica', ds: ['kp'] },
    { id: 'wind', title: 'Vento solare', sub: 'Velocità · densità · Bz', ds: ['wind'] },
    { id: 'xray', title: 'Raggi X', sub: 'Brillamenti (GOES)', ds: ['xray'] },
    { id: 'cycle', title: 'Ciclo solare', sub: 'Macchie (SSN) · F10.7', ds: ['cycle'] },
    { id: 'sunimg', title: 'Il Sole ora', sub: 'Immagini SDO / SOHO', ds: [] }
  ];
  const ALL_CARDS = TELE_CARDS.concat(SUN_CARDS);

  /* --- riepilogo di ogni card: {main, unit, color, line2, line3, stamp, spark:[{x,y}]} --- */
  function summary(card, d) {
    const id = card.id;
    if (['nao', 'ao', 'pna', 'aao'].includes(id)) {
      const td = d.teleDaily && d.teleDaily.data, s = td && td[id];
      if (!s || !s.length) return null;
      const l = last(s), wk = s[s.length - 8];
      const fc = d['fc_' + id] && d['fc_' + id].data;
      let fcTxt = '';
      if (fc && fc.gefs && fc.gefs.days.length) {
        const fd = fc.gefs.days.filter(x => x.x > l.x);
        const end = last(fd);
        if (end) fcTxt = 'Previsione GEFS a ' + Math.round((end.x - l.x) / DAY) + ' gg: ' + sgn(end.mean, f1);
      }
      const upd = updDate(d.teleDaily, l.x, 'tele_' + id);
      return { main: sgn(l.y), color: posNeg(l.y), line2: 'Aggiornato il ' + dDay(upd), line3: 'Valore del ' + dDay(l.x).slice(0, -5) + (fcTxt ? ' · ' + fcTxt.replace('Previsione GEFS a', 'GEFS') : ''), stamp: l.x, spark: s.slice(-60) };
    }
    if (id === 'vortex') {
      const w = d.wic && d.wic.data; if (!w) return null;
      const ssw = [w.sswGefs !== null ? 'GEFS ' + f0(w.sswGefs) + '%' : '', w.sswEcmwf !== null ? 'ECMWF ' + f0(w.sswEcmwf) + '%' : ''].filter(Boolean).join(' · ');
      return { main: (w.u10 !== null ? f1(w.u10) + ' m/s' : '—'), color: w.u10 !== null && w.u10 < 0 ? 'var(--neg)' : w.u10 !== null && w.u10 < 10 ? '#f08c00' : 'var(--acc)',
        line2: 'Probabilità SSW: ' + (ssw || '—'), line3: 'Vento a 10 hPa, 60°N (analisi GFS)', stamp: String(w.u10) + '|' + w.sswGefs + '|' + w.sswEcmwf };
    }
    if (id === 'nam') {
      const n = d.namDate && d.namDate.data; if (!n) return null;
      const dd = n.date;
      return { main: dd.slice(6, 8) + '/' + dd.slice(4, 6), color: 'var(--acc)', line2: 'Ultima corsa GFS e GEOS', line3: 'Grafici StratObserve', stamp: dd };
    }
    if (id === 'mjo') {
      const r = d.rmm && d.rmm.data; if (!r || !r.length) return null;
      const l = last(r);
      return { main: 'Fase ' + l.phase, color: l.amp >= 1 ? 'var(--acc)' : 'var(--mut)', line2: 'Aggiornato il ' + dDay(updDate(d.rmm, l.x, 'rmm')), line3: 'Ampiezza ' + f2(l.amp) + (l.amp >= 1 ? ' · attiva' : ' · debole') + ' · dato del ' + dDay(l.x).slice(0, -5), stamp: l.x, spark: r.slice(-60).map(p => ({ x: p.x, y: p.amp })) };
    }
    if (id === 'enso') {
      const o = d.oni && d.oni.data, n = d.nino && d.nino.data;
      if (!o || !o.length) return null;
      const l = last(o), w = n && last(n.n34);
      return { main: sgn(l.y, f1) + ' °C', color: posNeg(l.y), line2: 'ONI ' + l.seas + ' ' + l.year + ' · ' + D.ensoState(l.y), line3: w ? 'Niño 3.4 settimana ' + dDay(w.x) + ': ' + sgn(w.y, f1) : '', stamp: (w ? w.x : l.x), spark: n ? n.n34.slice(-52) : o.slice(-36) };
    }
    if (id === 'monthly') {
      const m = d.teleMonthly && d.teleMonthly.data; if (!m || !m.EA || !m.EA.length) return null;
      const l = last(m.EA);
      return { main: 'EA ' + sgn(l.y, f1), color: posNeg(l.y), line2: 'SCA ' + sgn(last(m.SCA).y, f1) + ' · EA/WR ' + sgn(last(m.EAWR).y, f1), line3: dMonth(l.x), stamp: l.x, spark: m.EA.slice(-24) };
    }
    if (id === 'qbo' || id === 'iod') {
      const s = d[id === 'qbo' ? 'qbo' : 'dmi']; const a = s && s.data; if (!a || !a.length) return null;
      const l = last(a);
      const ph = id === 'qbo' ? (l.y >= 0 ? 'fase occidentale (W)' : 'fase orientale (E)') : (l.y >= 0.4 ? 'IOD positivo' : l.y <= -0.4 ? 'IOD negativo' : 'neutro');
      return { main: sgn(l.y, f1) + (id === 'qbo' ? ' m/s' : ' °C'), color: posNeg(l.y), line2: ph, line3: dMonth(l.x), stamp: l.x, spark: a.slice(-48) };
    }
    if (id === 'kp') {
      const k = d.kp && d.kp.data; if (!k || !k.obs.length) return null;
      const l = last(k.obs);
      const fcMax = k.fc.filter(p => p.x > Date.now() && p.kind !== 'observed').reduce((a, p) => Math.max(a, p.y), 0);
      return { main: f1(l.y) + (D.gScale(l.y) ? ' ' + D.gScale(l.y) : ''), color: kpColor(l.y), line2: dHour(l.x), line3: fcMax ? 'Max previsto 3 gg: ' + f1(fcMax) + ' ' + D.gScale(fcMax) : '', stamp: l.x, spark: k.obs.slice(-24) };
    }
    if (id === 'wind') {
      const w = d.wind && d.wind.data; if (!w) return null;
      const p = last(w.plasma.filter(q => q.speed !== null)), m = last(w.mag.filter(q => q.bz !== null));
      if (!p) return null;
      return { main: f0(p.speed) + ' km/s', color: p.speed > 500 ? 'var(--pos)' : 'var(--fg)', line2: 'Densità ' + f1(p.density) + ' p/cm³' + (m ? ' · Bz ' + sgn(m.bz, f1) + ' nT' : ''), line3: dHour(p.x), stamp: p.x, spark: w.plasma.filter(q => q.speed !== null).map(q => ({ x: q.x, y: q.speed })) };
    }
    if (id === 'xray') {
      const x = d.xray && d.xray.data; if (!x || !x.length) return null;
      const l = last(x), mx = x.reduce((a, p) => (p.y > a.y ? p : a), x[0]);
      return { main: D.xrayClass(l.y), color: l.y >= 1e-5 ? 'var(--pos)' : 'var(--fg)', line2: 'Max 24 h: ' + D.xrayClass(mx.y) + ' alle ' + dHour(mx.x).split(' ').slice(2).join(' '), line3: dHour(l.x), stamp: l.x, spark: x.map(p => ({ x: p.x, y: Math.log10(p.y) })) };
    }
    if (id === 'cycle') {
      const c = d.cycle && d.cycle.data; if (!c || !c.obs.length) return null;
      const l = last(c.obs.filter(p => p.ssn !== null));
      return { main: f0(l.ssn) + ' SSN', color: 'var(--acc)', line2: 'F10.7 ' + f1(l.f107) + ' sfu · ' + dMonth(l.x), line3: c.f107d && c.f107d.length ? 'F10.7 di oggi: ' + f0(last(c.f107d).y) + ' sfu' : '', stamp: l.x, spark: c.obs.slice(-60).map(p => ({ x: p.x, y: p.ssn })) };
    }
    return null;
  }
  // data in cui la fonte ha pubblicato l'ultimo dato: cambia SOLO quando arriva un dato nuovo
  // (si ricorda quando l'ultimo valore è cambiato; il Last-Modified da solo non basta perché
  // alcuni file vengono riscritti ogni giorno anche senza dati nuovi)
  function updDate(c, key, name) {
    let t;
    if (key == null || !name) t = (c && c.lm) || (c && c.t) || Date.now();
    else {
      const rec = store.get('upd:' + name);
      if (rec && rec.k === key) t = rec.t;
      else {
        const lm = c && c.lm;
        if (rec) t = lm && lm >= key ? Math.min(lm, Date.now()) : Date.now(); // dato nuovo appena arrivato
        else t = lm && lm >= key ? Math.min(lm, key + 1.5 * DAY) : key + DAY; // prima apertura: stima prudente
        store.set('upd:' + name, { k: key, t });
      }
    }
    return t + 3600e3; // ora italiana circa, per non mostrare il giorno prima a mezzanotte UTC
  }
  function kpColor(k) { return k >= 7 ? '#ff4d4d' : k >= 5 ? '#ff9f43' : k >= 4 ? '#ffd43b' : '#51cf66'; }

  function sparkline(pts) {
    if (!pts || pts.length < 2) return '';
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y).filter(v => v !== null);
    const x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
    let y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys); if (y0 === y1) { y0 -= 1; y1 += 1; }
    const W = 120, Hh = 34;
    const d = pts.filter(p => p.y !== null).map((p, i) => (i ? 'L' : 'M') + ((p.x - x0) / (x1 - x0 || 1) * W).toFixed(1) + ',' + (Hh - (p.y - y0) / (y1 - y0) * Hh).toFixed(1)).join('');
    const z = y0 < 0 && y1 > 0 ? '<line x1="0" x2="' + W + '" y1="' + (Hh - (0 - y0) / (y1 - y0) * Hh).toFixed(1) + '" y2="' + (Hh - (0 - y0) / (y1 - y0) * Hh).toFixed(1) + '" class="zero"/>' : '';
    return '<svg class="spark" viewBox="0 0 ' + W + ' ' + Hh + '" preserveAspectRatio="none">' + z + '<path d="' + d + '"/></svg>';
  }

  function cardsData(card) { const o = {}; card.ds.forEach(id => { o[id] = cached(id); }); return o; }

  function renderGrid(cards) {
    const html = cards.map(card => {
      const d = cardsData(card);
      const s = summary(card, d);
      const errs = card.ds.map(id => d[id] && d[id].err).filter(Boolean);
      const anyData = card.ds.length === 0 || card.ds.some(id => d[id] && d[id].data);
      const nu = s && isNew(card.id, s.stamp);
      let body;
      if (card.id === 'strat') body = '<div class="l2">Temperatura, vento e flusso di calore — GEFS e GFS</div><img class="thumbw" src="https://www.cpc.ncep.noaa.gov/products/stratosphere/SSW/gif_files/GEFS_U_10mb_60N_' + (new Date().getUTCMonth() >= 6 ? new Date().getUTCFullYear() + '-' + (new Date().getUTCFullYear() + 1) : (new Date().getUTCFullYear() - 1) + '-' + new Date().getUTCFullYear()) + '.png?t=' + dayBust() + '" alt="">';
      else if (card.id === 'nam' && s) body = '<div class="big" style="color:' + s.color + '">' + s.main + '</div><div class="l2">' + s.line2 + '</div><img class="thumbw" src="' + namUrl(cardsData(card).namDate.data.date, 'gfs', 'namindex') + '" alt="">';
      else if (card.id === 'aam') body = '<div class="l2">Previsioni GEFS e CFSv2, GWO, profilo per latitudine</div><img class="thumbw" src="' + NIU + 'forecast/aam/gefsbc_aam_fcst_current.png?t=' + dayBust() + '" alt="">';
      else if (card.id === 'sunimg') body = '<img class="thumb" src="' + sunImg('hmi') + '" alt=""><img class="thumb" src="' + sunImg('aia193') + '" alt="">';
      else if (s) body = '<div class="big" style="color:' + s.color + '">' + s.main + '</div><div class="l2">' + s.line2 + '</div>' + (s.line3 ? '<div class="l3">' + s.line3 + '</div>' : '') + sparkline(s.spark);
      else if (!anyData && errs.length) body = '<div class="err">Fonte non raggiungibile<br><small>' + esc(errs[0]) + '</small></div>';
      else body = '<div class="l2 load">Caricamento…</div>';
      return '<button class="card" data-id="' + card.id + '">' + (nu ? '<span class="new">NUOVO</span>' : '') +
        '<div class="ct">' + card.title + '</div><div class="cs">' + card.sub + '</div>' + body +
        (errs.length && anyData ? '<div class="warn" title="' + esc(errs[0]) + '">⚠ dati in cache</div>' : '') + '</button>';
    }).join('');
    return '<div class="grid">' + html + '</div>';
  }

  function bindGrid() {
    app.querySelectorAll('.card').forEach(b => b.addEventListener('click', () => go('#/d/' + b.dataset.id)));
  }

  /* ================= pagine ================= */
  async function pageTele() {
    setNav('tele');
    const draw = () => { app.innerHTML = '<h2>Teleconnessioni e indici climatici</h2>' + renderGrid(TELE_CARDS) + footerTimes(TELE_CARDS); bindGrid(); };
    draw();
    await loadCards(TELE_CARDS, false, draw);
  }
  async function pageSun() {
    setNav('sun');
    const draw = () => { app.innerHTML = '<h2>Sole e meteo spaziale</h2>' + renderGrid(SUN_CARDS) + footerTimes(SUN_CARDS); bindGrid(); };
    draw();
    await loadCards(SUN_CARDS, false, draw);
  }
  function footerTimes(cards) {
    const ids = [...new Set([].concat.apply([], cards.map(c => c.ds)))];
    const ts = ids.map(id => (cached(id) || {}).t || 0).filter(Boolean);
    return '<p class="foot">Ultimo controllo: ' + (ts.length ? ago(Math.min.apply(null, ts)) : 'mai') + ' · tocca ⟳ per aggiornare</p>';
  }
  async function loadCards(cards, force, redraw) {
    const ids = [...new Set([].concat.apply([], cards.map(c => c.ds)))];
    // prima i dataset leggeri, poi le previsioni pesanti
    const light = ids.filter(id => !/^fc_/.test(id)), heavy = ids.filter(id => /^fc_/.test(id));
    const r0 = route;
    status('Aggiornamento…');
    await Promise.all(light.map(id => getDS(id, force).then(() => { if (route === r0) redraw(); })));
    for (const id of heavy) { await getDS(id, force); if (route === r0) redraw(); }
    status('');
  }

  /* ---------- dettaglio ---------- */
  async function pageDetail(id) {
    const card = ALL_CARDS.find(c => c.id === id);
    if (!card) return go('#/tele');
    setNav(SUN_CARDS.includes(card) ? 'sun' : 'tele');
    const r0 = route;
    const draw = () => {
      if (route !== r0) return;
      const d = cardsData(card);
      const s = summary(card, d);
      if (s) markSeen(card.id, s.stamp);
      app.innerHTML = '<div class="dhead"><button class="back" onclick="history.back()">‹</button><div><h2>' + card.title + '</h2><div class="cs">' + card.sub + '</div></div></div>' +
        '<div id="dbody"></div>' + '<div class="info">' + (INFO[id] || '') + '</div>' + sourcesBox(card, d);
      try {
        DETAIL[id] && DETAIL[id]($('#dbody'), d, s);
        const e = card.ds.map(x => d[x] && d[x].err).filter(Boolean)[0];
        const nd = $('#dbody .err');
        if (e && nd && /non disponibili/.test(nd.textContent)) nd.innerHTML += '<br><small>' + esc(e) + '</small>';
      } catch (e) { $('#dbody').innerHTML = '<div class="err">Errore nel disegno: ' + esc(e.message) + '</div>'; }
    };
    draw();
    if (card.ds.length) { status('Aggiornamento…'); await Promise.all(card.ds.map(x => getDS(x))); status(''); draw(); }
  }
  function sourcesBox(card, d) {
    const rows = card.ds.map(id => {
      const c = d[id] || {};
      const src = [].concat(DS[id].src)[0];
      return '<li><a href="' + src + '" target="_blank">' + esc(src.replace(/^https?:\/\//, '').slice(0, 60)) + '</a><br><small>scaricato ' + ago(c.t) + (c.err ? ' · <span class="errt">ultimo tentativo fallito: ' + esc(c.err) + '</span>' : '') + '</small></li>';
    }).join('');
    return rows ? '<div class="src"><b>Fonti</b><ul>' + rows + '</ul></div>' : '';
  }
  function box(title) { return '<div class="box"><div class="bt">' + title + '</div><div class="cbox"></div></div>'; }
  function boxes(el, titles) { el.insertAdjacentHTML('beforeend', titles.map(box).join('')); return Array.from(el.querySelectorAll('.cbox')).slice(-titles.length); }
  const kv = rows => '<table class="kv">' + rows.map(r => '<tr><td>' + r[0] + '</td><td>' + r[1] + '</td></tr>').join('') + '</table>';

  const NIU = 'https://atlas.niu.edu/';
  const FU = 'https://users.met.fu-berlin.de/~Aktuell/strat-www/wdiag/figs/ecmwf1/';
  const FU_STEPS = [['a12', 'Analisi (oggi 12 UTC)'], ['f24', '+1 giorno'], ['f48', '+2 giorni'], ['f72', '+3 giorni'], ['f96', '+4 giorni'], ['f120', '+5 giorni'], ['f144', '+6 giorni'], ['f168', '+7 giorni'], ['f192', '+8 giorni'], ['f216', '+9 giorni'], ['f240', '+10 giorni']];
  const NOAA_IMG = {
    nao: 'https://www.cpc.ncep.noaa.gov/products/precip/CWlink/pna/nao',
    pna: 'https://www.cpc.ncep.noaa.gov/products/precip/CWlink/pna/pna',
    ao: 'https://www.cpc.ncep.noaa.gov/products/precip/CWlink/daily_ao_index/ao',
    aao: 'https://www.cpc.ncep.noaa.gov/products/precip/CWlink/daily_ao_index/aao/aao'
  };
  function dailyIndexDetail(k) {
    return (el, d) => {
      const s = d.teleDaily && d.teleDaily.data && d.teleDaily.data[k];
      if (!s) { el.innerHTML = '<div class="err">Dati non disponibili</div>'; return; }
      const fc = d['fc_' + k] && d['fc_' + k].data;
      const l = last(s);
      const series = [
        { name: 'Osservato', type: 'line', color: FG(), data: s.slice(-90), width: 2 }
      ];
      let rows = [['Aggiornato il', dDay(updDate(d.teleDaily, l.x, 'tele_' + k))], ['Ultimo valore osservato', '<b style="color:' + posNeg(l.y) + '">' + sgn(l.y) + '</b> (' + dDay(l.x) + ')']];
      if (fc && fc.gefs) {
        const g = fc.gefs.days;
        series.unshift({ name: 'Spread GEFS', type: 'band', color: '#7aa2ff', data: g.map(p => ({ x: p.x, lo: p.min, hi: p.max })) });
        series.push({ name: 'Media GEFS', type: 'line', color: '#7aa2ff', data: g.map(p => ({ x: p.x, y: p.mean })), width: 2 });
        rows.push(['Corsa GEFS', fc.gefs.init ? dDay(fc.gefs.init) + ' (' + (g[0] ? g[0].n : '?') + ' membri)' : '—']);
      }
      if (fc && fc.gfs && fc.gfs.days.length) series.push({ name: 'GFS', type: 'line', color: '#ffa94d', dash: '4 3', data: fc.gfs.days.map(p => ({ x: p.x, y: p.mean })) });
      el.innerHTML = kv(rows);
      const K = k.toUpperCase(), b = NOAA_IMG[k];
      el.insertAdjacentHTML('beforeend', '<div class="box"><div class="bt">Grafico NOAA — osservato e previsione GEFS (tutti i membri)</div>' + extImg(b + '.gefs.sprd2.png', K + ' NOAA', K + '_NOAA_GEFS', null, dayBust()) + '</div>' +
        '<div class="box"><div class="bt">Grafico NOAA — media dell\'ensemble</div>' + extImg(b + '.gefs.fcst.png', K + ' NOAA media', K + '_NOAA_media', null, dayBust()) + '</div>');
      bindZoom(el);
      const [c1] = boxes(el, ['Ultimi 90 giorni e previsione (grafico dell\'app)']);
      C.draw(c1, { series, height: 230, vLine: l.x, hLines: [{ y: 1, color: '#555' }, { y: -1, color: '#555' }] });
      if (fc && fc.gefs && fc.gefs.days.length) {
        const fd = fc.gefs.days.filter(p => p.x > l.x);
        el.insertAdjacentHTML('beforeend', '<div class="box"><div class="bt">Previsione GEFS giorno per giorno</div><table class="tbl"><tr><th>Giorno</th><th>Media</th><th>Min</th><th>Max</th>' + (fc.gfs ? '<th>GFS</th>' : '') + '</tr>' +
          fd.map(p => { const gf = fc.gfs && fc.gfs.days.find(q => q.x === p.x); return '<tr><td>' + dDay(p.x).slice(0, -5) + '</td><td style="color:' + posNeg(p.mean) + '">' + sgn(p.mean) + '</td><td>' + f2(p.min) + '</td><td>' + f2(p.max) + '</td>' + (fc.gfs ? '<td>' + (gf ? f2(gf.mean) : '—') + '</td>' : '') + '</tr>'; }).join('') + '</table></div>');
      }
    };
  }

  const DETAIL = {
    nao: dailyIndexDetail('nao'), ao: dailyIndexDetail('ao'), pna: dailyIndexDetail('pna'), aao: dailyIndexDetail('aao'),
    mjo(el, d) {
      const r = d.rmm && d.rmm.data;
      const fc = d.mjoFc2 && d.mjoFc2.data;
      if (r && r.length) {
        const l = last(r);
        el.innerHTML = kv([['Aggiornato il', dDay(updDate(d.rmm, l.x, 'rmm'))], ['Ultimo dato osservato', dDay(l.x)], ['Fase', '<b>' + l.phase + '</b>'], ['Ampiezza', f2(l.amp) + (l.amp >= 1 ? ' (attiva)' : ' (debole)')], ['RMM1 / RMM2', f2(l.rmm1) + ' / ' + f2(l.rmm2)]]);
      } else el.innerHTML = '<div class="err">Osservazioni non disponibili' + (d.rmm && d.rmm.err ? '<br><small>' + esc(d.rmm.err) + '</small>' : '') + '</div>';
      const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const img = (u, name) => u ? extImg(u, 'Previsione ' + name, 'MJO_' + name, null, day)
        : '<div class="err">Previsione ' + name + ' non trovata' + (d.mjoFc2 && d.mjoFc2.err ? '<br><small>' + esc(d.mjoFc2.err) + '</small>' : '') + '</div>';
      el.insertAdjacentHTML('beforeend',
        '<div class="box"><div class="bt">Previsione GFS — ensemble GEFS (NCEP), 15 giorni</div>' + img(fc && fc.gefs, 'GFS') +
        '<p class="foot"><a target="_blank" href="https://www.cpc.ncep.noaa.gov/products/precip/CWlink/MJO/CLIVAR/ncpe.shtml">Apri la pagina NOAA ›</a> · Nero: ultimi 40 giorni osservati. Linee gialle: membri dell\'ensemble. Media: rosso giorni 1–7, blu 8–14, viola oltre.</p></div>' +
        '<div class="box"><div class="bt">Previsione ECMWF — ensemble (51 membri), 15 giorni</div>' + img(fc && fc.ecmf, 'ECMWF') +
        '<p class="foot"><a target="_blank" href="https://www.cpc.ncep.noaa.gov/products/precip/CWlink/MJO/CLIVAR/ecmf.shtml">Apri la pagina NOAA ›</a> · Stessa legenda. Fonte: NOAA CPC / MJO Task Force. Tocca un\'immagine per ingrandirla.</p></div>');
      bindZoom(el);
      if (r && r.length) {
        const [c1, c2] = boxes(el, ['Osservato — diagramma di fase ultimi 40 giorni', 'Ampiezza osservata — ultimi 180 giorni']);
        C.mjoDiagram(c1, r.slice(-40));
        c1.insertAdjacentHTML('beforeend', '<p class="foot">Cerchio giallo = inizio · punto rosso = ultimo giorno</p>');
        C.draw(c2, { series: [{ name: 'Ampiezza', type: 'line', color: '#7aa2ff', data: r.map(p => ({ x: p.x, y: p.amp })) }], hLines: [{ y: 1, color: '#888', label: 'soglia 1' }], height: 170 });
      }
    },
    enso(el, d) {
      const o = d.oni && d.oni.data, n = d.nino && d.nino.data;
      if (!o) { el.innerHTML = '<div class="err">Dati non disponibili</div>'; return; }
      const l = last(o);
      const rows = [['ONI ' + l.seas + ' ' + l.year, '<b style="color:' + posNeg(l.y) + '">' + sgn(l.y, f1) + ' °C</b> — ' + D.ensoState(l.y)]];
      if (n) ['n12', 'n3', 'n34', 'n4'].forEach(k => { const w = last(n[k]); if (w) rows.push([{ n12: 'Niño 1+2', n3: 'Niño 3', n34: 'Niño 3.4', n4: 'Niño 4' }[k] + ' (sett. ' + dDay(w.x) + ')', sgn(w.y, f1) + ' °C (SST ' + f1(w.sst) + ')']); });
      el.innerHTML = kv(rows);
      const [c1, c2] = boxes(el, ['ONI — ultimi 15 anni', 'Anomalie settimanali regioni Niño — ultimi 2 anni']);
      C.draw(c1, { series: [{ type: 'bar', data: o.slice(-180), colorFn: p => (p.y >= 0.5 ? '#ff6b6b' : p.y <= -0.5 ? '#4dabf7' : '#868e96') }], hLines: [{ y: 0.5, color: '#ff6b6b' }, { y: -0.5, color: '#4dabf7' }], height: 190 });
      if (n) C.draw(c2, { series: [
        { name: 'Niño 3.4', type: 'line', color: FG(), data: n.n34.slice(-104), width: 2.2 },
        { name: 'Niño 1+2', type: 'line', color: '#ffa94d', data: n.n12.slice(-104), width: 1 },
        { name: 'Niño 4', type: 'line', color: '#69db7c', data: n.n4.slice(-104), width: 1 }
      ], height: 200, unit: '°C' });
    },
    monthly(el, d) {
      const m = d.teleMonthly && d.teleMonthly.data; if (!m) { el.innerHTML = '<div class="err">Dati non disponibili</div>'; return; }
      const names = { NAO: 'NAO', EA: 'EA – Est Atlantico', SCA: 'SCA – Scandinavo', EAWR: 'EA/WR', WP: 'WP – Pacifico occ.', EPNP: 'EP/NP', PNA: 'PNA', TNH: 'TNH', POL: 'POL – Polare/Euroasiatico' };
      el.innerHTML = '<table class="tbl"><tr><th>Indice</th><th>' + dMonth(last(m.EA).x) + '</th><th>mese prec.</th></tr>' +
        D.TELE_M.map(k => { const a = m[k]; const l = last(a), p = a[a.length - 2]; return '<tr><td>' + names[k] + '</td><td style="color:' + posNeg(l.y) + '"><b>' + sgn(l.y) + '</b></td><td>' + (p ? sgn(p.y) : '—') + '</td></tr>'; }).join('') + '</table>';
      const order = ['EA', 'SCA', 'EAWR', 'NAO', 'POL', 'WP', 'EPNP', 'PNA', 'TNH'];
      const cs = boxes(el, order.map(k => names[k] + ' — ultimi 3 anni'));
      order.forEach((k, i) => C.draw(cs[i], { series: [{ type: 'bar', data: m[k].slice(-36), colorFn: p => (p.y >= 0 ? '#ff6b6b' : '#4dabf7') }], height: 130 }));
    },
    qbo(el, d) { monthlyBars(el, d.qbo && d.qbo.data, 'm/s', 'QBO 30 hPa — ultimi 15 anni'); },
    iod(el, d) { monthlyBars(el, d.dmi && d.dmi.data, '°C', 'DMI — ultimi 15 anni'); },
    nam(el, d) {
      const n = d.namDate && d.namDate.data;
      if (!n) { el.innerHTML = '<div class="err">Dati non disponibili</div>'; return; }
      const dd = n.date, nice = dd.slice(6, 8) + '/' + dd.slice(4, 6) + '/' + dd.slice(0, 4);
      const im = (m, diag, name) => extImg('https://stratobserve.com/plots/{D}/tseries/anoms/' + m + '_nh-' + diag + '_{D}.png', name, 'NAM_' + m.toUpperCase() + '_' + diag, dd);
      const DIAGS = [['u60', 'Vento zonale medio a 60°N e anomalie'], ['pcaptmp', 'Temperatura calotta polare 60–90°N — anomalie'], ['hgt-w1-60n', 'Onda 1 di geopotenziale a 60°N — anomalie'], ['hgt-w2-60n', 'Onda 2 di geopotenziale a 60°N — anomalie'], ['ehflx', 'Flusso di calore turbolento (eddy heat flux) — anomalie']];
      const model = store.get('namModel') || 'gfs';
      el.innerHTML = kv([['Corsa (inizializzazione)', '<b>' + nice + '</b>'], ['Emisfero', 'Nord (NH)']]) +
        '<div class="box"><div class="bt">NAM — GFS</div>' + im('gfs', 'namindex', 'NAM GFS') + '</div>' +
        '<div class="box"><div class="bt">NAM — GEOS (NASA)</div>' + im('geos', 'namindex', 'NAM GEOS') + '</div>' +
        '<div class="box"><div class="bt">Grafici collegati</div><div class="seg"><button data-m="gfs" class="' + (model === 'gfs' ? 'on' : '') + '">GFS</button><button data-m="geos" class="' + (model === 'geos' ? 'on' : '') + '">GEOS</button></div><div id="namx"></div></div>' +
        '<p class="foot">Tocca un grafico per vederlo a schermo intero (gira il telefono in orizzontale). Grafici di Z. D. Lawrence — <a target="_blank" href="https://stratobserve.com/anom_ts_diags">stratobserve.com</a>.</p>';
      const drawX = m => {
        $('#namx').innerHTML = DIAGS.map(x => '<div class="bt" style="margin-top:10px">' + x[1] + ' — ' + m.toUpperCase() + '</div>' + im(m, x[0], x[1])).join('');
        bindZoom(el);
      };
      el.querySelectorAll('.seg button').forEach(b => b.addEventListener('click', () => {
        store.set('namModel', b.dataset.m);
        el.querySelectorAll('.seg button').forEach(x => x.classList.toggle('on', x === b));
        drawX(b.dataset.m);
      }));
      drawX(model);
      bindZoom(el);
    },
    aam(el) {
      const b = dayBust();
      const box = (t, path, file, note) => '<div class="box"><div class="bt">' + t + '</div>' + extImg(NIU + path, t, file, null, b) + (note ? '<p class="foot">' + note + '</p>' : '') + '</div>';
      const per = store.get('aamDays') || '90';
      el.innerHTML =
        box('Previsione GLAAM — GEFS (corretta per il bias)', 'forecast/aam/gefsbc_aam_fcst_current.png', 'GLAAM_GEFS', 'Anomalia standardizzata del momento angolare atmosferico globale: osservato e previsione dei membri dell\'ensemble.') +
        box('Previsione GLAAM — CFSv2', 'forecast/aam/cfsv2_aam_fcst_current.png', 'GLAAM_CFSv2') +
        box('Previsione GWO — GEFS (diagramma di fase)', 'forecast/aam/gefsbc_gwo_fcst_current.png', 'GWO_GEFS') +
        box('Previsione GWO — membri CFSv2', 'forecast/aam/GWO_members_current.png', 'GWO_CFSv2') +
        box('AAM relativo per latitudine — oggi rispetto al clima', 'analysis/aam/aam_profile_current.png', 'AAM_profilo') +
        box('AAM per latitudine — anomalia standardizzata', 'analysis/aam/aam_stdanom_current.png', 'AAM_anomalia') +
        '<div class="box"><div class="bt">Andamento osservato del momento angolare</div><div class="seg">' +
        ['30', '90', '180', '365'].map(n => '<button data-n="' + n + '" class="' + (per === n ? 'on' : '') + '">' + n + ' gg</button>').join('') +
        '</div><div id="aamh">' + extImg(NIU + 'analysis/aam/MR-latest-' + per + 'days.png', 'AAM ' + per + ' giorni', 'AAM_' + per + 'gg', null, b) + '</div></div>' +
        '<p class="foot">Grafici della Northern Illinois University (Dr. Victor Gensini) — <a target="_blank" href="https://atlas.niu.edu/gwo/">atlas.niu.edu/gwo</a>. Tocca un grafico per ingrandirlo.</p>';
      el.querySelectorAll('.seg button').forEach(btn => btn.addEventListener('click', () => {
        store.set('aamDays', btn.dataset.n);
        el.querySelectorAll('.seg button').forEach(x => x.classList.toggle('on', x === btn));
        $('#aamh').innerHTML = extImg(NIU + 'analysis/aam/MR-latest-' + btn.dataset.n + 'days.png', 'AAM ' + btn.dataset.n + ' giorni', 'AAM_' + btn.dataset.n + 'gg', null, dayBust());
        bindZoom(el);
      }));
      bindZoom(el);
    },
    vortex(el, d) {
      const w = d.wic && d.wic.data;
      const rows = [];
      if (w) {
        if (w.u10 !== null) rows.push(['Vento a 10 hPa, 60°N oggi (analisi GFS)', '<b>' + f1(w.u10) + ' m/s</b>']);
        if (w.sswGefs !== null) rows.push(['Probabilità SSW — GEFS', '<b>' + f0(w.sswGefs) + '%</b>']);
        if (w.sswEcmwf !== null) rows.push(['Probabilità SSW — ECMWF (ensemble)', '<b>' + f0(w.sswEcmwf) + '%</b>']);
        if (w.weakest) rows.push(['Più debole per questa data (ERA5 1979–2025)', f1(w.weakest.v) + ' m/s (' + w.weakest.y + ')']);
        if (w.strongest) rows.push(['Più forte per questa data (ERA5 1979–2025)', f1(w.strongest.v) + ' m/s (' + w.strongest.y + ')']);
      }
      const b = dayBust();
      el.innerHTML = (rows.length ? kv(rows) : '<div class="err">Riepilogo non disponibile' + (d.wic && d.wic.err ? '<br><small>' + esc(d.wic.err) + '</small>' : '') + '</div>') +
        (w && w.status ? '<p class="foot">Dal sito (in inglese): <i>' + esc(w.status) + '</i></p>' : '') +
        '<div class="box"><div class="bt">Vento zonale a 10 hPa e 60°N — GEFS ed ECMWF rispetto al clima ERA5</div>' + extImg('https://weatheriscool.com/media/u10serie_link_img.png', 'Vento 10 hPa 60N', 'Vortice_u10_60N', null, b) +
        '<p class="foot">Nero: media ERA5 · grigio: variabilità storica · azzurro: analisi · verde: membri GEFS · blu: membri ECMWF. Sotto lo zero il vento si inverte (SSW).</p></div>' +
        '<div class="box"><div class="bt">Sezioni verticali del vento zonale a 60°N (GFS): valore e anomalia</div>' + extImg('https://weatheriscool.com/media/ucross_link_img.png', 'Sezioni vento 60N', 'Vortice_sezioni_60N', null, b) + '</div>' +
        '<p class="foot">Grafici di <a target="_blank" href="https://weatheriscool.com/">weatheriscool.com</a>. Tocca un grafico per ingrandirlo.</p>';
      bindZoom(el);
    },
    strat(el) {
      // grafici CPC/NOAA dell'emisfero nord: analisi + previsione a 16 giorni
      const B = 'https://www.cpc.ncep.noaa.gov/products/stratosphere/SSW/gif_files/';
      const now = new Date(), y = now.getUTCFullYear();
      const season = now.getUTCMonth() >= 6 ? y + '-' + (y + 1) : (y - 1) + '-' + y;
      const prevSeason = now.getUTCMonth() >= 6 ? (y - 1) + '-' + y : (y - 2) + '-' + (y - 1);
      const b = dayBust();
      const VARS = [['T', '6090N', 'Temperatura media 60–90°N (calotta polare)'], ['U', '60N', 'Vento zonale medio a 60°N'], ['vT', '4575N', 'Flusso di calore v\'T\' 45–75°N (onde verso la stratosfera)']];
      const img = (pre, v, lev) => {
        const name = pre + v[0] + '_' + lev + 'mb_' + v[1] + '_';
        // se la stagione nuova non è ancora pubblicata, l'app prova quella precedente
        return '<div class="bt" style="margin-top:10px">' + v[2] + ' — ' + lev + ' hPa</div>' +
          '<div class="imgwrap"><img class="sun zimg" loading="lazy" src="' + B + name + season + '.png?t=' + b + '" data-alt="' + B + name + prevSeason + '.png" alt="" ' +
          'onerror="if(this.dataset.alt){this.src=this.dataset.alt;this.dataset.alt=\'\';}else{this.parentNode.replaceWith(Object.assign(document.createElement(\'div\'),{className:\'err\',textContent:\'Grafico non disponibile\'}))}">' +
          '<button class="dl" data-file="Strat_' + pre + v[0] + '_' + lev + 'hPa" onclick="__download(this)">⬇ Scarica grafico</button></div>';
      };
      const lvG = store.get('stratGefs') || '10', lvF = store.get('stratGfs') || '10';
      el.innerHTML =
        '<div class="box"><div class="bt">GEFS (ensemble) — analisi e previsione a 16 giorni</div>' +
        '<div class="seg" id="sg1">' + ['10', '50', '100'].map(l => '<button data-l="' + l + '" class="' + (l === lvG ? 'on' : '') + '">' + l + ' hPa</button>').join('') + '</div><div id="stg1"></div></div>' +
        '<div class="box"><div class="bt">GFS (deterministico) — analisi e previsione a 16 giorni</div>' +
        '<div class="seg" id="sg2">' + ['2', '5', '10', '30', '50', '70', '100'].map(l => '<button data-l="' + l + '" class="' + (l === lvF ? 'on' : '') + '">' + l + '</button>').join('') + '</div><div id="stg2"></div></div>' +
        '<div class="box"><div class="bt">Università di Berlino — ECMWF, analisi e previsione fino a 10 giorni</div>' +
        '<label class="row">Giorno <select id="fuStep">' + FU_STEPS.map(x => '<option value="' + x[0] + '"' + ((store.get('fuStep') || 'a12') === x[0] ? ' selected' : '') + '>' + x[1] + '</option>').join('') + '</select></label>' +
        '<div class="bt" style="margin-top:8px">Mappe: geopotenziale e temperatura</div><div class="seg" id="fuL">' + ['100', '50', '30', '10', '5', '1'].map(l => '<button data-l="' + l + '" class="' + ((store.get('fuLev') || '10') === l ? 'on' : '') + '">' + l + '</button>').join('') + '</div><div id="fuMap"></div>' +
        '<div class="bt" style="margin-top:12px">Mappe: vorticità potenziale (livelli isentropici)</div><div class="seg" id="fuP">' + ['380', '475', '600', '850'].map(l => '<button data-l="' + l + '" class="' + ((store.get('fuPv') || '850') === l ? 'on' : '') + '">' + l + ' K</button>').join('') + '</div><div id="fuPv"></div>' +
        '<div class="bt" style="margin-top:12px">Sezioni medie zonali</div><div class="seg" id="fuZ">' + [['t', 'Temperatura'], ['u', 'Vento'], ['vt', 'Calore'], ['EP', 'Flusso EP']].map(z => '<button data-z="' + z[0] + '" class="' + ((store.get('fuZm') || 'u') === z[0] ? 'on' : '') + '">' + z[1] + '</button>').join('') + '</div><div id="fuZm"></div>' +
        '<div class="bt" style="margin-top:12px">Serie della stagione 2026/27</div>' + extImg(FU + 'temp_wind.png', 'Berlino serie temperatura e vento', 'Berlino_serie_T_vento', null, b) + extImg(FU + 'fluxes.png', 'Berlino serie flussi', 'Berlino_serie_flussi', null, b) +
        '<p class="foot">Grafici: Freie Universität Berlin, dati ECMWF via DWD.</p></div>' +
        '<p class="foot">Grafici NOAA CPC e Università di Berlino (emisfero nord). Tocca un grafico per ingrandirlo. Altri approfondimenti:</p>' +
        '<div class="links">' + [
          ['CPC – Monitoraggio SSW (pagina originale)', 'https://www.cpc.ncep.noaa.gov/products/stratosphere/SSW/'],
          ['NASA Ozone Watch – Meteorologia polare', 'https://ozonewatch.gsfc.nasa.gov/meteorology/'],
          ['Università di Berlino – Diagnostica invernale (pagina originale)', 'https://users.met.fu-berlin.de/~Aktuell/strat-www/wdiag/wdiag.php?lng=eng']
        ].map(l => '<a class="lnk" target="_blank" href="' + l[1] + '">' + l[0] + ' ›</a>').join('') + '</div>';
      const drawG = l => { $('#stg1').innerHTML = VARS.map(v => img('GEFS_', v, l)).join(''); bindZoom(el); };
      const drawF = l => { $('#stg2').innerHTML = VARS.map(v => img('', v, l)).join(''); bindZoom(el); };
      el.querySelectorAll('#sg1 button').forEach(x => x.addEventListener('click', () => { store.set('stratGefs', x.dataset.l); el.querySelectorAll('#sg1 button').forEach(y => y.classList.toggle('on', y === x)); drawG(x.dataset.l); }));
      el.querySelectorAll('#sg2 button').forEach(x => x.addEventListener('click', () => { store.set('stratGfs', x.dataset.l); el.querySelectorAll('#sg2 button').forEach(y => y.classList.toggle('on', y === x)); drawF(x.dataset.l); }));
      drawG(lvG); drawF(lvF);
      const step = () => $('#fuStep').value;
      const fuMap = () => { $('#fuMap').innerHTML = extImg(FU + 'ecmwf' + (store.get('fuLev') || '10') + step() + '.png', 'Mappa Berlino', 'Berlino_' + (store.get('fuLev') || '10') + 'hPa_' + step(), null, b); bindZoom(el); };
      const fuPv = () => { $('#fuPv').innerHTML = extImg(FU + 'ecmwfpv' + (store.get('fuPv') || '850') + step() + '.png', 'Vorticità potenziale', 'Berlino_PV' + (store.get('fuPv') || '850') + 'K_' + step(), null, b); bindZoom(el); };
      const fuZm = () => { $('#fuZm').innerHTML = extImg(FU + 'ecmwfzm_' + (store.get('fuZm') || 'u') + '_' + step() + '.png', 'Sezione zonale', 'Berlino_zonale_' + (store.get('fuZm') || 'u') + '_' + step(), null, b); bindZoom(el); };
      const seg = (id, key, attr, fn) => el.querySelectorAll('#' + id + ' button').forEach(x => x.addEventListener('click', () => { store.set(key, x.dataset[attr]); el.querySelectorAll('#' + id + ' button').forEach(y => y.classList.toggle('on', y === x)); fn(); }));
      seg('fuL', 'fuLev', 'l', fuMap); seg('fuP', 'fuPv', 'l', fuPv); seg('fuZ', 'fuZm', 'z', fuZm);
      $('#fuStep').addEventListener('change', () => { store.set('fuStep', step()); fuMap(); fuPv(); fuZm(); });
      fuMap(); fuPv(); fuZm();
    },
    kp(el, d) {
      const k = d.kp && d.kp.data; if (!k) { el.innerHTML = '<div class="err">Dati non disponibili</div>'; return; }
      const l = last(k.obs);
      const fcOnly = k.fc.filter(p => p.x > l.x);
      el.innerHTML = kv([['Ultimo Kp', '<b style="color:' + kpColor(l.y) + '">' + f2(l.y) + '</b> ' + D.gScale(l.y) + ' — ' + dHour(l.x)], ['Massimo ultime 24 h', f2(Math.max.apply(null, k.obs.filter(p => p.x > l.x - DAY).map(p => p.y)))]]);
      const [c1] = boxes(el, ['Kp osservato e previsto (barre chiare = previsione)']);
      C.draw(c1, { series: [{ type: 'bar', data: k.obs.slice(-56).concat(fcOnly.map(p => Object.assign({ fc: true }, p))), colorFn: p => p.fc ? kpColor(p.y) + '88' : kpColor(p.y) }], yMin: 0, yMax: 9, hLines: [{ y: 5, color: '#ff9f43', label: 'G1' }], height: 200, vLine: Date.now() });
    },
    wind(el, d) {
      const w = d.wind && d.wind.data; if (!w) { el.innerHTML = '<div class="err">Dati non disponibili</div>'; return; }
      const [c1, c2, c3] = boxes(el, ['Velocità (km/s) — 24 h', 'Densità (p/cm³)', 'Campo magnetico Bz e Bt (nT)']);
      C.draw(c1, { series: [{ type: 'line', color: '#ffa94d', data: w.plasma.map(p => ({ x: p.x, y: p.speed })) }], zero: false, height: 150 });
      C.draw(c2, { series: [{ type: 'line', color: '#69db7c', data: w.plasma.map(p => ({ x: p.x, y: p.density })) }], height: 130 });
      C.draw(c3, { series: [{ name: 'Bt', type: 'line', color: '#adb5bd', data: w.mag.map(p => ({ x: p.x, y: p.bt })) }, { name: 'Bz', type: 'line', color: '#ff6b6b', data: w.mag.map(p => ({ x: p.x, y: p.bz })) }], height: 160 });
    },
    xray(el, d) {
      const x = d.xray && d.xray.data; if (!x) { el.innerHTML = '<div class="err">Dati non disponibili</div>'; return; }
      const [c1] = boxes(el, ['Flusso X 0,1–0,8 nm (W/m²) — 24 h']);
      C.draw(c1, { series: [{ type: 'line', color: '#ffd43b', data: x }], log: true, yMin: 1e-9, yMax: 1e-3,
        logLabel: v => ({ 1e-8: 'A', 1e-7: 'B', 1e-6: 'C', 1e-5: 'M', 1e-4: 'X' }[Number(v.toPrecision(1))] || ''),
        hLines: [{ y: 1e-5, color: '#ff9f43', label: 'M' }, { y: 1e-4, color: '#ff4d4d', label: 'X' }], height: 200, tipFmt: v => D.xrayClass(v) });
    },
    cycle(el, d) {
      const c = d.cycle && d.cycle.data; if (!c) { el.innerHTML = '<div class="err">Dati non disponibili</div>'; return; }
      const [c1, c2, c3] = boxes(el, ['Macchie solari mensili (SSN) e previsione', 'Flusso F10.7 mensile e previsione (sfu)', 'F10.7 giornaliero (sfu)']);
      const pr = c.pred.filter(p => p.x < Date.UTC(2040, 0, 1));
      C.draw(c1, { series: [
        { name: 'Prev. min–max', type: 'band', color: '#7aa2ff', data: pr.filter(p => p.lo !== null).map(p => ({ x: p.x, lo: p.lo, hi: p.hi })) },
        { name: 'Mensile', type: 'line', color: '#ffd43b', width: 1, data: c.obs.map(p => ({ x: p.x, y: p.ssn })) },
        { name: 'Smussato', type: 'line', color: '#ff922b', width: 2.2, data: c.obs.map(p => ({ x: p.x, y: p.ssnS })) },
        { name: 'Previsione', type: 'line', color: '#7aa2ff', dash: '4 3', data: pr.map(p => ({ x: p.x, y: p.ssn })) }
      ], height: 220, yMin: 0 });
      C.draw(c2, { series: [
        { name: 'Mensile', type: 'line', color: '#ffd43b', width: 1, data: c.obs.map(p => ({ x: p.x, y: p.f107 })) },
        { name: 'Smussato', type: 'line', color: '#ff922b', width: 2.2, data: c.obs.map(p => ({ x: p.x, y: p.f107S })) },
        { name: 'Previsione', type: 'line', color: '#7aa2ff', dash: '4 3', data: pr.map(p => ({ x: p.x, y: p.f107 })) }
      ], height: 190, zero: false });
      C.draw(c3, { series: [{ type: 'line', color: '#ffd43b', data: c.f107d || [] }], height: 150, zero: false });
    },
    sunimg(el) {
      const im = [['hmi', 'Fotosfera (SDO/HMI) — macchie solari'], ['aia193', 'Corona 193 Å (SDO/AIA) — buchi coronali'], ['aia304', 'Cromosfera 304 Å (SDO/AIA) — protuberanze'], ['lasco', 'Coronografo LASCO C3 (SOHO) — CME']];
      el.innerHTML = im.map(i => '<div class="box"><div class="bt">' + i[1] + '</div>' + extImg(sunImg(i[0]), i[1], 'Sole_' + i[0]) + '</div>').join('');
      bindZoom(el);
    }
  };
  function monthlyBars(el, a, unit, title) {
    if (!a) { el.innerHTML = '<div class="err">Dati non disponibili</div>'; return; }
    const l = last(a);
    el.innerHTML = kv([['Ultimo mese', dMonth(l.x)], ['Valore', '<b style="color:' + posNeg(l.y) + '">' + sgn(l.y, f1) + ' ' + unit + '</b>']]);
    const [c1] = boxes(el, [title]);
    C.draw(c1, { series: [{ type: 'bar', data: a.slice(-180), colorFn: p => (p.y >= 0 ? '#ff6b6b' : '#4dabf7') }], height: 190, unit });
  }
  function sunImg(k) {
    const bust = '?t=' + Math.floor(Date.now() / (30 * 60e3));
    return {
      hmi: 'https://sdo.gsfc.nasa.gov/assets/img/latest/latest_512_HMIIF.jpg',
      aia193: 'https://sdo.gsfc.nasa.gov/assets/img/latest/latest_512_0193.jpg',
      aia304: 'https://sdo.gsfc.nasa.gov/assets/img/latest/latest_512_0304.jpg',
      lasco: 'https://soho.nascom.nasa.gov/data/realtime/c3/512/latest.jpg'
    }[k] + bust;
  }

  /* ================= instabilità ================= */
  function getLoc() { return store.get('loc') || { name: 'Roma', lat: 41.9, lon: 12.5 }; }
  function getModel() { return store.get('model') || 'best_match'; }

  async function pageConv(force) {
    setNav('conv');
    const r0 = route;
    const loc = getLoc(), model = getModel();
    app.innerHTML = '<h2>Instabilità e temporali</h2>' +
      '<div class="locbar"><button id="locbtn" class="pill">📍 ' + esc(loc.name) + '</button>' +
      '<select id="model">' + I.MODELS.map(m => '<option value="' + m[0] + '"' + (m[0] === model ? ' selected' : '') + '>' + m[1] + '</option>').join('') + '</select></div>' +
      '<div id="locpanel" class="hidden"><div class="row"><input id="q" placeholder="Cerca città o località…"><button id="gps" class="pill">GPS</button></div><div id="res"></div></div>' +
      '<div id="conv"><div class="l2 load">Caricamento previsione…</div></div>' +
      '<div class="box"><div class="bt">Panoramica Italia — prossimi 3 giorni</div><div id="ita"><div class="l2 load">Caricamento…</div></div></div>' +
      '<div class="info">' + CONV_INFO + '</div>';
    $('#locbtn').onclick = () => $('#locpanel').classList.toggle('hidden');
    $('#model').onchange = e => { store.set('model', e.target.value); pageConv(true); };
    let tmo;
    $('#q').oninput = e => { clearTimeout(tmo); const q = e.target.value.trim(); if (q.length < 2) return; tmo = setTimeout(() => searchLoc(q), 400); };
    $('#gps').onclick = () => {
      if (!navigator.geolocation) return alert('GPS non disponibile');
      $('#res').innerHTML = '<div class="l2">Rilevo la posizione…</div>';
      navigator.geolocation.getCurrentPosition(p => {
        setLoc({ name: 'Posizione GPS (' + p.coords.latitude.toFixed(2) + ', ' + p.coords.longitude.toFixed(2) + ')', lat: +p.coords.latitude.toFixed(3), lon: +p.coords.longitude.toFixed(3) });
      }, err => { $('#res').innerHTML = '<div class="err">Posizione non disponibile: ' + esc(err.message) + '</div>'; }, { timeout: 15000, maximumAge: 600000 });
    };

    const key = 'om:' + model + ':' + loc.lat + ',' + loc.lon;
    let om = store.get(key);
    if (om) drawConv(om);
    if (force || !om || Date.now() - om.t > H) {
      status('Scarico la previsione…');
      try {
        const j = await fetchJson(I.forecastUrl(loc.lat, loc.lon, model, 7));
        if (j.error) throw new Error(j.reason || 'errore Open-Meteo');
        om = { t: Date.now(), data: I.process(j) };
        store.set(key, om);
      } catch (e) {
        if (!om && route === r0) $('#conv').innerHTML = '<div class="err">Previsione non disponibile: ' + esc(e.message) + '</div>';
      }
      status('');
      if (om && route === r0) drawConv(om);
    }
    const ikey = 'ita:' + model;
    let it = store.get(ikey);
    if (it && route === r0) drawItaly(it);
    if (force || !it || Date.now() - it.t > 2 * H) {
      try { const j = await fetchJson(I.italyUrl(model)); it = { t: Date.now(), data: I.italySummary(j) }; store.set(ikey, it); }
      catch (e) { if (!it && route === r0) $('#ita').innerHTML = '<div class="err">Non disponibile: ' + esc(e.message) + '</div>'; }
      if (it && route === r0) drawItaly(it);
    }
  }
  async function searchLoc(q) {
    try {
      const j = await fetchJson(I.geocodeUrl(q));
      const r = j.results || [];
      $('#res').innerHTML = r.length ? r.map((x, i) => '<button class="resitem" data-i="' + i + '">' + esc(x.name) + ' <small>' + esc([x.admin2, x.admin1, x.country].filter(Boolean).join(', ')) + '</small></button>').join('') : '<div class="l2">Nessun risultato</div>';
      $('#res').querySelectorAll('.resitem').forEach(b => b.onclick = () => { const x = r[+b.dataset.i]; setLoc({ name: x.name, lat: +x.latitude.toFixed(3), lon: +x.longitude.toFixed(3) }); });
    } catch (e) { $('#res').innerHTML = '<div class="err">Ricerca non riuscita</div>'; }
  }
  function setLoc(l) { store.set('loc', l); pageConv(true); }

  const RISK_COL = ['#495057', '#2f9e44', '#f08c00', '#e8590c', '#c92a2a'];
  function drawConv(om) {
    const el = $('#conv'); if (!el) return;
    const { rows, offset } = om.data;
    const nowL = Date.now() + (offset || 0);
    const days = I.dailySummary(rows, 0);
    const GG = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];
    const cur = rows.reduce((a, r) => (Math.abs(r.x - nowL) < Math.abs(a.x - nowL) ? r : a), rows[0]);
    el.innerHTML =
      '<div class="days">' + days.map(d => { const dt = new Date(d.day); return '<div class="day" style="border-color:' + RISK_COL[d.risk.lvl] + '"><div class="dn">' + GG[dt.getUTCDay()] + ' ' + dt.getUTCDate() + '</div><div class="dr" style="background:' + RISK_COL[d.risk.lvl] + '">' + d.risk.txt + '</div><div class="dv">CAPE ' + f0(d.cape) + '</div><div class="dv">LI ' + f1(d.li) + '</div><div class="dv">K ' + f0(d.k) + '</div></div>'; }).join('') + '</div>' +
      '<p class="foot">Rischio temporali indicativo, combinando CAPE, LI, K e shear. Scaricato ' + ago(om.t) + (om.data.elevation !== undefined ? ' · quota modello ' + f0(om.data.elevation) + ' m' : '') + '</p>' +
      kv([
        ['Ora (' + String(new Date(cur.x).getUTCHours()).padStart(2, '0') + ':00)', '<b>' + cur.risk.txt + '</b>'],
        ['CAPE', f0(cur.cape) + ' J/kg'], ['CIN', f0(cur.cin) + ' J/kg'], ['Lifted Index', f1(cur.li) + ' <small>(' + cur.liSrc + ')</small>'],
        ['Showalter', f1(cur.si)], ['K-Index', f1(cur.k)], ['Total Totals', f1(cur.tt)],
        ['Shear 10 m–500 hPa', f1(cur.shear) + ' m/s'], ['Zero termico', f0(cur.frz) + ' m'], ['T 850 / 500 hPa', f1(cur.t850) + ' / ' + f1(cur.t500) + ' °C']
      ]);
    const xs = r => r.x;
    const P = (k) => rows.map(r => ({ x: xs(r), y: r[k] }));
    const cs = boxes(el, ['CAPE e CIN (J/kg)', 'Lifted Index e Showalter (°C) — negativo = instabile', 'K-Index e Total Totals', 'Shear 10 m–500 hPa (m/s)', 'Zero termico (m) e precipitazione (mm/h)']);
    const o = { vLine: nowL, height: 170 };
    C.draw(cs[0], Object.assign({ series: [{ name: 'CAPE', type: 'line', color: '#ff922b', data: P('cape'), width: 2 }, { name: 'CIN', type: 'line', color: '#748ffc', data: P('cin') }], hLines: [{ y: 1000, color: '#e8590c', label: '1000' }] }, o));
    C.draw(cs[1], Object.assign({ series: [{ name: 'LI', type: 'line', color: '#ff6b6b', data: P('li'), width: 2 }, { name: 'Showalter', type: 'line', color: '#ffd43b', data: P('si') }], hLines: [{ y: -3, color: '#e8590c', label: '−3' }] }, o));
    C.draw(cs[2], Object.assign({ series: [{ name: 'K', type: 'line', color: '#69db7c', data: P('k'), width: 2 }, { name: 'TT', type: 'line', color: '#da77f2', data: P('tt') }], hLines: [{ y: 30, color: '#2f9e44', label: 'K 30' }, { y: 50, color: '#ae3ec9', label: 'TT 50' }], zero: false }, o));
    C.draw(cs[3], Object.assign({ series: [{ type: 'line', color: '#4dabf7', data: P('shear'), width: 2 }], hLines: [{ y: 20, color: '#e8590c', label: '20' }, { y: 10, color: '#888', label: '10' }], yMin: 0 }, o));
    C.draw(cs[4], Object.assign({ series: [{ name: 'Zero termico', type: 'line', color: '#adb5bd', data: P('frz'), width: 2 }] }, o));
    const pb = document.createElement('div'); pb.className = 'cbox'; cs[4].parentNode.appendChild(pb);
    C.draw(pb, Object.assign({ series: [{ type: 'bar', color: '#4dabf7', data: P('prec') }], yMin: 0 }, o, { height: 110 }));
  }
  function drawItaly(it) {
    const el = $('#ita'); if (!el) return;
    const rows = it.data;
    if (!rows.length) { el.innerHTML = '<div class="err">Nessun dato</div>'; return; }
    const ds = rows[0].days.map(d => d.d);
    el.innerHTML = '<table class="tbl ita"><tr><th>Città</th>' + ds.map(d => '<th>' + d.slice(8) + '/' + d.slice(5, 7) + '</th>').join('') + '</tr>' +
      rows.map(r => '<tr><td>' + r.name + '</td>' + r.days.map(d => '<td><span class="chip" style="background:' + RISK_COL[d.risk.lvl] + '">' + f0(d.cape) + '</span><small> ' + f1(d.li) + '</small></td>').join('') + '</tr>').join('') +
      '</table><p class="foot">Per ogni giorno: CAPE massimo (J/kg, colore = rischio) e Lifted Index minimo. Aggiornato ' + ago(it.t) + '.</p>';
  }
  const CONV_INFO =
    '<b>Come leggere gli indici</b><br>' +
    '<b>CAPE</b> (energia disponibile per la convezione): &lt;300 debole · 300–1000 moderata · 1000–2500 forte · &gt;2500 estrema.<br>' +
    '<b>CIN</b>: energia che "frena" la convezione; più è negativa, più serve un innesco (fronte, rilievi, riscaldamento).<br>' +
    '<b>Lifted Index</b>: &gt;0 stabile · 0/−3 debolmente instabile · −3/−6 instabile · &lt;−6 molto instabile.<br>' +
    '<b>Showalter</b>: come il LI ma con particella da 850 hPa. &lt;0 temporali possibili · &lt;−3 forti · &lt;−6 severi.<br>' +
    '<b>K-Index</b>: &lt;20 assenti · 20–25 isolati · 26–30 sparsi · 31–35 diffusi · &gt;35 molto diffusi (ottimo per temporali di massa d\'aria).<br>' +
    '<b>Total Totals</b>: &lt;44 improbabili · 44–50 possibili · 50–55 probabili, anche forti · &gt;55 severi.<br>' +
    '<b>Shear</b> (differenza di vento tra suolo e 500 hPa): &gt;10 m/s temporali organizzati · &gt;20 m/s con CAPE elevato possibili supercelle.<br>' +
    'CAPE, CIN, LI e zero termico vengono dal modello; K, TT, Showalter e shear sono calcolati dall\'app dai dati del modello. Se il modello non fornisce il LI, l\'app lo calcola dal suolo. Dati modello: Open-Meteo.com (CC BY 4.0).';

  /* ================= impostazioni ================= */
  const NOTIF = [
    ['tele', 'NAO / AO / PNA giornalieri (un\'unica notifica)'], ['mjo', 'MJO'],
    ['enso', 'ENSO (ONI e settimanale)'], ['mensili', 'Pattern mensili (EA, SCA…)'], ['qbo', 'QBO'],
    ['sole', 'Ciclo solare mensile'], ['kp', 'Allerta tempesta geomagnetica (Kp ≥ 5)']
  ];
  function getPrefs() {
    let p = null;
    try { if (window.Android && Android.getPrefs) p = JSON.parse(Android.getPrefs() || 'null'); } catch (e) { /* */ }
    p = p || store.get('prefs') || {};
    if (!p.notif) p.notif = { tele: true, gefs: false, mjo: true, enso: true, mensili: true, qbo: false, sole: false, kp: true };
    if (p.enabled === undefined) p.enabled = false;
    if (!p.intervalMin) p.intervalMin = 30;
    return p;
  }
  function savePrefs(p) { store.set('prefs', p); if (window.Android && Android.setPrefs) Android.setPrefs(JSON.stringify(p)); }

  function pageSet() {
    setNav('set');
    const p = getPrefs();
    app.innerHTML = '<h2>Impostazioni</h2>' +
      '<div class="box"><div class="bt">Notifiche di aggiornamento</div>' +
      (IS_APP ? '' : '<p class="foot">Le notifiche funzionano solo nell\'app Android installata.</p>') +
      '<label class="sw"><input type="checkbox" id="en"' + (p.enabled ? ' checked' : '') + '> Avvisami quando escono nuovi dati</label>' +
      '<div id="nlist" class="' + (p.enabled ? '' : 'dim') + '">' + NOTIF.map(n => '<label class="sw"><input type="checkbox" data-k="' + n[0] + '"' + (p.notif[n[0]] ? ' checked' : '') + '> ' + n[1] + '</label>').join('') +
      '<label class="row">Controlla ogni <select id="iv">' + [[15, '15 minuti'], [30, '30 minuti'], [60, '1 ora'], [120, '2 ore'], [180, '3 ore']].map(h => '<option value="' + h[0] + '"' + (p.intervalMin === h[0] ? ' selected' : '') + '>' + h[1] + '</option>').join('') + '</select></label>' +
      '<p class="foot">Ricevi la notifica solo quando la fonte pubblica davvero un dato nuovo: più il controllo è frequente, prima arriva l\'avviso (usa pochissimi dati).</p></div>' +
      (IS_APP ? '<button class="pill" id="test">Invia notifica di prova</button>' : '') + '</div>' +
      '<div class="box"><div class="bt">Aspetto</div><div class="theme3">' +
      [['auto', 'Automatico'], ['light', 'Chiaro'], ['dark', 'Scuro']].map(t => '<button data-theme="' + t[0] + '" class="' + ((store.get('theme') || 'auto') === t[0] ? 'on' : '') + '">' + t[1] + '</button>').join('') +
      '</div><p class="foot">Automatico segue il tema scelto nelle impostazioni del telefono.</p></div>' +
      '<div class="box"><div class="bt">Dati</div><button class="pill" id="all">Aggiorna tutto ora</button> <button class="pill" id="clr">Svuota cache</button><p class="foot" id="cachei"></p></div>' +
      (IS_APP && window.Android && Android.webVersion ? '<div class="box"><div class="bt">Aggiornamenti dell\'app</div><p class="foot">Versione interfaccia: <b>' + esc(Android.webVersion()) + '</b>. L\'app controlla da sola a ogni apertura se c\'è una versione nuova e la scarica senza reinstallare.</p>' +
        '<button class="pill" id="updchk">Cerca aggiornamenti ora</button> <button class="pill" id="updreset">Ripristina versione originale</button><p class="foot" id="updst"></p></div>' : '') +
      '<div class="box"><div class="bt">Informazioni</div><p class="foot">Indici Meteo 1.8 — © ' + new Date().getFullYear() + ' Biagio Paparella, tutti i diritti riservati. I dati vengono scaricati direttamente dalle fonti ufficiali: NOAA CPC e PSL (teleconnessioni, ENSO, QBO, IOD), Bureau of Meteorology australiano (MJO), NOAA SWPC (meteo spaziale), NASA SDO e SOHO (immagini del Sole), Open-Meteo.com (modelli per l\'instabilità). Ogni fonte ha i suoi orari di pubblicazione: l\'app mostra sempre l\'ultimo dato disponibile e la data a cui si riferisce. Strumento informativo: per allerte ufficiali fai riferimento alla Protezione Civile e al Servizio Meteorologico.</p></div>';
    const save = () => {
      p.enabled = $('#en').checked;
      app.querySelectorAll('[data-k]').forEach(c => { p.notif[c.dataset.k] = c.checked; });
      p.intervalMin = +$('#iv').value;
      $('#nlist').className = p.enabled ? '' : 'dim';
      savePrefs(p);
    };
    app.querySelectorAll('input,select').forEach(i => i.addEventListener('change', save));
    app.querySelectorAll('.theme3 button').forEach(b => b.addEventListener('click', () => {
      store.set('theme', b.dataset.theme);
      app.querySelectorAll('.theme3 button').forEach(x => x.classList.toggle('on', x === b));
      applyTheme();
    }));
    if ($('#test')) $('#test').onclick = () => { save(); Android.testNotification(); };
    if ($('#updchk')) $('#updchk').onclick = () => { $('#updst').textContent = 'Controllo in corso…'; Android.checkUpdate(); };
    if ($('#updreset')) $('#updreset').onclick = () => { if (confirm('Tornare alla versione dell\'interfaccia inclusa nell\'app?')) Android.resetWeb(); };
    $('#all').onclick = async () => { status('Aggiorno tutte le fonti…'); await Promise.all(Object.keys(DS).map(id => getDS(id, true))); status(''); cacheInfo(); };
    $('#clr').onclick = () => { Object.keys(localStorage).filter(k => /^(ds:|om:|ita:)/.test(k)).forEach(k => localStorage.removeItem(k)); cacheInfo(); };
    cacheInfo();
  }
  function cacheInfo() {
    const el = $('#cachei'); if (!el) return;
    const n = Object.keys(DS).filter(id => cached(id)).length;
    const err = Object.keys(DS).filter(id => cached(id) && cached(id).err);
    el.innerHTML = n + ' fonti in memoria su ' + Object.keys(DS).length + (err.length ? '. Con errori all\'ultimo tentativo: ' + err.join(', ') : '.');
  }

  /* ================= aggiornamento interfaccia senza nuovo APK ================= */
  window.__updateReady = v => {
    let b = $('#updbar');
    if (!b) { b = document.createElement('div'); b.id = 'updbar'; document.body.appendChild(b); }
    b.innerHTML = '✨ Nuova versione dell\'app pronta (' + v + ') <button onclick="Android.reload()">Ricarica</button>';
    const st = $('#updst'); if (st) st.textContent = 'Scaricata la versione ' + v + ': tocca Ricarica in basso.';
  };
  window.__updateNone = () => { const st = $('#updst'); if (st) st.textContent = 'Hai già l\'ultima versione.'; };

  /* ================= tema chiaro / scuro ================= */
  function applyTheme() {
    const t = store.get('theme') || 'auto';
    let night;
    if (t === 'auto') {
      try { night = (window.Android && Android.isNight) ? Android.isNight() : matchMedia('(prefers-color-scheme: dark)').matches; }
      catch (e) { night = true; }
    } else night = t === 'dark';
    if (night) document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', 'light');
    const m = document.querySelector('meta[name=theme-color]'); if (m) m.content = night ? '#0f1420' : '#f3f5f9';
    try { if (window.Android && Android.setBars) Android.setBars(!night); } catch (e) { /* */ }
  }
  window.__applyTheme = () => { applyTheme(); render(); };
  try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if ((store.get('theme') || 'auto') === 'auto') window.__applyTheme(); }); } catch (e) { /* */ }
  applyTheme();

  /* ================= router ================= */
  async function render() {
    route = location.hash || '#/tele';
    window.scrollTo(0, 0);
    const p = route.slice(2).split('/');
    if (p[0] === 'd' && p[1]) return pageDetail(p[1]);
    if (p[0] === 'sun') return pageSun();
    if (p[0] === 'conv') return pageConv(false);
    if (p[0] === 'set') return pageSet();
    return pageTele();
  }
  function refreshCurrent(force) {
    const p = (location.hash || '#/tele').slice(2).split('/');
    if (p[0] === 'conv') return pageConv(true);
    if (p[0] === 'd') {
      const card = ALL_CARDS.find(c => c.id === p[1]);
      if (card) { status('Aggiornamento…'); return Promise.all(card.ds.map(id => getDS(id, true))).then(() => { status(''); render(); }); }
    }
    const cards = p[0] === 'sun' ? SUN_CARDS : TELE_CARDS;
    if (p[0] === 'set') return;
    const draw = () => { if ((location.hash || '#/tele') === route) render(); };
    return loadCards(cards, force, draw);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });
  window.__androidResume = () => render();

  // in background, al primo avvio, pre-scarica anche le altre sezioni
  setTimeout(() => { Object.keys(DS).filter(id => !/^fc_/.test(id)).forEach(id => getDS(id)); }, 4000);

  render();
})();
