// One-off diagnostic: with the field radius at 1.5 km, is there still a lit street window the near-field test can
// grade outside it? Runs the test's own sweep twice - once from the shipped y floor of 240, once from 96 - and prints
// what each finds, so the bounds in `tests/browser.spec.js` are set from the frame rather than from a guess.
import { chromium } from '@playwright/test';

const appUrl = process.env.APP_URL || 'http://127.0.0.1:5174';
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
await page.goto(appUrl);
await page.waitForSelector('#places-toggle', { timeout: 60000 });
await page.waitForFunction(async () => {
  const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
  return neighborhood.map.loaded() && !neighborhood.map.isMoving();
}, null, { timeout: 60000 });
await page.evaluate(async () => {
  const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
  neighborhood.setAtmosphere('night', { instant: true });
});
await page.waitForTimeout(2000);

const out = await page.evaluate(async () => {
  const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
  const { distanceMeters } = await import('/src/geo.js');
  const { DEFAULT_CENTER } = await import('/src/config.js');
  const map = neighborhood.map;
  const canvas = map.getCanvas();
  const clear = (x, y) => { const node = document.elementFromPoint(x, y); return Boolean(node) && (node.id === 'map' || node.tagName === 'CANVAS'); };
  const ring = map.queryRenderedFeatures({ layers: ['canton-tower-hit'] }).flatMap(f => f.geometry?.type === 'Polygon' ? f.geometry.coordinates[0] : []);
  const points = ring.map(([lng, lat]) => map.project([lng, lat]));
  const shaft = points.length
    ? { left: Math.min(...points.map(p => p.x)) - 40, right: Math.max(...points.map(p => p.x)) + 40, top: Math.min(...points.map(p => p.y)) - 40, bottom: Math.max(...points.map(p => p.y)) + 40 }
    : null;
  const sweep = (width, height, min, max, yFrom) => {
    const found = [];
    for (let y = yFrom; y + height < canvas.clientHeight - 90; y += 10) {
      for (let x = 320; x + width < canvas.clientWidth - 40; x += 10) {
        const box = [[x, y], [x + width, y + height]];
        if (!map.queryRenderedFeatures(box, { layers: ['traffic-band'] }).length) continue;
        if (map.queryRenderedFeatures(box, { layers: ['river-surface', 'water'] }).length) continue;
        if (shaft && !(x + width < shaft.left || x > shaft.right || y + height < shaft.top || y > shaft.bottom)) continue;
        if (![[x + 8, y + 8], [x + width - 8, y + 8], [x + 8, y + height - 8], [x + width - 8, y + height - 8]]
          .every(([px, py]) => clear(px, py))) continue;
        const ground = map.unproject([x + width / 2, y + height / 2], 0);
        const metres = distanceMeters(DEFAULT_CENTER, { lat: ground.lat, lng: ground.lng });
        if (!Number.isFinite(metres) || metres < min || metres > max) continue;
        found.push({ x, y, width, height, metres: Math.round(metres) });
        if (found.length >= 3) return found;
      }
    }
    return found;
  };
  const probe = (yFrom) => ({
    near: sweep(200, 120, 300, 800, yFrom)[0] ?? null,
    far1700: sweep(200, 120, 1700, 3000, yFrom),
    far1550: sweep(200, 120, 1550, 3000, yFrom)[0] ?? null,
    smallestFar: sweep(100, 70, 1700, 3000, yFrom)[0] ?? null,
  });
  return { from240: probe(240), from96: probe(96), shaft };
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
