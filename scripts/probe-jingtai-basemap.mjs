import { chromium } from 'playwright-core';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Is the basemap actually more complete than the local snapshot near the school, and can its outlines be attributed?
// Two independent measures: identity (tile feature ids vs snapshot OSM ids at the source's native zoom) and area
// (point samples over both layers at the hero zoom). Read-only: nothing here merges or promotes tile data.
const app = process.env.APP_URL || 'http://127.0.0.1:5174';
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
await page.goto(`${app}/?scene=jingtai`);
await page.waitForSelector('#places-toggle:not([disabled])', { timeout: 90000 });

const result = await page.evaluate(async ({ app }) => {
  const { neighborhood: n } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
  const map = n.map;
  const snapshot = await (await fetch(`${app}/data/jingtai-buildings.geojson`)).json();
  const settle = async () => { await new Promise((resolve) => { if (map.isMoving()) map.once('idle', resolve); else resolve(); }); await new Promise((resolve) => setTimeout(resolve, 3000)); };
  const baseIds = map.getStyle().layers.filter((l) => l['source-layer'] === 'building' && l.type === 'fill').map((l) => l.id);
  const ownId = 'neighborhood-buildings';
  const source = map.getSource('openmaptiles');

  map.jumpTo({ center: [113.26646, 23.17107], zoom: 16.5, pitch: 0, bearing: 0 });
  await settle();
  // Self-check first: a point query must be point-scoped, otherwise every number below is meaningless.
  const campus = map.project([113.26646, 23.17107]);
  const atCampus = map.queryRenderedFeatures([campus.x, campus.y], { layers: [ownId] }).length;
  const atCampusGround = map.queryRenderedFeatures([campus.x, campus.y], { layers: ['school-campus'] }).length;
  const known = snapshot.features.find((f) => f.geometry.type === 'Polygon' && f.properties.distance > 100 && f.properties.distance < 600
    && (() => { const p = map.project(f.geometry.coordinates[0][0]); return p.x > 0 && p.x < innerWidth && p.y > 0 && p.y < innerHeight; })());
  const kp = map.project(known.geometry.coordinates[0][0]);
  const atKnown = map.queryRenderedFeatures([[kp.x - 3, kp.y - 3], [kp.x + 3, kp.y + 3]], { layers: [ownId] }).length;

  // Area: sample the screen and ask which layer covers each point.
  const step = 8;
  let baseCells = 0, ownCells = 0, bothCells = 0, total = 0;
  const gaps = [];
  for (let x = 0; x < innerWidth; x += step) for (let y = 0; y < innerHeight; y += step) {
    const point = [x, y];
    const base = map.queryRenderedFeatures(point, { layers: baseIds }).length > 0;
    const own = map.queryRenderedFeatures(point, { layers: [ownId] }).length > 0;
    if (!base && !own) continue;
    total++; baseCells += base ? 1 : 0; ownCells += own ? 1 : 0; bothCells += base && own ? 1 : 0;
    if (base && !own) gaps.push(map.unproject(point).toArray().map((v) => +v.toFixed(5)));
  }
  const area = { zoom: 16.5, step, sampledCells: total, baseCells, ownCells, bothCells, baseOnlyCells: gaps.length, gapSample: gaps.slice(0, 10) };

  // Identity at the source's native zoom, where tiles are not over-zoomed and the whole 2 km area is loaded.
  map.jumpTo({ center: [113.26646, 23.17107], zoom: source.maxzoom ?? 14, pitch: 0, bearing: 0 });
  await settle();
  const tiles = map.querySourceFeatures('openmaptiles', { sourceLayer: 'building' });
  const byId = new Map();
  for (const feature of tiles) if (!byId.has(feature.id)) byId.set(feature.id, feature);
  const numeric = (feature) => String(feature.properties.osmId).replace(/^\w+\//, '');
  const ownIds = new Set(snapshot.features.map(numeric));
  const decode = (id) => ({ id, osm: Math.floor(id / 10), height: byId.get(id).properties.render_height ?? null });
  const withId = [...byId.keys()].filter((id) => id != null).map(decode);
  const bounds = map.getBounds();
  const fullyInView = (feature) => (feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates)
    .every((rings) => rings.every((ring) => ring.every(([lng, lat]) => bounds.contains([lng, lat]))));
  const visible = snapshot.features.filter(fullyInView);
  const tileIds = new Set(withId.map((entry) => String(entry.osm)));
  return {
    source: { maxzoom: source.maxzoom ?? null, tiles: source.tiles ?? source.url ?? null, attribution: source.attribution ?? null },
    basemapFillLayers: baseIds,
    selfCheck: { campusBuildingHits: atCampus, campusGroundHits: atCampusGround, knownBuildingHits: atKnown },
    area,
    identity: {
      zoom: map.getZoom(), tileSourceFeatures: tiles.length, distinctIds: byId.size, withId: withId.length, withoutId: tiles.length - withId.length,
      matched: withId.filter((entry) => ownIds.has(String(entry.osm))).length,
      tileOnly: withId.filter((entry) => !ownIds.has(String(entry.osm))).slice(0, 20),
      snapshotInView: visible.length, snapshotNotInTiles: visible.filter((f) => !tileIds.has(numeric(f))).length,
      snapshotNotInTilesSample: visible.filter((f) => !tileIds.has(numeric(f))).slice(0, 12).map((f) => f.properties.osmId),
      propertyKeys: [...new Set(tiles.flatMap((f) => Object.keys(f.properties ?? {})))].sort(),
    },
  };
}, { app });

const pass = result.selfCheck.campusBuildingHits === 0 && result.selfCheck.campusGroundHits > 0 && result.selfCheck.knownBuildingHits > 0;
const payload = { capturedAt: new Date().toISOString(), app, probePassesSelfCheck: pass, ...result };
await writeFile(new URL('../docs/audits/jingtai-basemap.json', import.meta.url), `${JSON.stringify(payload, null, 2)}\n`);
// `new URL(...).pathname` percent-encodes the non-ASCII project directory, so Playwright would create a stray tree
// outside the repo instead of writing here.
await page.screenshot({ path: fileURLToPath(new URL('../docs/screenshots/jingtai-p1-basemap.png', import.meta.url)) });
console.log(JSON.stringify({ ...payload, identity: { ...payload.identity, tileOnly: payload.identity.tileOnly.length } }, null, 1));
await browser.close();
if (!pass) throw new Error('probe failed its own point-query self-check; the coverage numbers are unusable');
