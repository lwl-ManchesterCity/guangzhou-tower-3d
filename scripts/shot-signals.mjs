// 一次性取证：路口那三层（杆 / 灯珠 / 停止线）要拍得出"它在画面里"。
// 机位钉在离塔 490 m 那个四杆路口（`scripts/probe-junction-view.mjs` 量的：113.31992/23.10466）。
// 用法 `node scripts/shot-signals.mjs`，产物落 `docs/screenshots/canton-signal-<name>.png`。
import { chromium } from '@playwright/test';

const appUrl = process.env.APP_URL || 'http://127.0.0.1:5174';
const CROSS = '18.4/23.10466/113.31992/0/52';
const HERO = '15.4/23.109/113.31913/-25/58';
const clip = { x: 380, y: 250, width: 700, height: 520 };
const shots = [
  ['hero-day', HERO, 'day', false, null],
  ['cross-day', CROSS, 'day', false, clip],
  ['cross-night', CROSS, 'night', false, clip],
  ['engine-cross-day', CROSS, 'day', true, clip],
  ['engine-cross-night', CROSS, 'night', true, clip],
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

for (const [name, view, atmosphere, engine, box] of shots) {
  const url = `${appUrl}/${engine ? '?engine=three' : ''}#map=${view}`;
  await page.goto(url, { waitUntil: 'load' });
  await page.reload({ waitUntil: 'load' });
  if (!engine) await idle(page, 20000);
  else await page.waitForTimeout(9000);
  await page.waitForTimeout(3000);
  const readout = await page.evaluate(async (id) => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    neighborhood.setAtmosphere(id);
    await new Promise((resolve) => setTimeout(resolve, 2200));
    neighborhood.map?.triggerRepaint?.();
    await new Promise((resolve) => setTimeout(resolve, 900));
    const near = neighborhood.nearTraffic?.() ?? null;
    // 场景里的灯：引擎那侧 `neighborhood.scene` 就是 THREE 场景，现版那侧从自定义 layer 的 source 里拿。
    let group = neighborhood.scene ?? null;
    if (!group && neighborhood.map) {
      for (const layer of neighborhood.map.getStyle().layers ?? []) {
        const source = neighborhood.map.getSource(layer.source);
        if (source?.neighborhood?.scene) { group = source.neighborhood.scene; break; }
      }
    }
    let signals = null;
    if (group?.traverse) group.traverse((object) => {
      if (object.name === 'traffic-signals') signals = object.children.map((child) => `${child.name}:${child.count}`);
    });
    return { near: near && { cars: near.cars, signal: near.signal }, signals };
  }, atmosphere);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `docs/screenshots/canton-signal-${name}.png`, ...(box ? { clip: box } : {}) });
  console.log(name, JSON.stringify(readout));
}
await browser.close();
