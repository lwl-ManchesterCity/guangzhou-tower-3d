// 一次性：把江面那层波光的格子拍成能看的图——现版与引擎各在 bearing 0 / −30 取一小块水面，
// 用来肉眼确认"格子跟地面转"还是"跟画布转"，以及两边的屏幕尺度是不是一个量级。
import { writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
const app = process.env.APP_URL || 'http://127.0.0.1:5174';
const CLIP = { x: 560, y: 470, width: 260, height: 150 };
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });

async function open(engine) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
  page.on('pageerror', (error) => console.log(`[${engine}] page error:`, error.message));
  await page.goto(`${app}/?scene=canton&motion=off${engine === 'three' ? '&engine=three' : ''}#map=16/23.1095/113.3245/0/60`);
  if (engine === 'three') await page.waitForFunction(() => document.querySelector('.engine-stats')?.textContent?.includes('fps'), { timeout: 120000 });
  else await page.waitForSelector('#places-toggle:not([disabled])', { timeout: 180000 });
  await page.waitForTimeout(1800);
  await page.evaluate(async () => {
    const { neighborhood: n } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    window.__probe = { n };
  });
  return page;
}

for (const engine of ['legacy', 'three']) {
  const page = await open(engine);
  for (const bearing of [0, -30]) {
    await page.evaluate(async ({ b, engine }) => {
      const n = window.__probe.n;
      if (engine === 'three') {
        n.setView({ ...n.view(), bearing: b });
        await new Promise((resolve) => setTimeout(resolve, 900));
      } else {
        n.map.jumpTo({ bearing: b });
        await new Promise((resolve) => { n.map.once('idle', resolve); n.map.triggerRepaint(); });
        await new Promise((resolve) => setTimeout(resolve, 600));
      }
    }, { b: bearing, engine });
    const state = await page.evaluate((engine) => (engine === 'three'
      ? { river: window.__probe.n.counts().river, bearing: window.__probe.n.view().bearing }
      : { bearing: window.__probe.n.map.getBearing() }), engine);
    writeFileSync(`shots/river-anchor-${engine}-${bearing}.png`, await page.screenshot({ clip: CLIP }));
    console.log(engine, bearing, JSON.stringify(state));
  }
  await page.context().close();
}
await browser.close();
