// 同一机位夜景，两边各拍一张，不比"关掉某层差多少"（现版那侧一碰 pattern 图层就重图集，差的是整张图），
// 只比绝对亮度分布：亮像素的个数与分位数。
import { chromium } from '@playwright/test';
const app = process.env.APP_URL || 'http://127.0.0.1:5174';
const crop = { x: 360, y: 220, width: 720, height: 460 };
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const stats = async (page, label) => {
  const source = (await page.screenshot({ clip: crop })).toString('base64');
  return page.evaluate(async ({ source, label }) => {
    const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${source}`)).blob());
    const buffer = new OffscreenCanvas(image.width, image.height);
    const context = buffer.getContext('2d');
    context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, image.width, image.height).data;
    const lumas = [];
    for (let i = 0; i < data.length; i += 4) lumas.push(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    lumas.sort((a, b) => a - b);
    const at = (share) => Math.round(lumas[Math.floor(lumas.length * share)] * 10) / 10;
    const count = (floor) => lumas.filter((value) => value > floor).length;
    return { label, median: at(0.5), p90: at(0.9), p99: at(0.99), p999: at(0.999), max: at(1),
      over80: count(80), over120: count(120), over180: count(180) };
  }, { source, label });
};
const engine = await browser.newPage({ viewport: { width: 1440, height: 960 } });
await engine.goto(`${app}/?scene=canton&engine=three#map=15.5/23.1095/113.31913/-25/62`);
await engine.waitForFunction(() => document.querySelector('.engine-stats')?.textContent?.includes('fps'), { timeout: 120000 });
await engine.locator('[data-atmosphere-option="night"]').click();
await engine.waitForTimeout(1500);
console.log(JSON.stringify(await stats(engine, '新引擎')));
const legacy = await browser.newPage({ viewport: { width: 1440, height: 960 } });
await legacy.goto(`${app}/?scene=canton#map=15.5/23.1095/113.31913/-25/62`);
await legacy.waitForSelector('#places-toggle:not([disabled])', { timeout: 180000 });
await legacy.locator('[data-atmosphere-option="night"]').click();
await legacy.locator('#motion-toggle').click();
await legacy.waitForTimeout(2500);
console.log(JSON.stringify(await stats(legacy, '现版')));
await browser.close();
