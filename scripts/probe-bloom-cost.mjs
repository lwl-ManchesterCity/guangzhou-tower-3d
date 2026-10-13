// 一次性：泛光在 1 倍屏与 2 倍屏上各值多少帧时间（动效开着，读面板那两格）。
import { chromium } from '@playwright/test';
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
for (const factor of [1, 2]) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: factor });
  await page.goto('http://127.0.0.1:5174/?scene=canton&engine=three#map=15.5/23.1095/113.31913/-25/62');
  await page.waitForFunction(() => document.querySelector('.engine-stats')?.textContent?.includes('fps'), { timeout: 120000 });
  await page.evaluate(async () => {
    const { neighborhood: n } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    window.__n = n;
  });
  await page.locator('[data-atmosphere-option="night"]').click();
  await page.waitForTimeout(3000);
  const row = {};
  for (const [label, share] of [['不加晕', 0], ['满档', 1]]) {
    await page.evaluate((value) => { window.__n.setBloom(value); window.__n.setMotion(true); }, share);
    await page.waitForTimeout(7000);
    row[label] = await page.evaluate(() => {
      const text = document.querySelector('.engine-stats').textContent.replace(/\s+/g, ' ');
      const counts = window.__n.counts();
      return { fps: Number(/three ([\d.]+) fps/.exec(text)?.[1]), ms: Number(/最长帧 ([\d.]+) ms/.exec(text)?.[1]),
        drawCalls: counts.drawCalls, size: counts.bloom?.size };
    });
  }
  console.log(`${factor} 倍屏（缓冲 ${JSON.stringify(row['满档'].size)}）：`, JSON.stringify(row));
  await page.close();
}
await browser.close();
