// 一次性：夜景里"画面最亮的那一格"在两台引擎里各是多少灰阶、在哪（#190 撞红的那 575 颗过曝像素归谁）。
// 泛光的阈值分不开塔腰与灯芯（阈值抬到 0.8 时整幅一颗都不晕了），所以先要弄清：新引擎里那根塔是不是本来就比现版亮。
// 两边都关掉泛光（引擎侧 share 0）、按住动效、切夜景，读整幅亮度分布 + 最亮那颗像素的位置。
import { writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
const app = process.env.APP_URL || 'http://127.0.0.1:5174';
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });

const census = async (page, label) => {
  const clip = await page.evaluate(() => {
    const box = document.querySelector('canvas').getBoundingClientRect();
    return { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
  });
  const shot = (await page.screenshot({ clip })).toString('base64');
  writeFileSync(`/tmp/tower-luma-${label}.png`, Buffer.from(shot, 'base64'));
  return page.evaluate(async (b64) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    const lum = new Float32Array(bitmap.width * bitmap.height);
    for (let i = 0; i < lum.length; i++) lum[i] = 0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2];
    const sorted = Float32Array.from(lum).sort();
    let worst = 0, at = -1;
    for (let i = 0; i < lum.length; i++) if (lum[i] > worst) { worst = lum[i]; at = i; }
    return { pixels: lum.length, median: +sorted[sorted.length >> 1].toFixed(1),
      p999: +sorted[Math.floor(sorted.length * 0.999)].toFixed(1), max: +worst.toFixed(1),
      argmax: [at % bitmap.width, Math.floor(at / bitmap.width)],
      over200: sorted.filter((v) => v >= 200).length, over250: sorted.filter((v) => v >= 250).length };
  }, shot);
};

for (const engine of ['legacy', 'three']) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
  page.on('pageerror', (error) => console.log('page error:', error.message));
  await page.goto(`${app}/?engine=${engine}#map=15.5/23.1095/113.31913/-25/62`);
  if (engine === 'three') {
    await page.waitForFunction(() => document.querySelector('.engine-stats')?.textContent?.includes('fps'), { timeout: 180000 });
  } else {
    await page.waitForFunction(() => document.querySelector('#atmosphere-controls button:not([disabled])') !== null, { timeout: 180000 });
  }
  await page.waitForTimeout(4000);
  await page.locator('[data-atmosphere-option="night"]').click();
  await page.waitForTimeout(3500);
  if (engine === 'three') {
    await page.evaluate(async () => {
      const { neighborhood: n } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
      n.setMotion(false);
      n.setBloom(0);
    });
  } else {
    console.log('  现版那侧 setMotion：', await page.evaluate(async () => {
      const { neighborhood: n } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
      try {
        n.setMotion(false);
        return '已关';
      } catch (error) {
        return `没有这个口令（${error.message}），这一格按动效在跑读`;
      }
    }));
  }
  await page.waitForTimeout(1200);
  console.log(`${engine}（关泛光）：`, JSON.stringify(await census(page, engine)));
  await page.close();
}
await browser.close();
