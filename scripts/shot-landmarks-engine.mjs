// 一次性：#190 的画面证据——地标那一整批资产（三塔壳体＋广州塔网格＋海心桥＋光柱＋三条落水带）进新引擎。
// 五张：① 新引擎夜景开屏；② 同一机位白昼；③ 白昼把这一层摘掉（看它到底画了什么）；
// ④ 夜景塔冠近景（塔腰的格子读得出来＝这一层不吃泛光那一格的画面证据）；⑤ 现版那侧同一机位作对照
// （取景不逐像素对齐：现版带着 `setPadding`，见 #191）。
import { chromium } from '@playwright/test';

const app = process.env.APP_URL || 'http://127.0.0.1:5174';
const HERO = { lat: 23.1095, lng: 113.31913, zoom: 15.5, pitch: 62, bearing: -25 };
const TOWER = { lat: 23.1108, lng: 113.31913, zoom: 17.2, pitch: 58, bearing: -8 };
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });

async function open(engine, view, atmosphere) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
  page.on('pageerror', (error) => console.log(`[${engine}] page error:`, error.message));
  const hash = `#map=${view.zoom}/${view.lat}/${view.lng}/${view.bearing}/${view.pitch}`;
  await page.goto(`${app}/?scene=canton${engine === 'three' ? '&engine=three' : ''}${hash}`);
  if (engine === 'three') {
    await page.waitForFunction(() => document.querySelector('.engine-stats')?.textContent?.includes('fps'), { timeout: 120000 });
  } else {
    await page.waitForSelector('#places-toggle:not([disabled])', { timeout: 180000 });
  }
  await page.waitForTimeout(2500);
  await page.evaluate(async () => {
    const { neighborhood: n } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    window.__probe = { n };
    n.setMotion(false);
  });
  await page.evaluate((id) => document.querySelector(`[data-atmosphere-option="${id}"]`).click(), atmosphere);
  await page.waitForTimeout(atmosphere === 'night' ? 2600 : 1400);
  return page;
}

const save = async (page, name) => {
  await page.screenshot({ path: `docs/screenshots/${name}.png` });
  console.log(`· ${name}.png`);
};
const hideLayer = (page, visible) => page.evaluate((visible) => {
  let node = null;
  window.__probe.n.scene.traverse((object) => { if (object.name === 'landmarks') node = object; });
  node.visible = visible;
}, visible);

const night = await open('three', HERO, 'night');
await save(night, 'canton-landmarks-engine-night');
await night.context().close();

const day = await open('three', HERO, 'day');
await save(day, 'canton-landmarks-engine-day');
await day.evaluate(() => { document.querySelector('.engine-stats').style.visibility = 'hidden'; });
await hideLayer(day, false);
await day.waitForTimeout(900);
await save(day, 'canton-landmarks-engine-day-off');
await day.context().close();

const crown = await open('three', TOWER, 'night');
await crown.evaluate(() => { document.querySelector('.engine-stats').style.visibility = 'hidden'; });
await save(crown, 'canton-landmarks-engine-tower-night');
await crown.context().close();

const legacy = await open('legacy', HERO, 'night');
await save(legacy, 'canton-landmarks-legacy-night');
await legacy.context().close();

await browser.close();
