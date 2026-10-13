// 一次性：引擎那侧的 `renderer.getPixelRatio()` 为什么是 1（页面 deviceScaleFactor 给的是 2）。
import { chromium } from '@playwright/test';
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
for (const factor of [2, 1]) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: factor });
  await page.goto(`http://127.0.0.1:5174/?engine=three#map=15.4/23.109/113.31913/-25/58`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelector('.engine-stats')?.textContent?.includes('fps'), { timeout: 120000 });
  console.log(factor, JSON.stringify(await page.evaluate(async () => {
    const { neighborhood: n } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const canvas = document.querySelector('.engine-canvas');
    return { dpr: globalThis.devicePixelRatio, css: [canvas.clientWidth, canvas.clientHeight], buffer: [canvas.width, canvas.height],
      bloom: n.bloomState?.() ?? null, counts: n.counts?.().bloom ?? null };
  })));
  await page.close();
}
await browser.close();
