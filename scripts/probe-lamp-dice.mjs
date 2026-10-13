import { chromium } from '@playwright/test';
const app = 'http://127.0.0.1:5174';
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
await page.goto(`${app}/?scene=canton&atmosphere=night#map=15.5/23.1095/113.31913/-25/62`);
await page.waitForSelector('#places-toggle:not([disabled])', { timeout: 180000 });
await page.locator('[data-atmosphere-option="night"]').click();
await page.waitForTimeout(3000);
const out = await page.evaluate(async () => {
  const { neighborhood: n } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
  const feats = n.map.querySourceFeatures('canton-buildings');
  const ids = new Set(feats.map(f => f.properties?.osmId));
  const num = [...ids].map(v => Number(v)).filter(Number.isFinite);
  const count = (m, r) => num.filter(id => Math.abs(id) % m === r).length;
  return { features: feats.length, distinct: ids.size, numeric: num.length, sample: [...ids].slice(0, 3),
    dark11_7: count(11, 7), breath17_5: count(17, 5), group0: count(2, 0),
    glow: n.map.getStyle().layers.filter(l => l.id.startsWith('building-glow')).map(l => ({ id: l.id, filter: n.map.getFilter(l.id) })) };
});
console.log(JSON.stringify(out, null, 1).slice(0, 1800));
await browser.close();
