// #191 的画面证据：同一串 hash、同一个视口，两个引擎框出同一张画面。
// 四张两对：桌面 1440×960 与竖屏 390×844 各一对（现版 / 新引擎）。改之前那两对的横向差是 140 px、纵向 70 px。
import { chromium } from '@playwright/test';

const app = process.env.APP_URL || 'http://127.0.0.1:5174';
const HASH = '#map=15.5/23.1095/113.31913/-25/62';
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });

async function open(engine, size) {
  const page = await browser.newPage({ viewport: size, deviceScaleFactor: 1 });
  page.on('pageerror', (error) => console.log(`[${engine}] page error:`, error.message));
  await page.goto(`${app}/?scene=canton${engine === 'three' ? '&engine=three' : ''}${HASH}`);
  if (engine === 'three') {
    await page.waitForFunction(() => document.querySelector('.engine-stats')?.textContent?.includes('fps'), { timeout: 120000 });
  } else {
    await page.waitForSelector('#places-toggle:not([disabled])', { timeout: 180000 });
  }
  await page.waitForTimeout(3000);
  // 动效按住、读数面板藏掉：两对图要比的是画面，不是 FPS 那几行字。
  await page.evaluate(async () => {
    const { neighborhood: n } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    n.setMotion(false);
    const panel = document.querySelector('.engine-stats');
    if (panel) panel.style.visibility = 'hidden';
  });
  await page.waitForTimeout(900);
  return page;
}

for (const size of [{ width: 1440, height: 960 }, { width: 390, height: 844 }]) {
  const tag = size.width === 1440 ? '1440' : '390';
  for (const engine of ['maplibre', 'three']) {
    const page = await open(engine, size);
    const name = `canton-padding-${engine === 'three' ? 'engine' : 'legacy'}-${tag}`;
    await page.screenshot({ path: `docs/screenshots/${name}.png` });
    console.log(`· ${name}.png`);
    await page.close();
  }
}
await browser.close();
