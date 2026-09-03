// ACI NVE Hydro Proxy — v10: oikeat kenttänimet, koko Norja

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
