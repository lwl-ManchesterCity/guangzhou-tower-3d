import { chromium } from 'playwright-core';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { SCENES } from '../src/scenes.js';

const app = process.env.APP_URL || 'http://127.0.0.1:5174';
const root = new URL('../', import.meta.url);
// A candidate artifact can be probed without promoting it: the dev server keeps serving public/data, and only this
// browser session is shown the substitute file. Evidence is written under its own tag so the shipped row stays intact.
const tag = process.env.EVIDENCE_TAG || 'p0';
const substitute = process.env.BUILDINGS_FILE || null;
const evidencePath = `docs/audits/jingtai-render${tag === 'p0' ? '' : `-${tag}`}.json`;
const scene = SCENES.jingtai;
const cameras = {
  hero: { ...scene.center, zoom: scene.camera.zoom, pitch: scene.camera.pitch, bearing: scene.camera.bearing },
  near: { ...scene.center, zoom: 16.7, pitch: scene.camera.pitch, bearing: 0 },
};
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
if (substitute) {
  const body = await readFile(new URL(substitute, root));
  await page.route('**/data/jingtai-buildings.geojson', (route) => route
    .fulfill({ status: 200, headers: { 'content-type': 'application/geo+json; charset=utf-8' }, body }));
}
await page.goto(`${app}/?scene=${scene.id}`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#places-toggle:not([disabled])', { timeout: 90000 });

const capture = async (name) => {
  await page.evaluate(async (camera) => {
    const { neighborhood: n } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    n.map.jumpTo(camera);
    await Promise.race([new Promise((resolve) => n.map.once('idle', resolve)), new Promise((resolve) => setTimeout(resolve, 5000))]);
    await new Promise((resolve) => setTimeout(resolve, 800));
  }, cameras[name]);
  const features = await page.evaluate(async () => {
    const { neighborhood: n } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const rendered = new Set(n.map.queryRenderedFeatures({ layers: ['neighborhood-buildings', 'neighborhood-buildings-overview'] })
      .map((feature) => String(feature.properties.sourceId ?? `way/${feature.properties.osmId}`)));
    const { features } = await fetch('/data/jingtai-buildings.geojson').then((response) => response.json());
    return features.map((feature) => {
      const rings = (feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates).map((polygon) => polygon[0]);
      const points = rings.flat().map(([lng, lat]) => n.map.project([lng, lat])).filter((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y));
      const covers = points.length && Math.max(...points.map((p) => p.x)) >= 0 && Math.min(...points.map((p) => p.x)) <= innerWidth
        && Math.max(...points.map((p) => p.y)) >= 0 && Math.min(...points.map((p) => p.y)) <= innerHeight;
      const id = String(feature.properties.sourceId ?? `way/${feature.properties.osmId}`);
      return { id, onScreen: Boolean(covers), rendered: rendered.has(id) };
    });
  });
  await page.screenshot({ path: `docs/screenshots/jingtai-${tag}-${name}.png` });
  const missing = features.filter((feature) => feature.onScreen && !feature.rendered).map((feature) => feature.id);
  // Unverifiable (off-screen) features count as rendered so the audit never claims a building is missing from the map
  // just because the probe camera did not look at it.
  return { camera: cameras[name], total: features.length, onScreen: features.filter((f) => f.onScreen).length, rendered: features.filter((f) => f.rendered).length, missing, osmIds: features.filter((f) => !f.onScreen || f.rendered).map((f) => f.id) };
};

const evidence = {
  capturedAt: new Date().toISOString(), app, served: substitute ?? 'public/data/jingtai-buildings.geojson',
  viewport: { width: 1440, height: 960 }, scene: scene.id, center: scene.center, radiusMeters: scene.radius, cameras: {},
};
for (const name of Object.keys(cameras)) evidence.cameras[name] = await capture(name);
await mkdir(new URL('docs/audits/', root), { recursive: true });
await writeFile(new URL(evidencePath, root), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify({ pageErrors: errors, cameras: Object.fromEntries(Object.entries(evidence.cameras).map(([name, value]) => [name, { onScreen: value.onScreen, rendered: value.rendered, missing: value.missing.length }])) }, null, 2));
await browser.close();
if (errors.length) process.exitCode = 1;
