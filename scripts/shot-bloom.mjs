// 一次性：泛光的取证与代价。同一机位拍"不加晕 / 三档候选"，再单独量一次开动效时的 fps 与最长帧
// （逐像素分析会让页面停下来，所以那一格必须另开一次量，不能顺手从取证那一趟里读）。
import { chromium } from '@playwright/test';

const app = process.env.APP_URL || 'http://127.0.0.1:5174';
const HERO = '#map=15.4/23.109/113.31913/-25/58';
const CROSS = '#map=18.4/23.10466/113.31992/0/52';
// 门槛 0.30 是扫出来的那一档（0.13 会把整幅底噪抬 8~15 个灰度，0.45 基本没东西起晕）。
const CANDIDATES = [
  ['tight', { strength: 0.7, radius: 0.25, threshold: 0.3 }],
  ['mid', { strength: 0.75, radius: 0.4, threshold: 0.3 }],
  ['wide', { strength: 0.8, radius: 0.6, threshold: 0.3 }],
];
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 960, deviceScaleFactor: 2 } });
page.on('pageerror', (error) => console.log('page error:', error.message));

const boot = async (camera, engine) => {
  await page.goto(`${app}/${engine ? '?engine=three' : ''}${camera}`, { waitUntil: 'load' });
  await page.reload({ waitUntil: 'load' });
  if (engine) {
    await page.waitForFunction(() => document.querySelector('.engine-stats')?.textContent?.includes('fps'), { timeout: 120000 });
  } else {
    // 现版那一侧没有 `.engine-stats`：它就绪的标志是控件解禁。
    await page.waitForFunction(() => !document.querySelector('#places-toggle')?.disabled, { timeout: 120000 });
  }
  await page.waitForTimeout(6000);
  await page.locator('[data-atmosphere-option="night"]').click();
  await page.waitForTimeout(3000);
  await page.evaluate(async () => {
    const { neighborhood: n } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    window.__n = n;
  });
};

for (const [label, camera] of [['hero', HERO], ['cross', CROSS]]) {
  await boot(camera, true);
  await page.evaluate(() => window.__n.setBloom(0));
  await page.waitForTimeout(900);
  await page.screenshot({ path: `docs/screenshots/canton-bloom-${label}-off.png` });
  for (const [name, tune] of CANDIDATES) {
    // 先给满档再改那三个数：`setBloom(对象)` 只动参数，档位还停在上一枪的 0。
    await page.evaluate(async (value) => {
      window.__n.setBloom(1);
      window.__n.setBloom(value);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }, tune);
    await page.waitForTimeout(900);
    await page.screenshot({ path: `docs/screenshots/canton-bloom-${label}-${name}.png` });
    console.log(label, name, JSON.stringify(await page.evaluate(() => window.__n.bloomState())));
  }
}
// 现版那一档只留一张对照：那一侧没有这条链（见 `src/engine/bloom.js` 开头），要的是"两边各长什么样"。
await boot(HERO, false);
await page.screenshot({ path: 'docs/screenshots/canton-bloom-legacy-hero.png' });

// 代价：动效开着，读面板那两格（fps / 最长帧），每档跑 6 秒取中间那一次读数。
await boot(HERO, true);
const fpsOf = async (tune) => {
  await page.evaluate(async (value) => {
    window.__n.setBloom(1);
    window.__n.setBloom(value);
    window.__n.setMotion(true);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, tune);
  await page.waitForTimeout(6000);
  return page.evaluate(() => {
    const text = document.querySelector('.engine-stats').textContent.replace(/\s+/g, ' ');
    const counts = window.__n.counts();
    return { fps: Number(/three ([\d.]+) fps/.exec(text)?.[1] ?? NaN), ms: Number(/最长帧 ([\d.]+) ms/.exec(text)?.[1] ?? NaN),
      drawCalls: counts.drawCalls, bloom: counts.bloom?.strength };
  });
};
for (const [label, tune] of [['不加晕（只过链）', 0], ...CANDIDATES.map(([name, value]) => [name, value])]) {
  console.log(`fps ${label}：`, JSON.stringify(await fpsOf(tune)));
}
await page.evaluate(() => window.__n.setMotion(false));
await browser.close();
