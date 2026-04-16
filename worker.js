// ACI NVE Hydro Proxy — Cloudflare Worker v5
// Käyttää NVE API-avainta ympäristömuuttujasta

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

const HISTORICAL_MEDIAN = 67.5;

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const apiKey = env.NVE_API_KEY || '';
    const headers = {
      'Accept': 'application/json',
      'User-Agent': 'ACI-NVE-Proxy/1.0',
      ...(apiKey ? { 'X-API-Key': apiKey } : {})
    };

    // biapi endpoint — viikoittainen täyttöaste koko Norja (omrade=0)
    const url = 'https://biapi.nve.no/magasinstatistikk/api/v1/Magasinstatistikk?omrade=0&antallUker=2';

    try {
      const resp = await fetch(url, { headers });

      if (!resp.ok) {
        const text = await resp.text();
        return new Response(JSON.stringify({
          error: `NVE ${resp.status}`,
          preview: text.slice(0, 200),
          hasKey: !!apiKey,
          hydro_RF: 1.0,
          label: 'fallback'
        }), { status: 502, headers: CORS });
      }

      const data = await resp.json();
      const row = Array.isArray(data) ? data[0] : data;

      const filling = row?.fyllingsprosent ?? row?.FyllingsProsent ?? null;
      const median  = row?.medianFyllingsprosent ?? row?.MedianFyllingsprosent ?? HISTORICAL_MEDIAN;
      const week    = row?.uke ?? row?.Uke ?? null;
      const year    = row?.aar ?? row?.Aar ?? null;

      if (filling == null) {
        return new Response(JSON.stringify({
          error: 'filling=null',
          keys: Object.keys(row || {}),
          sample: row,
          hydro_RF: 1.0,
          label: 'fallback'
        }), { status: 502, headers: CORS });
      }

      const hydro_RF = Math.min(1.2, Math.max(0.3, filling / (median || HISTORICAL_MEDIAN)));
      const label = hydro_RF < 0.80 ? 'low' : hydro_RF < 1.05 ? 'normal' : 'high';

      return new Response(JSON.stringify({
        source: 'NVE Magasinstatistikk',
        week: year && week ? `${year}-W${String(week).padStart(2,'0')}` : null,
        filling_pct: filling,
        median_pct: median,
        hydro_RF: Math.round(hydro_RF * 1000) / 1000,
        label,
        change_pp: row?.endringFraForrigeUke ?? null,
        fetched: new Date().toISOString()
      }), { headers: CORS });

    } catch (err) {
      return new Response(JSON.stringify({
        error: err.message,
        hydro_RF: 1.0,
        label: 'fallback'
      }), { status: 500, headers: CORS });
    }
  }
};
