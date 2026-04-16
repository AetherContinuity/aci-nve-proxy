// ACI NVE Hydro Proxy — Cloudflare Worker
// Kokeilee useita NVE endpointeja järjestyksessä

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

const HISTORICAL_MEDIAN = 67.5;

const ENDPOINTS = [
  // Uusi biapi endpoint
  'https://biapi.nve.no/magasinstatistikk/api/Magasinstatistikk?omrade=0&antallUker=2',
  // Vaihtoehto ilman parametreja
  'https://biapi.nve.no/magasinstatistikk/api/Magasinstatistikk',
  // Vanha endpoint (merkitty poistuneeksi mutta voi toimia)
  'http://api.nve.no/web/EnergyMarket/Currentweek/?format=json&lang=en&Omr=NO',
];

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const errors = [];

    for (const url of ENDPOINTS) {
      try {
        const resp = await fetch(url, {
          headers: { 'Accept': 'application/json', 'User-Agent': 'ACI-NVE-Proxy/1.0' }
        });

        if (!resp.ok) {
          errors.push(`${url} → ${resp.status}`);
          continue;
        }

        const data = await resp.json();

        // Tunnista datarakenne
        let filling = null, week = null, year = null, change = null, gwh = null;

        if (Array.isArray(data) && data.length > 0) {
          // biapi palauttaa listan
          const row = data[0];
          filling = row.fyllingsprosent ?? row.FyllingsProsent ?? row.RelFyllGrad ?? null;
          week    = row.uke ?? row.Uke ?? null;
          year    = row.aar ?? row.Aar ?? null;
          change  = row.endringFraForrigeUke ?? row.EndringFraForrigeUke ?? null;
          gwh     = row.innholdGWh ?? row.InnholdGWh ?? null;
        } else if (data && typeof data === 'object') {
          // Vanha endpoint palauttaa objektin
          filling = data.RelFyllGrad ?? null;
          week    = data.Uke ?? null;
          year    = data.Aar ?? null;
          change  = data.EndringFraForrigeUke ?? null;
          gwh     = data.InnholdGWh ?? null;
        }

        if (filling == null) {
          errors.push(`${url} → data ok mutta filling=null, keys: ${Object.keys(Array.isArray(data) ? data[0] : data).join(',')}`);
          continue;
        }

        const hydro_RF = Math.min(1.2, Math.max(0.3, filling / HISTORICAL_MEDIAN));
        const label = hydro_RF < 0.80 ? 'low' : hydro_RF < 1.05 ? 'normal' : 'high';

        return new Response(JSON.stringify({
          source:      url,
          week:        year && week ? `${year}-W${String(week).padStart(2,'0')}` : null,
          filling_pct: filling,
          content_gwh: gwh,
          median_pct:  HISTORICAL_MEDIAN,
          hydro_RF:    Math.round(hydro_RF * 1000) / 1000,
          label,
          change_pp:   change,
          fetched:     new Date().toISOString()
        }), { headers: CORS });

      } catch (err) {
        errors.push(`${url} → ${err.message}`);
      }
    }

    // Kaikki epäonnistuivat
    return new Response(JSON.stringify({
      error: 'All NVE endpoints failed',
      tried: errors,
      hydro_RF: 1.0,
      label: 'fallback'
    }), { status: 502, headers: CORS });
  }
};
