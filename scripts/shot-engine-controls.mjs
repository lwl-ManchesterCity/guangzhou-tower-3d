// 一次性：新引擎那一侧补的控件与边界说明，拍两张入库图（1440 与 375）。
import { chromium } from '@playwright/test';
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
await page.goto('http://127.0.0.1:5174/?engine=three#map=15.5/23.1095/113.31913/-25/62');
await page.waitForFunction(() => document.querySelector('.engine-stats')?.textContent?.includes('fps'), { timeout: 120000 });
await page.waitForTimeout(6000);
await page.screenshot({ path: 'docs/screenshots/engine-controls-1440.png' });
await page.setViewportSize({ width: 375, height: 812 });
await page.waitForTimeout(1500);
await page.screenshot({ path: 'docs/screenshots/engine-controls-375.png' });
await browser.close();
console.log('ok');
