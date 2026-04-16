// ACI NVE Hydro Proxy — v8: oikea Swagger-endpoint

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
      'X-API-Key': apiKey
    };

    // Kokeile ensin viimeisin viikko, sitten kaikki data
    const ENDPOINTS = [
      'https://biapi.nve.no/magasinstatistikk/api/Magasinstatistikk/HentOffentligDataSisteUke',
      'https://biapi.nve.no/magasinstatistikk/api/Magasinstatistikk/HentOffentligData?antallUker=2',
      'https://biapi.nve.no/magasinstatistikk/api/Magasinstatistikk/HentOffentligData',
    ];

    const results = [];

    for (const url of ENDPOINTS) {
      try {
        const resp = await fetch(url, { headers });
        const text = await resp.text();
        results.push({ url, status: resp.status, preview: text.slice(0, 300) });

        if (resp.ok) {
          const data = JSON.parse(text);
          // Etsi koko Norja (omrade=0 tai NO tai null)
          const rows = Array.isArray(data) ? data : [data];
          const row = rows.find(r =>
            r?.omradeNr === 0 || r?.omrade === 'NO' || r?.omradeNr == null
          ) || rows[0];

          const filling = row?.fyllingsprosent ?? row?.fyllingsgrad ?? null;
          if (filling != null) {
            const median = row?.medianFyllingsprosent ?? row?.median ?? HISTORICAL_MEDIAN;
            const hydro_RF = Math.min(1.2, Math.max(0.3, filling / (median || HISTORICAL_MEDIAN)));
            return new Response(JSON.stringify({
              source: url,
              filling_pct: filling,
              median_pct: median,
              hydro_RF: Math.round(hydro_RF * 1000) / 1000,
              label: hydro_RF < 0.80 ? 'low' : hydro_RF < 1.05 ? 'normal' : 'high',
              week: `${row?.aar ?? row?.year ?? '?'}-W${String(row?.uke ?? row?.week ?? '?').padStart(2,'0')}`,
              fetched: new Date().toISOString()
            }), { headers: CORS });
          }
          // Näytä kentät jos filling null
          results[results.length-1].sample = row;
          results[results.length-1].allKeys = Object.keys(row || {});
        }
      } catch (err) {
        results.push({ url, error: err.message });
      }
    }

    return new Response(JSON.stringify({
      error: 'Parsing failed — see debug',
      hasKey: !!apiKey,
      debug: results
    }), { status: 502, headers: CORS });
  }
};
