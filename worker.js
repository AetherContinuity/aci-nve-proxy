// ACI NVE Hydro Proxy — v12
//   GET /                NVE Magasinstatistikk (koko Norja) + viikkokohtainen mediaani
//   GET /nve/raw         ?e=SisteUke|MinMaxMedian   NVE:n raakavastaus (kenttien tarkistus)
//   GET /syke            ?entity=Vedenkorkeus&$filter=&$select=&$orderby=&$top=&$skip=
//                        SYKE Hydrologiarajapinta 1.1 (OData), sallitut entiteetit alla
//   GET /syke/meta       [?entity=Paikka]   entiteettien kentät ja tyypit
//   GET /syke/wsfs       ?point=l147221001y  WSFS-ennuste (malli, EI havainto)
//   GET /vesiraja[/stations|/variables|/statistics]  [?v=1.0]  SYKE Vesiraja API
//   GET /version         deployn tarkistus
// Tuntemattomat polut → 404 (ei välimuistiin). Välimuisti: wrangler.toml [cache] + Cache-Control.

const VERSION = 'v12-2026-09-17';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

const TTL_NVE = 21600;   // 6 h — NVE julkaisee viikoittain
const TTL_SYKE = 3600;   // 1 h
const TTL_META = 86400;  // 24 h

const NVE_BASE = 'https://biapi.nve.no/magasinstatistikk/api/Magasinstatistikk';
const HYD = 'https://rajapinnat.ymparisto.fi/api/Hydrologiarajapinta/1.1/odata/';
const HYD_ENT = new Set(['Paikka', 'Vedenkorkeus', 'Virtaama', 'LampoPintavesi', 'Jaanpaksuus',
  'JaatJaanlahto', 'Suure', 'Korkeustaso', 'VedenkTasoTieto', 'Jakso', 'Tila', 'Lippu']);
const VESIRAJA_BASE = 'https://api.ymparisto.fi/vesiraja';
const FALLBACK_MEDIAN = 58.0; // vain jos viikkomediaania ei saada

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (request.method !== 'GET') return json({ error: 'GET only' }, 405, 0);

    const u = new URL(request.url);
    const p = u.pathname.replace(/\/+$/, '') || '/';
    try {
      if (p === '/') return await handleNve(env);
      if (p === '/version') return json({ version: VERSION }, 200, 0);
      if (p === '/nve/raw') return await handleNveRaw(env, u.searchParams);
      if (p === '/syke') return await handleHydOdata(u.searchParams);
      if (p === '/syke/meta') return await handleHydMeta(u.searchParams);
      if (p === '/syke/wsfs') return await handleWsfs(u.searchParams);
      if (p.startsWith('/vesiraja')) return await handleVesiraja(p, u.searchParams);
      return json({ error: `unknown path: ${p}`, version: VERSION }, 404, 0);
    } catch (err) {
      return json({ error: err.message }, 500, 0);
    }
  },
};

// ─── apu ─────────────────────────────────────────────────────────────
function json(obj, status = 200, ttl = 0) {
  const h = { ...CORS, 'Cache-Control': ttl ? `public, max-age=${ttl}` : 'no-store' };
  return new Response(JSON.stringify(obj), { status, headers: h });
}
function today() { return new Date().toISOString().slice(0, 10); }
async function upstreamError(label, r, url) {
  const t = await r.text().catch(() => '');
  return json({ error: `${label} HTTP ${r.status}`, url, detail: t.slice(0, 400) }, 502, 0);
}

// ─── NVE ─────────────────────────────────────────────────────────────
async function nveGet(env, endpoint) {
  return fetch(`${NVE_BASE}/${endpoint}`, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'ACI-NVE-Proxy/1.2', 'X-API-Key': env.NVE_API_KEY || '' },
  });
}

async function handleNve(env) {
  const resp = await nveGet(env, 'HentOffentligDataSisteUke');
  if (!resp.ok) return upstreamError('NVE', resp, 'HentOffentligDataSisteUke');
  const rows = await resp.json();
  const allRows = Array.isArray(rows) ? rows : [rows];

  // Koko Norja = suurin kapasiteetti
  const row = allRows.reduce((best, r) =>
    (r.kapasitet_TWh ?? 0) > (best?.kapasitet_TWh ?? 0) ? r : best, allRows[0]);

  const filling = row.fyllingsgrad * 100;
  const prevFilling = row.fyllingsgrad_forrige_uke != null ? row.fyllingsgrad_forrige_uke * 100 : null;
  const change = row.endring_fyllingsgrad != null ? Math.round(row.endring_fyllingsgrad * 1000) / 10 : null;

  // Viikkokohtainen mediaani (v12). Aiempi kiinteä 58 % oli huhtikuun arvo kaikille viikoille.
  let median = FALLBACK_MEDIAN, medianSource = 'fixed-58', mmm = null;
  try {
    const mr = await nveGet(env, 'HentOffentligDataMinMaxMedian');
    if (mr.ok) {
      const all = await mr.json();
      mmm = (Array.isArray(all) ? all : []).find(m =>
        m.iso_uke === row.iso_uke && m.omrType === row.omrType && m.omrnr === row.omrnr);
      const med = mmm?.medianFyllingsgrad ?? mmm?.median_fyllingsgrad;
      if (typeof med === 'number') { median = med * 100; medianSource = 'nve-week-median'; }
    }
  } catch (_) { /* fallback */ }

  const hydro_RF = Math.min(1.2, Math.max(0.3, filling / median));
  const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
  const mm = (k1, k2) => { const v = mmm?.[k1] ?? mmm?.[k2]; return typeof v === 'number' ? r1(v * 100) : null; };

  return json({
    source: 'NVE Magasinstatistikk',
    version: VERSION,
    week: `${row.iso_aar}-W${String(row.iso_uke).padStart(2, '0')}`,
    date: row.dato_Id,
    filling_pct: r1(filling),
    prev_pct: r1(prevFilling),
    previous_week_pct: r1(prevFilling), // HEM-sivu lukee tätä nimeä
    change_pp: change,
    capacity_twh: row.kapasitet_TWh,
    content_twh: row.fylling_TWh,
    median_pct: r1(median),
    median_source: medianSource,
    min_pct: mm('minFyllingsgrad', 'min_fyllingsgrad'),
    max_pct: mm('maxFyllingsgrad', 'max_fyllingsgrad'),
    hydro_RF: Math.round(hydro_RF * 1000) / 1000,
    label: hydro_RF < 0.80 ? 'low' : hydro_RF < 1.05 ? 'normal' : 'high',
    omrType: row.omrType,
    omrnr: row.omrnr,
    next_update: row.neste_Publiseringsdato,
    fetched: new Date().toISOString(),
  }, 200, TTL_NVE);
}

async function handleNveRaw(env, params) {
  const e = params.get('e') || 'SisteUke';
  const map = { SisteUke: 'HentOffentligDataSisteUke', MinMaxMedian: 'HentOffentligDataMinMaxMedian' };
  if (!map[e]) return json({ error: 'e = SisteUke | MinMaxMedian' }, 400, 0);
  const r = await nveGet(env, map[e]);
  if (!r.ok) return upstreamError('NVE', r, map[e]);
  const d = await r.json();
  const arr = Array.isArray(d) ? d : [d];
  return json({ endpoint: map[e], n: arr.length, fields: Object.keys(arr[0] || {}), sample: arr.slice(0, 3) }, 200, TTL_NVE);
}

// ─── SYKE Hydrologiarajapinta ────────────────────────────────────────
async function handleHydOdata(params) {
  const ent = params.get('entity') || 'Vedenkorkeus';
  if (!HYD_ENT.has(ent)) return json({ error: `entity not allowed: ${ent}`, allowed: [...HYD_ENT] }, 400, 0);
  const parts = [];
  for (const k of ['$filter', '$select', '$orderby', '$skip', '$expand']) {
    if (params.get(k)) parts.push(`${k}=${encodeURIComponent(params.get(k))}`);
  }
  const top = Math.min(parseInt(params.get('$top') || '1000', 10) || 1000, 10000);
  parts.push(`$top=${top}`, '$format=json');
  const target = `${HYD}${ent}?${parts.join('&')}`;
  const r = await fetch(target, { headers: { 'Accept': 'application/json', 'User-Agent': 'ACI-HEM/1.2' } });
  if (!r.ok) return upstreamError('Hydrologiarajapinta', r, target);
  const text = await r.text();
  return new Response(text, {
    headers: { ...CORS, 'Cache-Control': `public, max-age=${TTL_SYKE}`, 'X-Upstream-URL': target },
  });
}

async function handleHydMeta(params) {
  const r = await fetch(`${HYD}$metadata`);
  if (!r.ok) return upstreamError('Hydrologiarajapinta', r, `${HYD}$metadata`);
  const x = await r.text();
  const types = {};
  for (const m of x.matchAll(/<EntityType Name="([^"]+)"[^>]*>([\s\S]*?)<\/EntityType>/g)) {
    types[m[1]] = [...m[2].matchAll(/<Property\s+Name="([^"]+)"\s+Type="([^"]+)"/g)]
      .map((a) => `${a[1]}:${a[2].replace('Edm.', '')}`);
  }
  const ent = params.get('entity');
  return json(ent ? { [ent]: types[ent] ?? null } : types, 200, TTL_META);
}

// ─── SYKE WSFS (ennuste) ─────────────────────────────────────────────
async function handleWsfs(params) {
  const point = params.get('point') || 'l147221001y';
  if (!/^[a-z0-9]+$/i.test(point)) return json({ error: 'invalid point' }, 400, 0);
  const url = `https://wwwi2.ymparisto.fi/i2/wsfs/${point}_w.json`;
  const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!r.ok) return upstreamError('WSFS', r, url);
  const d = await r.json();
  return json({ source: 'SYKE WSFS (malliennuste, ei havainto)', point, ...d }, 200, TTL_SYKE);
}

// ─── SYKE Vesiraja ───────────────────────────────────────────────────
async function handleVesiraja(path, params) {
  const sub = path.replace('/vesiraja', '').replace(/^\//, '');
  const v = params.get('v') || '1.0';
  let endpoint;
  if (sub === 'stations' || sub === 'variables') {
    endpoint = `${VESIRAJA_BASE}/${sub}?api-version=${encodeURIComponent(v)}`;
  } else {
    const vc = encodeURIComponent(params.get('variable') || 'WaterLevel');
    const start = params.get('start') || '2025-01-01';
    const end = params.get('end') || today();
    const sc = params.get('station') || '';
    let q = `api-version=${encodeURIComponent(v)}&VariableCode=${vc}&DateStart=${start}&DateEnd=${end}`;
    if (sc) q += `&StationCode=${encodeURIComponent(sc)}`;
    endpoint = sub === 'statistics'
      ? `${VESIRAJA_BASE}/statistics/daily/json?${q}`
      : `${VESIRAJA_BASE}/timeseries/json?${q}`;
  }
  const r = await fetch(endpoint, { headers: { 'Accept': 'application/json', 'User-Agent': 'ACI-HEM/1.2' } });
  if (!r.ok) return upstreamError('Vesiraja', r, endpoint);
  return json({ source: 'SYKE Vesiraja API', endpoint, data: await r.json() }, 200, TTL_SYKE);
}
