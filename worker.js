// ACI NVE Hydro Proxy — Cloudflare Worker v4
// Testaa useita endpointeja ja palauttaa debug-tiedot

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

const HISTORICAL_MEDIAN = 67.5;

// Kaikki tunnetut NVE endpoint-variantit
const ENDPOINTS = [
  'https://biapi.nve.no/magasinstatistikk/api/v1/Magasinstatistikk?omrade=0&antallUker=2',
  'https://biapi.nve.no/magasinstatistikk/api/v1/Magasinstatistikk',
  'https://biapi.nve.no/magasinstatistikk/api/Magasinstatistikk?omrade=0&antallUker=2',
  'https://biapi.nve.no/magasinstatistikk/api/MagasinStatistikk',
  'https://biapi.nve.no/magasinstatistikk/MagasinStatistikk',
  'https://api.nve.no/magasinstatistikk/api/v1/Magasinstatistikk',
];

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const results = [];

    for (const url of ENDPOINTS) {
      try {
        const resp = await fetch(url, {
          headers: { 'Accept': 'application/json', 'User-Agent': 'ACI-NVE-Proxy/1.0' }
        });
        const text = await resp.text();
        results.push({ url, status: resp.status, preview: text.slice(0, 120) });

        if (resp.ok) {
          try {
            const data = JSON.parse(text);
            const row = Array.isArray(data) ? data[0] : data;
            const filling = row?.fyllingsprosent ?? row?.FyllingsProsent ?? row?.RelFyllGrad ?? null;

            if (filling != null) {
              const hydro_RF = Math.min(1.2, Math.max(0.3, filling / HISTORICAL_MEDIAN));
              return new Response(JSON.stringify({
                source: url,
                filling_pct: filling,
                median_pct: HISTORICAL_MEDIAN,
                hydro_RF: Math.round(hydro_RF * 1000) / 1000,
                label: hydro_RF < 0.80 ? 'low' : hydro_RF < 1.05 ? 'normal' : 'high',
                week: `${row?.aar ?? row?.Aar ?? '?'}-W${String(row?.uke ?? row?.Uke ?? '?').padStart(2,'0')}`,
                fetched: new Date().toISOString()
              }), { headers: CORS });
            }
          } catch(e) {}
        }
      } catch (err) {
        results.push({ url, error: err.message });
      }
    }

    return new Response(JSON.stringify({
      error: 'All endpoints failed — see debug',
      debug: results,
      hydro_RF: 1.0,
      label: 'fallback'
    }), { status: 502, headers: CORS });
  }
};
