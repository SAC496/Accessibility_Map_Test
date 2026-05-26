#!/usr/bin/env node
/**
 * fetch-extra-data.js
 *
 * Pre-fetches OSM wheelchair, transit, age 65+, and terrain data
 * and writes extra-data.js for use in index.html (no runtime API calls needed).
 *
 * Usage (Node 18+):
 *   node fetch-extra-data.js
 *
 * Takes ~2-4 min (terrain elevation is the slow step due to rate limiting).
 */

const { writeFileSync } = require('fs');

const PITTSBURGH_BBOX  = '40.18,-80.37,40.72,-79.68';   // Overpass: south,west,north,east
const PITTSBURGH_BBOX_TIGER = '-80.37%2C40.18%2C-79.68%2C40.72'; // TIGERweb: west,south,east,north
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const CR_BASE = 'https://api.censusreporter.org/1.0/data/show/latest';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJson(url) {
  const resp = await fetch(url, { headers: { 'User-Agent': 'accessibility-map/1.0' } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} — ${url}`);
  return resp.json();
}

async function overpassGet(query) {
  const encoded = encodeURIComponent(query);
  for (const base of OVERPASS_ENDPOINTS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (attempt > 0) await sleep(3000);
        const data = await fetchJson(base + '?data=' + encoded);
        if (Array.isArray(data.elements)) return data.elements;
      } catch (e) {
        console.warn(`  Overpass ${base} attempt ${attempt + 1}: ${e.message}`);
      }
    }
  }
  throw new Error('All Overpass endpoints failed');
}

// ── Geometry helpers ──────────────────────────────────────────────────────────

function raycastRing(point, ring) {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

function pointInFeature(point, feature) {
  const { type, coordinates } = feature.geometry;
  if (type === 'Polygon')      return raycastRing(point, coordinates[0]);
  if (type === 'MultiPolygon') return coordinates.some(p => raycastRing(point, p[0]));
  return false;
}

function buildBboxed(features) {
  return features.map(f => {
    let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
    const rings = f.geometry.type === 'Polygon' ? f.geometry.coordinates : f.geometry.coordinates.flat(1);
    for (const ring of rings) for (const [lo, la] of ring) {
      if (lo < minLon) minLon = lo; if (lo > maxLon) maxLon = lo;
      if (la < minLat) minLat = la; if (la > maxLat) maxLat = la;
    }
    return { minLon, maxLon, minLat, maxLat, feature: f, id: f.id };
  });
}

function findArea(lon, lat, bboxed) {
  for (const fb of bboxed) {
    if (lon < fb.minLon || lon > fb.maxLon || lat < fb.minLat || lat > fb.maxLat) continue;
    if (pointInFeature([lon, lat], fb.feature)) return fb.id;
  }
  return null;
}

// ── Boundary GeoJSON from TIGERweb ────────────────────────────────────────────

async function fetchZipFeatures() {
  const BASE = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/PUMA_TAD_TAZ_UGA_ZCTA/MapServer';
  const meta = await fetchJson(BASE + '?f=json');
  const layer = (meta.layers || []).find(l => l.name && (l.name.toUpperCase().includes('ZCTA') || l.name.toUpperCase().includes('ZIP')));
  const id = layer ? layer.id : 1;
  const url = `${BASE}/${id}/query?geometry=${PITTSBURGH_BBOX_TIGER}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=ZCTA5&returnGeometry=true&f=geojson&outSR=4326`;
  const data = await fetchJson(url);
  return data.features.map(f => ({ ...f, id: f.properties.ZCTA5 }));
}

async function fetchTractFeatures() {
  const BASE = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Tracts_Blocks/MapServer';
  const meta = await fetchJson(BASE + '?f=json');
  const layer = (meta.layers || []).find(l => l.name && l.name.toUpperCase().includes('TRACT') && !l.name.toUpperCase().includes('BLOCK'));
  const id = layer ? layer.id : 2;
  const url = `${BASE}/${id}/query?geometry=${PITTSBURGH_BBOX_TIGER}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=GEOID&returnGeometry=true&f=geojson&outSR=4326`;
  const data = await fetchJson(url);
  return data.features.map(f => ({ ...f, id: f.properties.GEOID.replace(/^14000US/, '') }));
}

// ── OSM wheelchair-tagged buildings ──────────────────────────────────────────

async function computeOsmWheelchair(elements, bboxed) {
  const result = {};
  bboxed.forEach(({ id }) => result[id] = { yes: 0, limited: 0, no: 0 });
  for (const el of elements) {
    const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
    if (lat == null) continue;
    const w = el.tags?.wheelchair;
    if (!['yes', 'limited', 'no'].includes(w)) continue;
    const id = findArea(lon, lat, bboxed);
    if (id) result[id][w]++;
  }
  return result;
}

// ── Transit stops ─────────────────────────────────────────────────────────────

async function computeTransit(elements, bboxed) {
  const result = {};
  bboxed.forEach(({ id }) => result[id] = { accessible: 0, total: 0 });
  for (const el of elements) {
    if (el.lat == null) continue;
    const id = findArea(el.lon, el.lat, bboxed);
    if (id) {
      result[id].total++;
      if (el.tags?.wheelchair === 'yes') result[id].accessible++;
    }
  }
  return result;
}

// ── Age 65+ (Census Reporter B01001) ─────────────────────────────────────────

const AGE65_VARS = [
  'B01001020','B01001021','B01001022','B01001023','B01001024','B01001025',
  'B01001044','B01001045','B01001046','B01001047','B01001048','B01001049',
];
const sumAge65 = est => AGE65_VARS.reduce((s, v) => s + (parseFloat(est[v]) || 0), 0);

async function fetchAge65Zips(zips) {
  const result = {};
  const chunks = [];
  for (let i = 0; i < zips.length; i += 25) chunks.push(zips.slice(i, i + 25));
  for (let i = 0; i < chunks.length; i++) {
    process.stdout.write(`  batch ${i + 1}/${chunks.length}...\r`);
    const geoIds = chunks[i].map(z => `86000US${z}`).join(',');
    const cr = await fetchJson(`${CR_BASE}?table_ids=B01001&geo_ids=${geoIds}`);
    for (const [geoid, tables] of Object.entries(cr.data)) {
      const zip = geoid.replace('86000US', '');
      const est = tables.B01001.estimate;
      result[zip] = { count65: Math.round(sumAge65(est)), totalPop: Math.max(0, Math.round(parseFloat(est.B01001001) || 0)) };
    }
    if (i < chunks.length - 1) await sleep(300);
  }
  process.stdout.write('\n');
  return result;
}

async function fetchAge65Tracts() {
  const cr = await fetchJson(`${CR_BASE}?table_ids=B01001&geo_ids=140|05000US42003`);
  const result = {};
  for (const [geoid, tables] of Object.entries(cr.data)) {
    const id  = geoid.replace('14000US', '');
    const est = tables.B01001.estimate;
    result[id] = { count65: Math.round(sumAge65(est)), totalPop: Math.max(0, Math.round(parseFloat(est.B01001001) || 0)) };
  }
  return result;
}

// ── Terrain elevation (OpenTopoData SRTM 90m) ─────────────────────────────────

async function fetchTerrain(zipBboxed, tractBboxed) {
  const STEP = 0.02;
  const LAT_MIN = 40.18, LAT_MAX = 40.72, LON_MIN = -80.37, LON_MAX = -79.68;

  // Assign each grid point to a ZIP and a tract simultaneously
  const assignments = [];
  for (let lat = LAT_MIN; lat <= LAT_MAX + 0.001; lat += STEP) {
    for (let lon = LON_MIN; lon <= LON_MAX + 0.001; lon += STEP) {
      const la = parseFloat(lat.toFixed(4)), lo = parseFloat(lon.toFixed(4));
      const zipId   = findArea(lo, la, zipBboxed);
      const tractId = findArea(lo, la, tractBboxed);
      if (zipId || tractId) assignments.push({ lat: la, lon: lo, zipId, tractId });
    }
  }

  const BATCH = 100;
  const elevations = new Array(assignments.length).fill(null);
  const total = Math.ceil(assignments.length / BATCH);

  for (let i = 0; i < assignments.length; i += BATCH) {
    const bNum = Math.floor(i / BATCH) + 1;
    process.stdout.write(`  elevation batch ${bNum}/${total}...\r`);
    const batch = assignments.slice(i, i + BATCH);
    const locations = batch.map(p => `${p.lat},${p.lon}`).join('|');
    try {
      const data = await fetchJson('https://api.opentopodata.org/v1/srtm90m?locations=' + encodeURIComponent(locations));
      if (data.status === 'OK') data.results.forEach((r, j) => { if (r.elevation != null) elevations[i + j] = r.elevation; });
    } catch (e) { console.warn(`\n  OpenTopoData batch ${bNum}: ${e.message}`); }
    if (i + BATCH < assignments.length) await sleep(1100);
  }
  process.stdout.write('\n');

  const zipElevs = {}, tractElevs = {};
  assignments.forEach((p, i) => {
    const e = elevations[i];
    if (e == null) return;
    if (p.zipId)   { zipElevs[p.zipId]     = zipElevs[p.zipId]   || []; zipElevs[p.zipId].push(e); }
    if (p.tractId) { tractElevs[p.tractId] = tractElevs[p.tractId] || []; tractElevs[p.tractId].push(e); }
  });

  function toStats(elevMap) {
    const out = {};
    for (const [id, elevs] of Object.entries(elevMap)) {
      if (elevs.length < 2) { out[id] = { stdDev: null, mean: elevs[0] ?? null }; continue; }
      const mean     = elevs.reduce((a, b) => a + b, 0) / elevs.length;
      const variance = elevs.reduce((a, b) => a + (b - mean) ** 2, 0) / elevs.length;
      out[id] = { stdDev: parseFloat(Math.sqrt(variance).toFixed(2)), mean: parseFloat(mean.toFixed(1)) };
    }
    return out;
  }

  return { zipcodes: toStats(zipElevs), tracts: toStats(tractElevs) };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Step 1/6  Fetching ZIP boundary GeoJSON from TIGERweb...');
  const zipFeatures = await fetchZipFeatures();
  console.log(`          ${zipFeatures.length} ZIP polygons`);

  console.log('Step 2/6  Fetching Census Tract boundary GeoJSON from TIGERweb...');
  const tractFeatures = await fetchTractFeatures();
  console.log(`          ${tractFeatures.length} tract polygons`);

  const zipBboxed   = buildBboxed(zipFeatures);
  const tractBboxed = buildBboxed(tractFeatures);

  console.log('Step 3/6  Fetching OSM wheelchair-tagged buildings from Overpass...');
  const wheelchairEls = await overpassGet(`[out:json][timeout:90];(node["wheelchair"](${PITTSBURGH_BBOX});way["wheelchair"](${PITTSBURGH_BBOX}););out center;`);
  console.log(`          ${wheelchairEls.length} elements — assigning to areas...`);
  const osmWheelchair = {
    zipcodes: await computeOsmWheelchair(wheelchairEls, zipBboxed),
    tracts:   await computeOsmWheelchair(wheelchairEls, tractBboxed),
  };
  await sleep(2000);

  console.log('Step 4/6  Fetching transit stops from Overpass...');
  const transitEls = await overpassGet(`[out:json][timeout:90];(node["highway"="bus_stop"](${PITTSBURGH_BBOX}););out;`);
  console.log(`          ${transitEls.length} stops — assigning to areas...`);
  const transit = {
    zipcodes: await computeTransit(transitEls, zipBboxed),
    tracts:   await computeTransit(transitEls, tractBboxed),
  };

  console.log('Step 5/6  Fetching age 65+ data from Census Reporter...');
  const age65 = {
    zipcodes: await fetchAge65Zips(zipFeatures.map(f => f.id)),
    tracts:   await fetchAge65Tracts(),
  };
  console.log(`          ${Object.keys(age65.zipcodes).length} ZIPs, ${Object.keys(age65.tracts).length} tracts`);

  console.log('Step 6/6  Fetching terrain elevations (this takes ~2 min due to rate limiting)...');
  const terrain = await fetchTerrain(zipBboxed, tractBboxed);
  console.log(`          ${Object.keys(terrain.zipcodes).length} ZIPs, ${Object.keys(terrain.tracts).length} tracts`);

  const generated = new Date().toISOString();
  const payload   = { generated, osmWheelchair, transit, age65, terrain };
  const js = `// Auto-generated ${generated} -- re-run: node fetch-extra-data.js\nwindow.EXTRA_DATA = ${JSON.stringify(payload, null, 2)};\n`;
  writeFileSync('extra-data.js', js);

  console.log(`\nDone!  extra-data.js written`);
  console.log(`  OSM wheelchair: ${Object.keys(osmWheelchair.zipcodes).length} ZIPs`);
  console.log(`  Transit stops:  ${Object.keys(transit.zipcodes).length} ZIPs`);
  console.log(`  Age 65+:        ${Object.keys(age65.zipcodes).length} ZIPs`);
  console.log(`  Terrain:        ${Object.keys(terrain.zipcodes).length} ZIPs`);
}

main().catch(err => { console.error('\nFailed:', err.message); process.exit(1); });
