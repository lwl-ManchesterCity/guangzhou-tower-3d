// 导览扩到八站之后的画面证据：每站一张桌面图，另加窄屏／横屏与两档氛围。
// 用的就是页面自己的 `#tour-next` 逐站走，不自己摆镜头——摆出来的构图不一定是用户点到的那个。
import { chromium } from '@playwright/test';

const app = process.env.APP_URL || 'http://127.0.0.1:5174';
const stops = [
  ['广州塔', 'canton-tour-tower'],
  ['海心桥', 'canton-tour-bridge'],
  ['花城广场', 'canton-tour-square'],
  ['广州图书馆', 'canton-tour-library'],
  ['广东省博物馆', 'canton-tour-museum'],
  ['广州西塔', 'canton-tour-west-tower'],
  ['广州东塔', 'canton-tour-east-tower'],
  ['猎德大桥', 'canton-tour-liede'],
];
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });

async function open(size) {
  const page = await browser.newPage({ viewport: size, deviceScaleFactor: 1 });
  page.on('pageerror', (error) => console.log('page error:', error.message));
  await page.goto(`${app}/?scene=canton`);
  await page.waitForSelector('#tour-start:not([disabled])', { timeout: 180000 });
  await page.waitForTimeout(2500);
  return page;
}

// 到站就是标题对了、并且镜头已经停下（拖动条不再走）——页面自己那条 `settled` 的判据在这里够用。
async function atStop(page, name) {
  await page.waitForFunction((want) => document.querySelector('#tour-title')?.textContent === want, name, { timeout: 30000 });
  await page.waitForTimeout(3200);
}

const page = await open({ width: 1440, height: 960 });
await page.locator('#tour-start').click();
for (const [index, [name, slug]] of stops.entries()) {
  await atStop(page, name);
  await page.screenshot({ path: `docs/screenshots/${slug}.png` });
  console.log(`· ${slug}.png`);
  if (index < stops.length - 1) await page.locator('#tour-next').click();
}

// 氛围两档：停在第 1 站，切完氛围再拍，证的是"这条导览在三种天色下都在走"。
await page.locator('#tour-previous').click();
for (let i = 0; i < stops.length - 1; i++) await page.locator('#tour-previous').click();
await atStop(page, stops[0][0]);
for (const [label, slug] of [['日落', 'canton-tour-sunset'], ['夜景', 'canton-tour-night']]) {
  await page.locator(`#atmosphere-controls [data-atmosphere-option="${label === '日落' ? 'sunset' : 'night'}"]`).click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `docs/screenshots/${slug}.png` });
  console.log(`· ${slug}.png`);
}
await page.setViewportSize({ width: 320, height: 568 });
await page.waitForTimeout(1200);
await page.screenshot({ path: 'docs/screenshots/canton-tour-night-320.png' });
console.log('· canton-tour-night-320.png');
await page.close();

for (const [size, slug] of [[{ width: 320, height: 568 }, 'canton-tour-mobile-320'], [{ width: 568, height: 320 }, 'canton-tour-landscape-568']]) {
  const narrow = await open(size);
  await narrow.locator('#tour-start').click();
  await atStop(narrow, stops[0][0]);
  await narrow.screenshot({ path: `docs/screenshots/${slug}.png` });
  console.log(`· ${slug}.png`);
  await narrow.close();
}

await browser.close();
