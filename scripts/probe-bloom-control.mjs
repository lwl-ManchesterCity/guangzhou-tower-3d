// 一次性：2 倍屏那一档要分清"链的钱"与"这一场本身的钱"——白昼不走链，作为控制组。
import { chromium } from '@playwright/test';
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
for (const factor of [1, 2]) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: factor });
  await page.goto('http://127.0.0.1:5174/?scene=canton&engine=three#map=15.5/23.1095/113.31913/-25/62');
  await page.waitForFunction(() => document.querySelector('.engine-stats')?.textContent?.includes('fps'), { timeout: 120000 });
  await page.evaluate(async () => {
    const { neighborhood: n } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    window.__n = n; n.setMotion(true);
  });
  await page.waitForTimeout(7000);
  const read = () => page.evaluate(() => {
    const text = document.querySelector('.engine-stats').textContent.replace(/\s+/g, ' ');
    return { fps: Number(/three ([\d.]+) fps/.exec(text)?.[1]), ms: Number(/最长帧 ([\d.]+) ms/.exec(text)?.[1]),
      calls: window.__n.counts().drawCalls, built: window.__n.counts().bloom?.built ?? null };
  });
  const day = await read();
  await page.locator('[data-atmosphere-option="night"]').click();
  await page.waitForTimeout(7000);
  const night = await read();
  console.log(`${factor} 倍屏｜白昼（不走链）${JSON.stringify(day)}｜夜景（走链）${JSON.stringify(night)}`);
  await page.close();
}
await browser.close();
