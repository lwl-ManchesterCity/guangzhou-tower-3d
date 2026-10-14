// 一次性：三组泛光参数各拍一对（开屏夜景 + 灯芯近景），用眼睛判"塔腰的格子还在不在、车头灯还是不是灯"。
// 数已经在 `probe-bloom-rescan.mjs` 里扫过了；这一支只出图。
import { writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
const app = process.env.APP_URL || 'http://127.0.0.1:5174';
const TUNES = [
  { id: 't030s075r04', threshold: 0.3, strength: 0.75, radius: 0.4 },
  { id: 't050s075r04', threshold: 0.5, strength: 0.75, radius: 0.4 },
  { id: 't065s050r04', threshold: 0.65, strength: 0.5, radius: 0.4 },
];
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
page.on('pageerror', (error) => console.log('page error:', error.message));
await page.goto(`${app}/?engine=three#map=15.5/23.1095/113.31913/-25/62`);
await page.waitForFunction(() => document.querySelector('.engine-stats')?.textContent?.includes('fps'), { timeout: 180000 });
await page.waitForTimeout(3000);
await page.evaluate(async () => {
  const { neighborhood: n } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
  window.__n = n;
  n.setMotion(false);
});
await page.locator('[data-atmosphere-option="night"]').click();
await page.waitForTimeout(3000);
for (const tune of TUNES) {
  await page.evaluate(async (value) => {
    window.__n.setBloom(value);
    window.__n.setBloom(1);
    await new Promise((resolve) => setTimeout(resolve, 900));
  }, { threshold: tune.threshold, strength: tune.strength, radius: tune.radius });
  writeFileSync(`/tmp/bloom-${tune.id}-hero.png`, await page.screenshot({ clip: { x: 0, y: 0, width: 1440, height: 960 } }));
  // 灯芯近景：18.4 级压着路口，车头灯那几颗是这一条链原本要服务的东西。
  await page.evaluate(async () => {
    window.__n.setView({ ...window.__n.view(), zoom: 18.4, pitch: 58, center: { lat: 23.1178, lng: 113.3185 } });
    await new Promise((resolve) => setTimeout(resolve, 1600));
  });
  writeFileSync(`/tmp/bloom-${tune.id}-lamps.png`, await page.screenshot({ clip: { x: 0, y: 0, width: 1440, height: 960 } }));
  await page.evaluate(async () => {
    window.__n.setView({ ...window.__n.view(), zoom: 15.5, pitch: 62, bearing: -25, center: { lat: 23.1095, lng: 113.31913 } });
    await new Promise((resolve) => setTimeout(resolve, 1600));
  });
  console.log('已拍', tune.id);
}
await browser.close();
