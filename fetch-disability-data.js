#!/usr/bin/env node
/**
 * fetch-disability-data.js
 *
 * Fetches ambulatory disability data from Census Reporter (no API key needed)
 * and writes disability-data.js to the project folder.
 *
 * Usage (Node 18+, no npm install needed):
 *   node fetch-disability-data.js
 */

const { writeFileSync } = require('fs');

const CR_BASE    = 'https://api.censusreporter.org/1.0/data/show/latest';
const TIGER_BASE = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/PUMA_TAD_TAZ_UGA_ZCTA/MapServer';
const PITTSBURGH_BBOX = '-80.37,40.18,-79.68,40.72';

// Census Reporter uses e.g. "B18105004" (no underscore, no trailing E)
const DISABILITY_VARS = [
  'B18105004', 'B18105007', 'B18105010', 'B18105013',
  'B18105016', 'B18105019', 'B18105023', 'B18105026',
  'B18105029', 'B18105032', 'B18105035', 'B18105038',
];
const TOTAL_VAR = 'B18105001';

function sumDisability(est) {
  return DISABILITY_VARS.reduce((sum, v) => {
    const val = parseFloat(est[v]) || 0;
    return sum + (val > 0 ? Math.round(val) : 0);
  }, 0);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Step 1: Pittsburgh ZIP codes from TIGERweb (layer 1 = ZCTAs) ─────────────

async function getPittsburghZips() {
  const url = `${TIGER_BASE}/1/query` +
    `?geometry=${encodeURIComponent(PITTSBURGH_BBOX)}` +
    '&geometryType=esriGeometryEnvelope&inSR=4326' +
    '&spatialRel=esriSpatialRelIntersects' +
    '&outFields=ZCTA5&returnGeometry=false&f=json';

  const data = await fetch(url).then(r => r.json());
  return [...new Set(
    (data.features || []).map(f => f.attributes?.ZCTA5).filter(Boolean)
  )];
}

// ── Step 2: ZIP disability data from Census Reporter (batches of 25) ─────────

async function fetchZipData(zips) {
  const result = {};
  const chunks = [];
  for (let i = 0; i < zips.length; i += 25) chunks.push(zips.slice(i, i + 25));

  for (let i = 0; i < chunks.length; i++) {
    process.stdout.write(`  batch ${i + 1}/${chunks.length}...\r`);
    const geoIds = chunks[i].map(z => `86000US${z}`).join(',');
    const url    = `${CR_BASE}?table_ids=B18105&geo_ids=${geoIds}`;
    const cr     = await fetch(url).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); });

    for (const geoid of Object.keys(cr.data)) {
      const zip = geoid.replace('86000US', '');
      const est = cr.data[geoid].B18105.estimate;
      result[zip] = { count: sumDisability(est), totalPop: Math.max(0, Math.round(parseFloat(est[TOTAL_VAR]) || 0)) };
    }
    if (i < chunks.length - 1) await sleep(300);
  }
  process.stdout.write('\n');
  return result;
}

// ── Step 3: Tract disability data from Census Reporter ────────────────────────

async function fetchTractData() {
  // 140 = census tract summary level; 05000US42003 = Allegheny County PA
  const url = `${CR_BASE}?table_ids=B18105&geo_ids=140|05000US42003`;
  const cr  = await fetch(url).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); });
  const result = {};
  for (const geoid of Object.keys(cr.data)) {
    const id11 = geoid.replace('14000US', ''); // strip summary-level prefix → 11-char GEOID
    const est  = cr.data[geoid].B18105.estimate;
    result[id11] = { count: sumDisability(est), totalPop: Math.max(0, Math.round(parseFloat(est[TOTAL_VAR]) || 0)) };
  }
  return result;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Step 1/3  Getting Pittsburgh ZIPs from TIGERweb...');
  const zips = await getPittsburghZips();
  console.log(`          Found ${zips.length} ZIPs`);

  console.log('Step 2/3  Fetching ZIP disability data from Census Reporter...');
  const zipcodes = await fetchZipData(zips);
  console.log(`          Got data for ${Object.keys(zipcodes).length} ZIPs`);

  console.log('Step 3/3  Fetching tract disability data from Census Reporter...');
  const tracts = await fetchTractData();
  console.log(`          Got data for ${Object.keys(tracts).length} tracts`);

  const generated = new Date().toISOString();
  const payload = {
    generated,
    source: 'Census Reporter / ACS 2022 5-Year, Table B18105 (Ambulatory Difficulty)',
    note:   'count = estimated people with serious ambulatory difficulty — nearest ACS proxy for wheelchair users',
    zipcodes,
    tracts,
  };

  const js = `// Auto-generated ${generated} -- re-run: node fetch-disability-data.js\n` +
             `window.DISABILITY_DATA = ${JSON.stringify(payload, null, 2)};\n`;
  writeFileSync('disability-data.js', js);
  console.log(`\nDone!  disability-data.js  |  ${Object.keys(zipcodes).length} ZIPs, ${Object.keys(tracts).length} tracts`);
}

main().catch(err => { console.error('\nFailed:', err.message); process.exit(1); });
