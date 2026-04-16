// ACI NVE Hydro Proxy — Cloudflare Worker
// Endpoint: GET /?week=current
// Lähde: NVE EnergyMarket API (avoin, ei API-avainta)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

// Historiallinen mediaani viikottaiselle täyttöasteelle (koko Norja)
// Lähde: NVE tilastot 1990-2020 keskiarvo ~65-70%
// Käytetään kun live-mediaania ei ole saatavilla
const HISTORICAL_MEDIAN = 67.5;

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    try {
      // NVE EnergyMarket — koko Norja, kuluva viikko
      const url = 'http://api.nve.no/web/EnergyMarket/Currentweek/?format=json&lang=en&Omr=NO';
      const resp = await fetch(url, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'ACI-NVE-Proxy/1.0' }
      });

      if (!resp.ok) {
        return new Response(JSON.stringify({
          error: 'NVE fetch failed', status: resp.status,
          hydro_RF: 1.0, label: 'fallback'
        }), { status: 502, headers: CORS });
      }

      const data = await resp.json();

      // Rakenne: { Aar, Uke, RelFyllGrad, EndringFraForrigeUke, InnholdGWh, Omr }
      const filling = data.RelFyllGrad ?? null;
      const gwh     = data.InnholdGWh ?? null;
      const week    = data.Uke ?? null;
      const year    = data.Aar ?? null;

      // hydro_RF = täyttöaste / historiallinen mediaani, rajattu 0.3–1.2
      const hydro_RF = filling != null
        ? Math.min(1.2, Math.max(0.3, filling / HISTORICAL_MEDIAN))
        : 1.0;

      const label = hydro_RF < 0.80 ? 'low'
                  : hydro_RF < 1.05 ? 'normal'
                  : 'high';

      return new Response(JSON.stringify({
        source:      'NVE EnergyMarket — Currentweek',
        week:        year && week ? `${year}-W${String(week).padStart(2,'0')}` : null,
        filling_pct: filling,
        content_gwh: gwh,
        median_pct:  HISTORICAL_MEDIAN,
        hydro_RF:    Math.round(hydro_RF * 1000) / 1000,
        label,
        change_pp:   data.EndringFraForrigeUke ?? null,
        fetched:     new Date().toISOString()
      }), { headers: CORS });

    } catch (err) {
      return new Response(JSON.stringify({
        error: err.message, hydro_RF: 1.0, label: 'fallback'
      }), { status: 500, headers: CORS });
    }
  }
};
