// ACI NVE Hydro Proxy — v11: NVE (v10 ennallaan) + SYKE Hydrologiarajapinta, Vesiraja, WSFS
//   GET /            NVE Magasinstatistikk
//   GET /syke        ?location=&start=&end=   Hydrologiarajapinta WaterLevelRegisters
//   GET /syke/paikat  OData-metadata (entiteetit)
//   GET /syke/wsfs   ?point=l147221001y       WSFS-ennuste (malli, ei havainto)
//   GET /vesiraja[/stations|/variables|/statistics] Vesiraja API

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

// NVE julkaisee viikoittain — 6h TTL riittää tuoreuteen eikä hae samaa
// vastausta uudelleen jokaisella dashboard-latauksella.
// Workers Cache (wrangler.toml [cache] enabled = true), ei Cache API:a
// (caches.default) — se ei toimi workers.dev-osoitteissa (vyöhyketasoinen,
// jaettu kaikkien workers.dev-käyttäjien kesken). Cache-Control-otsikko
// riittää; Cloudflare tarkistaa ja tallentaa välimuistin itse.
const TTL = 21600;

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }


    const u = new URL(request.url);
    try {
      if (u.pathname === '/syke' || u.pathname === '/syke/') return await handleSyke(u.searchParams);
      if (u.pathname === '/syke/paikat') return await handleSykePaikat();
      if (u.pathname === '/syke/wsfs' || u.pathname === '/syke/wsfs/') return await handleSykeWsfs(u.searchParams);
      if (u.pathname.startsWith('/vesiraja')) return await handleVesiraja(u);
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS });
    }
    // Muut polut: NVE (v10, ennallaan)
    const apiKey = env.NVE_API_KEY || '';
    const url = 'https://biapi.nve.no/magasinstatistikk/api/Magasinstatistikk/HentOffentligDataSisteUke';

    try {
      const resp = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'ACI-NVE-Proxy/1.0',
          'X-API-Key': apiKey
        }
      });

      if (!resp.ok) {
        return new Response(JSON.stringify({ error: `HTTP ${resp.status}` }), { status: 502, headers: CORS });
      }

      const rows = await resp.json();
      const allRows = Array.isArray(rows) ? rows : [rows];

      // Koko Norja = suurin kapasiteetti (omrnr 0 ei välttämättä ole, etsi max TWh)
      const row = allRows.reduce((best, r) =>
        (r.kapasitet_TWh ?? 0) > (best?.kapasitet_TWh ?? 0) ? r : best
      , allRows[0]);

      const filling = row.fyllingsgrad * 100; // 0-1 → 0-100 %
      const prevFilling = row.fyllingsgrad_forrige_uke != null
        ? row.fyllingsgrad_forrige_uke * 100 : null;
      const change = row.endring_fyllingsgrad != null
        ? Math.round(row.endring_fyllingsgrad * 1000) / 10 : null; // pp

      // Historiallinen mediaani huhtikuulle (viikko 15) ~55-60%
      // Käytetään omrnr-tiedon perusteella myöhemmin, nyt fixed
      const HIST_MEDIAN = 58.0; // Norja, huhtikuu historiallinen ka

      const hydro_RF = Math.min(1.2, Math.max(0.3, filling / HIST_MEDIAN));

      const body = JSON.stringify({
        source:      'NVE Magasinstatistikk',
        week:        `${row.iso_aar}-W${String(row.iso_uke).padStart(2,'0')}`,
        date:        row.dato_Id,
        filling_pct: Math.round(filling * 10) / 10,
        prev_pct:    prevFilling != null ? Math.round(prevFilling * 10) / 10 : null,
        change_pp:   change,
        capacity_twh: row.kapasitet_TWh,
        content_twh:  row.fylling_TWh,
        median_pct:  HIST_MEDIAN,
        hydro_RF:    Math.round(hydro_RF * 1000) / 1000,
        label:       hydro_RF < 0.80 ? 'low' : hydro_RF < 1.05 ? 'normal' : 'high',
        omrnr:       row.omrnr,
        next_update: row.neste_Publiseringsdato,
        fetched:     new Date().toISOString()
      });
      const response = new Response(body, { headers: CORS });
      if (request.method === 'GET') {
        response.headers.set('Cache-Control', `public, max-age=${TTL}`);
      }
      return response;

    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS });
    }
  }
};

// ─── SYKE / Vesiraja (siirretty HEM-reposta, v11.1) ─────────────────
const SYKE_BASE = 'https://rajapinnat.ymparisto.fi/api/Hydrologiarajapinta/1.1/odata/WaterLevelRegisters';
const VESIRAJA_BASE = 'https://api.ymparisto.fi/vesiraja';
function today() { return new Date().toISOString().slice(0, 10); }

async function handleSyke(params) {
  // LocationId muoto: '04.112.1.001' (Saimaa Lauritsala)
  const locationId = params.get('location') || params.get('paikka') || '04.112.1.001';
  const start      = params.get('start') || '2024-01-01';
  const end        = params.get('end')   || new Date().toISOString().slice(0, 10);
  const top        = params.get('top')   || '5000';

  const filter = [
    `LocationId eq '${locationId}'`,
    `Timestamp ge ${start}T00:00:00Z`,
    `Timestamp le ${end}T23:59:59Z`,
  ].join(' and ');

  const sykeUrl = `${SYKE_BASE}?$filter=${encodeURIComponent(filter)}&$orderby=Timestamp asc&$top=${top}&$format=json&$select=Timestamp,Wvalue`;

  const resp = await fetch(sykeUrl, { headers: { 'Accept': 'application/json' } });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    return new Response(JSON.stringify({
      error: `SYKE HTTP ${resp.status}`,
      url: sykeUrl,
      detail: errText.slice(0, 300)
    }), { status: 502, headers: CORS });
  }

  const data = await resp.json();
  const rows = (data.value || []).map(r => ({
    date:  r.Timestamp?.slice(0, 10),
    value: r.Wvalue,
  }));

  return new Response(JSON.stringify({
    source: 'SYKE Hydrologiarajapinta 1.1',
    locationId, start, end,
    n: rows.length,
    rows
  }), { headers: CORS });
}

async function handleSykePaikat() {
  // Hae OData-metadata — näyttää kaikki saatavilla olevat entiteetit
  const metaUrl = 'https://rajapinnat.ymparisto.fi/api/Hydrologiarajapinta/1.1/odata/$metadata';
  const rootUrl = 'https://rajapinnat.ymparisto.fi/api/Hydrologiarajapinta/1.1/odata/';

  // Hae ensin juuridokumentti
  const rootResp = await fetch(rootUrl, { headers: { 'Accept': 'application/json' } });
  const rootText = await rootResp.text().catch(() => '');

  // Sitten metadata
  const metaResp = await fetch(metaUrl);
  const metaText = await metaResp.text().catch(() => '');

  // Poimii EntitySet-nimet XML-metadatasta
  const entities = [...metaText.matchAll(/EntitySet Name="([^"]+)"/g)].map(m => m[1]);
  const entityTypes = [...metaText.matchAll(/EntityType Name="([^"]+)"/g)].map(m => m[1]);

  return new Response(JSON.stringify({
    root_status: rootResp.status,
    root_preview: rootText.slice(0, 500),
    meta_status: metaResp.status,
    entities,
    entityTypes,
    meta_preview: metaText.slice(0, 1000)
  }), { headers: CORS });
}

async function handleVesiraja(url) {
  const params = url.searchParams;
  const sub = url.pathname.replace('/vesiraja', '').replace(/^\//, '');

  let endpoint;

  if (sub === 'stations') {
    endpoint = `${VESIRAJA_BASE}/stations?api-version=1`;
  } else if (sub === 'variables') {
    endpoint = `${VESIRAJA_BASE}/variables?api-version=1`;
  } else if (sub === 'statistics') {
    const vc    = params.get('variable') || 'WaterLevel';
    const start = params.get('start')    || '2025-01-01';
    const end   = params.get('end')      || today();
    const sc    = params.get('station')  || '';
    let q = `api-version=1&VariableCode=${vc}&DateStart=${start}&DateEnd=${end}`;
    if (sc) q += `&StationCode=${sc}`;
    endpoint = `${VESIRAJA_BASE}/statistics/daily/json?${q}`;
  } else {
    // default: timeseries
    const vc    = params.get('variable') || 'WaterLevel';
    const start = params.get('start')    || '2025-01-01';
    const end   = params.get('end')      || today();
    const sc    = params.get('station')  || '';
    let q = `api-version=1&VariableCode=${vc}&DateStart=${start}&DateEnd=${end}`;
    if (sc) q += `&StationCode=${sc}`;
    endpoint = `${VESIRAJA_BASE}/timeseries/json?${q}`;
  }

  const resp = await fetch(endpoint, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'ACI-HEM/1.1' }
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    return new Response(JSON.stringify({
      error: `Vesiraja HTTP ${resp.status}`,
      url: endpoint,
      detail: errText.slice(0, 300)
    }), { status: 502, headers: CORS });
  }

  const data = await resp.json();
  return new Response(JSON.stringify({
    source: 'SYKE Vesiraja API',
    endpoint,
    data
  }), { headers: CORS });
}

async function handleSykeWsfs(params) {
  const point = params.get('point') || 'l147221001y';
  const url = `https://wwwi2.ymparisto.fi/i2/wsfs/${point}_w.json`;
  
  const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!r.ok) {
    return new Response(JSON.stringify({
      error: `WSFS HTTP ${r.status}`,
      point,
      url,
    }), { status: 502, headers: CORS });
  }
  
  const d = await r.json();
  return new Response(JSON.stringify({
    source: 'SYKE WSFS',
    point,
    ...d,
  }), { headers: CORS });
}

