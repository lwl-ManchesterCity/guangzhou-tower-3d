// 一次性取证：三种树冠要在能读出剪影的层级上拍，并排看才是"三种树"而不是"一顶冠换三个颜色"。
// 用法 `node scripts/shot-species.mjs`，产物落 `docs/screenshots/canton-species-<name>.png`。
import { chromium } from '@playwright/test';

const appUrl = process.env.APP_URL || 'http://127.0.0.1:5174';
// hash 是 `zoom/lat/lng/bearing/pitch`。三个点位都是按树的位置量出来的：广场那一格 120 m 里三种都有，
// 海风路那一片 150 m 里 27 株棕榈，默认机位负责"整片近场的树读不读得出层次"。
const shots = [
  ['hero-day', '15.4/23.109/113.31913/-25/58', 'day', null],
  ['plaza-mixed', '17.2/23.11656/113.31910/-20/56', 'day', { x: 340, y: 300, width: 760, height: 520 }],
  ['palms-172', '17.2/23.11594/113.32358/-20/56', 'day', { x: 340, y: 300, width: 760, height: 520 }],
  ['palms-184', '18.4/23.11594/113.32358/-20/52', 'day', { x: 340, y: 300, width: 760, height: 520 }],
  ['hero-night', '15.4/23.109/113.31913/-25/58', 'night', null],
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

for (const [name, map, atmosphere, clip] of shots) {
  await page.goto(`${appUrl}/#map=${map}`, { waitUntil: 'load' });
  await page.reload({ waitUntil: 'load' });
  await idle(page, 20000);
  await page.waitForTimeout(3000);
  await page.evaluate(async (id) => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    neighborhood.setAtmosphere(id);
    await new Promise((resolve) => setTimeout(resolve, 2200));
    neighborhood.map.triggerRepaint();
  }, atmosphere);
  await page.waitForTimeout(900);
  await idle(page);
  // 动效关掉再拍：车灯与江面会随帧走，静止画面才是可比的证据。
  await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    if (neighborhood.motionStatus().on) neighborhood.setMotion(false);
  });
  await page.waitForTimeout(600);
  const state = await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    return { zoom: +neighborhood.map.getZoom().toFixed(2), mood: neighborhood.atmosphere.mood,
      motion: neighborhood.motionStatus().on, lens: neighborhood.lens.mode };
  });
  await page.screenshot({ path: `docs/screenshots/canton-species-${name}.png`, ...(clip ? { clip } : {}) });
  console.log(name, JSON.stringify(state));
}
await browser.close();
