// 一次性：#189 的画面证据——江面那层波光在新引擎里长什么样，与关掉它差多少。
// 三张：① 新引擎开屏夜景（整幅）；② 新引擎 17.6 级压着水面看那一张格子；③ 同一机位关掉这一层作对照。
// 第四张给现版那侧同一处水面的近看（取景不做逐像素对齐：现版带着 setPadding，见 #191）。
import { writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const app = process.env.APP_URL || 'http://127.0.0.1:5174';
const CLOSE = { lat: 23.1128, lng: 113.3268, zoom: 17.6, pitch: 62, bearing: -12 };
const CLIP = { x: 300, y: 380, width: 560, height: 320 };
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });

const hidePanel = (page, hidden) => page.evaluate((hidden) => {
  const panel = document.querySelector('.engine-stats');
  if (panel) panel.style.visibility = hidden ? 'hidden' : '';
}, hidden);

async function open(engine, view) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
  page.on('pageerror', (error) => console.log(`[${engine}] page error:`, error.message));
  const hash = `#map=${view.zoom}/${view.lat}/${view.lng}/${view.bearing}/${view.pitch}`;
  await page.goto(`${app}/?scene=canton&motion=off${engine === 'three' ? '&engine=three' : ''}${hash}`);
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
  // 氛围没有 URL 口径（`document.body.dataset.atmosphere` 是 index.html 写死的），所以按界面上那颗按钮走。
  await page.evaluate(() => document.querySelector('[data-atmosphere-option="night"]').click());
  await page.waitForTimeout(1400);
  return page;
}

const save = async (page, name, clip) => {
  writeFileSync(`docs/screenshots/${name}.png`, await page.screenshot(clip ? { clip } : {}));
  console.log(`· ${name}.png`);
};

const hero = await open('three', { lat: 23.1105, lng: 113.3205, zoom: 15.5, pitch: 58, bearing: -25 });
await hidePanel(hero, false);
await save(hero, 'canton-river-engine-hero-night');
await hero.context().close();

const close = await open('three', CLOSE);
await hidePanel(close, true);
await save(close, 'canton-river-engine-close-176', CLIP);
await close.evaluate(() => {
  let mesh = null;
  window.__probe.n.scene.traverse((object) => { if (object.name === 'river-sheen-water') mesh = object; });
  mesh.visible = false;
});
await close.evaluate(() => new Promise((resolve) => setTimeout(resolve, 600)));
await save(close, 'canton-river-engine-close-176-off', CLIP);
await close.context().close();

const legacy = await open('legacy', CLOSE);
await hidePanel(legacy, true);
await save(legacy, 'canton-river-legacy-close-176', CLIP);
await legacy.context().close();

await browser.close();
