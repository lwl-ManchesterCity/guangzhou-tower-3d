// 细节取证：立面图、广场地面图、夜景窗图这三张贴图各自要在能读出格子的层级上拍，才看得出"画了等于没画"的地板。
// 用法 `node scripts/shot-tower-facade.mjs`，产物落 `docs/screenshots/canton-v11-<name>.png`。
import { chromium } from '@playwright/test';

const appUrl = process.env.APP_URL || 'http://127.0.0.1:5174';
// 西塔 440.2 m、东塔 530 m，两栋的质心相距约 280 m；镜头要看的是立面，不是城市全景。
// hash 是 `zoom/lat/lng/bearing/pitch`；广场地面那一格自己设了 16.5 级的地板，所以拍它必须往上取。
const shots = [
  ['day-hero', '15.4/23.109/113.31913/-25/58', 'day', null],
  ['lamps-hero', '15.4/23.109/113.31913/-25/58', 'night', null],
  ['plaza-day-170', '17/23.11920/113.31930/180/55', 'day', { x: 420, y: 380, width: 760, height: 480 }],
  ['plaza-night-170', '17/23.11920/113.31930/180/55', 'night', { x: 420, y: 380, width: 760, height: 480 }],
  ['lamps-plaza', '16.4/23.12060/113.31930/180/52', 'night', null],
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
  // 只有 hash 变、URL 不变时 Playwright 不重新加载，而镜头只在初始化时读一次 hash。
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
  // 动效关掉再拍：江面那一格、车灯那一点都会随帧走，静止画面才是可比的证据。
  await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    if (neighborhood.motionStatus().on) neighborhood.setMotion(false);
  });
  await page.waitForTimeout(600);
  const state = await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const near = neighborhood.nearTraffic();
    const s = neighborhood.plazaState?.() ?? null;
    return { zoom: +neighborhood.map.getZoom().toFixed(2), mood: neighborhood.atmosphere.mood,
      ground: s?.ground, layers: s?.layers, stone: s?.surface?.counts.stone, wide: s?.surface?.wide, tall: s?.surface?.tall,
      cars: near?.cars, walkers: near?.walkers, lampsOn: near?.lamps, peopleOn: near?.people, boost: near?.boost };
  });
  await page.screenshot({ path: `docs/screenshots/canton-v11-${name}.png`, ...(clip ? { clip } : {}) });
  console.log(name, JSON.stringify(state));
}
await browser.close();
