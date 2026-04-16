// ACI NVE Hydro Proxy — v9: korjaa desimaaliskaalaus + kenttänimet

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

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

      const data = await resp.json();
      const rows = Array.isArray(data) ? data : [data];

      // Näytä kaikki kentät debugia varten
      const sample = rows[0];
      const allKeys = Object.keys(sample || {});

      // Etsi koko Norja — omradeNr=0 tai ensimmäinen rivi
      const row = rows.find(r => r?.omradeNr === 0 || r?.omradeId === 0) || rows[0];

      // Kentät voivat olla desimaaleja (0-1) tai prosentteja (0-100)
      let filling = row?.fyllingsprosent ?? row?.fyllingsgrad ?? row?.fyllingsGrad ?? null;
      let median  = row?.medianFyllingsprosent ?? row?.medianFyllingsgrad ?? null;

      // Jos arvo on alle 1.5, se on desimaaliksi — kerrotaan 100
      if (filling != null && filling < 1.5) filling = filling * 100;
      if (median  != null && median  < 1.5) median  = median  * 100;

      const HIST_MEDIAN = 67.5;
      const effectiveMedian = median || HIST_MEDIAN;
      const hydro_RF = filling != null
        ? Math.min(1.2, Math.max(0.3, filling / effectiveMedian))
        : 1.0;

      // Viikko ja vuosi
      const year = row?.aar ?? row?.year ?? row?.År ?? null;
      const week = row?.uke ?? row?.week ?? row?.Uke ?? null;

      return new Response(JSON.stringify({
        source: 'NVE Magasinstatistikk — HentOffentligDataSisteUke',
        week: year && week ? `${year}-W${String(week).padStart(2,'0')}` : null,
        filling_pct: filling != null ? Math.round(filling * 10) / 10 : null,
        median_pct:  median  != null ? Math.round(median  * 10) / 10 : HIST_MEDIAN,
        hydro_RF:    Math.round(hydro_RF * 1000) / 1000,
        label:       hydro_RF < 0.80 ? 'low' : hydro_RF < 1.05 ? 'normal' : 'high',
        change_pp:   row?.endringFraForrigeUke ?? null,
        rows_total:  rows.length,
        debug_keys:  allKeys,
        debug_row:   row,
        fetched:     new Date().toISOString()
      }), { headers: CORS });

    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS });
    }
  }
};
