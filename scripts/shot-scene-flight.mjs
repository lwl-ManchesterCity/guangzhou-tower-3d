// V4-8 接力的三张取证图：开屏、起飞那一格（街区缩成圆盘）、落到对面那页之后的默认机位。
//   node scripts/shot-scene-flight.mjs        # 存进 docs/screenshots/v8-scene-flight-*.png
// 与 tests/jingtai.browser.spec.js 那一项读同一套 API（`liftOff` / `relayView`），所以图里的画面与判据量的是同一格。
import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const app = process.env.APP_URL || 'http://127.0.0.1:5174';
const out = name => fileURLToPath(new URL(`../docs/screenshots/${name}.png`, import.meta.url));
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });

const ready = async () => {
  await page.waitForSelector('#places-toggle:not([disabled])', { timeout: 180000 });
  await page.waitForFunction(async () => {
    const { neighborhood: n } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    return n.map.loaded() && !n.map.isMoving();
  }, null, { timeout: 90000 });
};

await page.goto(`${app}/?scene=canton`);
await ready();
await page.screenshot({ path: out('v8-scene-flight-1-canton') });
const lifted = await page.evaluate(async () => {
  const { neighborhood: n } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
  const { relayView, FLY_OUT_MS } = await import('/src/scene-flight.js');
  const { SCENES } = await import('/src/scenes.js');
  await n.liftOff(relayView(SCENES.canton), FLY_OUT_MS);
  return { zoom: Math.round(n.map.getZoom() * 100) / 100, pitch: n.map.getPitch() };
});
await page.screenshot({ path: out('v8-scene-flight-2-liftoff') });

// 换页由链接自己完成（点一次顶栏那条 jingtai 链接），落地那侧要等降落飞完再拍。
await page.evaluate(() => sessionStorage.removeItem('neighborhood.scene-flight'));
await page.locator('#scene-nav a[href="?scene=jingtai"]').click();
await page.waitForURL(/scene=jingtai/, { timeout: 60000 });
await ready();
await page.screenshot({ path: out('v8-scene-flight-3-jingtai') });
const landed = await page.evaluate(async () => {
  const { neighborhood: n } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
  return { zoom: Math.round(n.map.getZoom() * 100) / 100, pitch: Math.round(n.map.getPitch() * 10) / 10 };
});
await browser.close();
console.log(`起飞那一格 ${JSON.stringify(lifted)}，落地 ${JSON.stringify(landed)}；三张图在 docs/screenshots/v8-scene-flight-*.png`);
