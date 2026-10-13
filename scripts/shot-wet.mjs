// 一次性取证：近岸那一圈湿线要在能同时看出"水、边、岸"的层级上拍，才看得出它是湿线而不是一条描边。
// 机位钉在离塔 145 m 的那一段实测岸线（`scripts/probe-shore.mjs` 量的），镜头朝北、压着水面看。
// 用法 `node scripts/shot-wet.mjs`，产物落 `docs/screenshots/canton-wet-<name>.png`。
import { chromium } from '@playwright/test';

const appUrl = process.env.APP_URL || 'http://127.0.0.1:5174';
const shots = [
  ['quay-176', '17.6/23.11026/113.31951/0/50', 'day', false, { x: 340, y: 240, width: 760, height: 560 }],
  ['quay-184', '18.4/23.11026/113.31951/0/46', 'day', false, { x: 340, y: 240, width: 760, height: 560 }],
  ['hero-day', '15.4/23.109/113.31913/-25/58', 'day', false, null],
  ['engine-quay-176', '17.6/23.11026/113.31951/0/50', 'day', true, { x: 340, y: 240, width: 760, height: 560 }],
];

const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 960, deviceScaleFactor: 2 } });
page.on('console', (message) => { if (message.type() === 'error') console.log('console error:', message.text()); });

const idle = async (target, ms = 4000) => target.evaluate(async (limit) => {
  const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
  await Promise.race([
    new Promise((resolve) => neighborhood.map.once('idle', resolve)),
    new Promise((resolve) => setTimeout(resolve, limit)),
  ]);
}, ms);

for (const [name, view, atmosphere, engine, clip] of shots) {
  const url = `${appUrl}/${engine ? '?engine=three' : ''}#map=${view}`;
  await page.goto(url, { waitUntil: 'load' });
  await page.reload({ waitUntil: 'load' });
  if (!engine) await idle(page, 20000);
  else await page.waitForTimeout(9000);
  await page.waitForTimeout(3000);
  if (!engine) {
    await page.evaluate(async (id) => {
      const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
      neighborhood.setAtmosphere(id);
      await new Promise((resolve) => setTimeout(resolve, 2200));
      neighborhood.map.triggerRepaint();
    }, atmosphere);
    await page.waitForTimeout(900);
    await idle(page);
    await page.evaluate(async () => {
      const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
      if (neighborhood.motionStatus().on) neighborhood.setMotion(false);
    });
  }
  await page.waitForTimeout(600);
  const state = await page.evaluate(() => ({ engine: new URLSearchParams(location.search).get('engine') ?? 'maplibre', view: location.hash }));
  await page.screenshot({ path: `docs/screenshots/canton-wet-${name}.png`, ...(clip ? { clip } : {}) });
  console.log(name, JSON.stringify(state));
}
await browser.close();
