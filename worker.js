// ACI NVE Hydro Proxy — v6: testaa oikea biapi endpoint

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

const HISTORICAL_MEDIAN = 67.5;

const ENDPOINTS = [
  'https://biapi.nve.no/magasinstatistikk/api/v1/Magasinstatistikk?omrade=0&antallUker=2',
  'https://biapi.nve.no/magasinstatistikk/api/v1/MagasinStatistikk?omrade=0&antallUker=2',
  'https://biapi.nve.no/magasinstatistikk/api/v1/magasinstatistikk?omrade=0&antallUker=2',
  'https://biapi.nve.no/magasinstatistikk/api/Magasinstatistikk?omrade=0&antallUker=2',
  'https://biapi.nve.no/magasinstatistikk/Magasinstatistikk?omrade=0&antallUker=2',
  'https://biapi.nve.no/magasinstatistikk/api/v1/Magasinstatistikk',
  'https://biapi.nve.no/magasinstatistikk/api/v1/Magasinstatistikk?omrade=NO&antallUker=2',
];

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const apiKey = env.NVE_API_KEY || '';
    const headers = {
      'Accept': 'application/json',
      'User-Agent': 'ACI-NVE-Proxy/1.0',
      'X-API-Key': apiKey
    };

    const results = [];

    for (const url of ENDPOINTS) {
      try {
        const resp = await fetch(url, { headers });
        const text = await resp.text();
        results.push({ url, status: resp.status, preview: text.slice(0, 150) });

        if (resp.ok && text.startsWith('[') || text.startsWith('{')) {
          const data = JSON.parse(text);
          const row = Array.isArray(data) ? data[0] : data;
          const filling = row?.fyllingsprosent ?? row?.FyllingsProsent ?? null;

          if (filling != null) {
            const median = row?.medianFyllingsprosent ?? HISTORICAL_MEDIAN;
            const hydro_RF = Math.min(1.2, Math.max(0.3, filling / median));
            return new Response(JSON.stringify({
              source: url,
              filling_pct: filling,
              median_pct: median,
              hydro_RF: Math.round(hydro_RF * 1000) / 1000,
              label: hydro_RF < 0.80 ? 'low' : hydro_RF < 1.05 ? 'normal' : 'high',
              week: `${row?.aar ?? '?'}-W${String(row?.uke ?? '?').padStart(2,'0')}`,
              fetched: new Date().toISOString()
            }), { headers: CORS });
          }
        }
      } catch (err) {
        results.push({ url, error: err.message });
      }
    }

    return new Response(JSON.stringify({
      error: 'All endpoints failed',
      hasKey: !!apiKey,
      debug: results
    }), { status: 502, headers: CORS });
  }
};
