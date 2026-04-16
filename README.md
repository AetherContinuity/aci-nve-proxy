# ACI NVE Hydro Proxy

Cloudflare Worker joka hakee Norjan vesivarantotilanteen NVE:n 
Magasinstatistikk-rajapinnasta ja laskee hydro_RF-kertoimen 
ACI Winter Endurance Monitorin FS(p)-komponentille.

## Endpoint

GET https://aci-nve-proxy.ruotsalainen-marko.workers.dev/?week=current

## Vastaus

{
  "filling_pct": 68.4,
  "median_pct": 71.2,
  "hydro_RF": 0.961,
  "label": "normal",
  "week": "2026-W15"
}

## hydro_RF tulkinta

- > 1.05 = high (yli mediaanin)
- 0.85–1.05 = normal
- < 0.85 = low (kuivuus)
- < 0.70 = severe drought

## Käyttö WEM:ssä

FS(p) = (nuclear + hydro × hydro_RF) / consumption
