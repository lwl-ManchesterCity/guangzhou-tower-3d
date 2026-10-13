// 一次性取证：两档尺度要在能同时看出一辆轿车与一辆公交的层级上拍。动效关掉之后车停在出厂那一帧，
// 所以瞄准的坐标就是判据量到的那一辆的位置（`agentPosition(agent, 0)`）。
// 用法 `node scripts/shot-buses.mjs`，产物落 `docs/screenshots/canton-buses-<name>.png`。
import { chromium } from '@playwright/test';

const appUrl = process.env.APP_URL || 'http://127.0.0.1:5174';
const shots = [
  ['hero-day', '15.4/23.109/113.31913/-25/58', 'day', null],
  ['street-182', '18.2/23.10818/113.32034/-18/54', 'day', { x: 340, y: 300, width: 760, height: 520 }],
  ['street-176', '17.6/23.10961/113.32102/-18/54', 'day', { x: 340, y: 300, width: 760, height: 520 }],
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
  await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    if (neighborhood.motionStatus().on) neighborhood.setMotion(false);
  });
  await page.waitForTimeout(600);
  const state = await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const near = neighborhood.nearTraffic();
    return { zoom: +neighborhood.map.getZoom().toFixed(2), cars: near?.cars, walkers: near?.walkers, boost: near?.boost };
  });
  await page.screenshot({ path: `docs/screenshots/canton-buses-${name}.png`, ...(clip ? { clip } : {}) });
  console.log(name, JSON.stringify(state));
}
await browser.close();
