// ACI NVE Hydro Proxy — Cloudflare Worker
// Hakee Norjan vesivarantotilanteen NVE:n Magasinstatistikk-rajapinnasta
// Endpoint: GET /?week=current  tai  /?week=2024-W10

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

// NVE Magasinstatistikk — koko Norja aggregoituna
// fyllingsprosent = täyttöaste %, median = historiallinen mediaani samalle viikolle
const NVE_URL = 'https://biapi.nve.no/magasinstatistikk/api/Magasinstatistikk';

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);
    const week = url.searchParams.get('week') || 'current';

    try {
      // Hae NVE:ltä — koko Norja (omrade=0)
      const nveUrl = NVE_URL + '?omrade=0&antallUker=5';
      const resp = await fetch(nveUrl, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'ACI-NVE-Proxy/1.0' }
      });

      if (!resp.ok) {
        return new Response(JSON.stringify({
          error: 'NVE fetch failed',
          status: resp.status
        }), { status: 502, headers: CORS });
      }

      const data = await resp.json();

      // NVE palauttaa listan viikoista, uusin ensin
      // Rakenne: { aar, uke, fyllingsprosent, medianFyllingsprosent, ... }
      const latest = Array.isArray(data) ? data[0] : (data.data ? data.data[0] : null);

      if (!latest) {
        return new Response(JSON.stringify({ error: 'No data', raw: data }), {
          status: 404, headers: CORS
        });
      }

      // Laske hydro_RF = täyttöaste / mediaani
      const filling = latest.fyllingsprosent ?? latest.FyllingsProsent ?? null;
      const median  = latest.medianFyllingsprosent ?? latest.MedianFyllingsProsent ?? null;
      const hydro_RF = (filling != null && median != null && median > 0)
        ? Math.min(1.2, Math.max(0.3, filling / median))
        : 1.0;

      return new Response(JSON.stringify({
        source: 'NVE Magasinstatistikk',
        week: `${latest.aar ?? ''}-W${String(latest.uke ?? '').padStart(2,'0')}`,
        filling_pct: filling,
        median_pct: median,
        hydro_RF: Math.round(hydro_RF * 1000) / 1000,
        label: hydro_RF < 0.85 ? 'low' : hydro_RF < 1.05 ? 'normal' : 'high',
        raw_latest: latest,
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
