// 一次性：给新引擎的泛光挑三个数。同一帧（夜景、出厂拍）在 share = 0 与几档强度之间逐像素比，
// 报"亮起来多少、糊出去多少、烧掉多少"，同时读面板那一行的 fps 与 draw call。
// 逐像素的比对放在页面里做（一份 550 万个数的数组来回传，一次就要几十秒），Node 这只收汇总。
// 用法 `node scripts/probe-bloom-engine.mjs [share share ...]`；不给参数就跑 0.25 / 0.5 / 0.75 / 1。
import { chromium } from '@playwright/test';

const app = process.env.APP_URL || 'http://127.0.0.1:5174';
const camera = process.env.CAMERA || '#map=15.4/23.109/113.31913/-25/58';
const shares = process.argv.slice(2).map(Number).filter((n) => Number.isFinite(n));
const levels = shares.length ? shares : [0.25, 0.5, 0.75, 1];
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 2 });
page.on('pageerror', (error) => console.log('page error:', error.message));
await page.goto(`${app}/?engine=three${camera}`, { waitUntil: 'load' });
await page.reload({ waitUntil: 'load' });
await page.waitForFunction(() => document.querySelector('.engine-stats')?.textContent?.includes('fps'), { timeout: 120000 });
await page.waitForTimeout(6000);
// 夜景要点按钮，不是读 URL：`?atmosphere=` 那格只写进 `body.dataset`，引擎这一侧的初值走的是同一格，
// 但这一份脚本要的是"确实切过去了"，所以直接点，再把 `counts().bloom` 打出来当证据。
await page.locator('[data-atmosphere-option="night"]').click();
await page.waitForTimeout(3500);
// 关掉动效：两档之间比的必须是同一帧画面，不然车流走一格就把"晕"的贡献混进了位移。
await page.evaluate(async () => {
  const { neighborhood: n } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
  window.__n = n;
  n.setMotion(false);
  // 亮度场存在页面里：`base` 是 share 0 那一帧，逐档只跟它比。
  const decode = (base64) => new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(image, 0, 0);
      const { data } = context.getImageData(0, 0, image.width, image.height);
      const luma = new Float32Array(image.width * image.height);
      for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
        luma[p] = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      }
      resolve(luma);
    };
    image.src = `data:image/png;base64,${base64}`;
  });
  window.__luminate = async (base64, asBase) => {
    const luma = await decode(base64);
    const sorted = Float32Array.from(luma).sort();
    const at = (share) => sorted[Math.floor(sorted.length * share)];
    const row = { pixels: luma.length, median: +at(0.5).toFixed(1), p90: +at(0.9).toFixed(1), p999: +at(0.999).toFixed(1),
      max: +sorted[sorted.length - 1].toFixed(0), blown: 0, over100: 0 };
    for (const value of luma) {
      if (value >= 250) row.blown += 1;
      if (value >= 100) row.over100 += 1;
    }
    if (asBase) {
      window.__base = luma;
      return row;
    }
    const base = window.__base;
    let brighter = 0; let sum = 0; let halo = 0; let darker = 0;
    for (let i = 0; i < luma.length; i += 1) {
      const delta = luma[i] - base[i];
      if (delta > 2) { brighter += 1; sum += delta; }
      if (delta < -2) darker += 1;
      // "糊出去"的定义：原来不到 100（不是灯芯）、现在过了 100 —— 那是晕的裙边，不是灯本身。
      if (base[i] < 100 && luma[i] >= 100) halo += 1;
    }
    return { ...row, brighter, meanLift: +(sum / Math.max(1, brighter)).toFixed(1), halo, darker };
  };
});
await page.waitForTimeout(1200);

const CLIP = { x: 300, y: 120, width: 900, height: 700 };
const shot = async (share) => {
  await page.evaluate(async (value) => {
    // 扫参数那一路要先给满档：`setBloom(对象)` 只改三个数，档位还是上一次那个（基线那一枪把它设成了 0）。
    if (value && typeof value === 'object') window.__n.setBloom(1);
    window.__n.setBloom(value);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, share);
  // 只截画面中间那块：页脚的 fps 面板与顶栏每 0.5 s 改一次字，整幅比的话那 9 千颗像素全是它的。
  const base64 = (await page.screenshot({ clip: CLIP })).toString('base64');
  return page.evaluate(async ([data, asBase]) => window.__luminate(data, asBase), [base64, share === 0]);
};

const base = await shot(0);
console.log(`share 0（只过合成器、不加晕）：${JSON.stringify(base)} 链 ${JSON.stringify(await page.evaluate(() => window.__n.bloomState()))}`);
if (process.argv.includes('--sweep')) {
  // 扫三个数：门槛决定"谁配起晕"，半径决定"糊多远"，强度决定"亮多少"。
  // 要看的是两件事同时成立：晕要看得见面（`halo` 往上走），底噪不能被抬起来（`median` 几乎不动）。
  for (const threshold of [0.13, 0.3, 0.45]) {
    for (const radius of [0.2, 0.4, 0.6]) {
      for (const strength of [0.5, 0.9]) {
        const row = await shot({ strength, radius, threshold });
        const live = await page.evaluate(() => window.__n.bloomState());
        console.log(`门槛 ${threshold} 半径 ${radius} 强度 ${strength} → 实际 strength ${live.strength.toFixed(2)}：`
          + `亮起来 ${row.brighter} 颗（平均 +${row.meanLift}）、晕到 ≥100 的 ${row.halo} 颗、中位 ${row.median}（底 +28.8）`
          + ` p90 ${row.p90} 烧掉的 ${row.blown} 颗`);
      }
    }
  }
  await browser.close();
  process.exit(0);
}
for (const share of levels) {
  const row = await shot(share);
  const panel = await page.evaluate(() => ({ calls: window.__n.counts().drawCalls, bloom: window.__n.bloomState(),
    fps: document.querySelector('.engine-stats').textContent.match(/([\d.]+) fps · 最长帧 ([\d.]+) ms/)?.slice(1, 3) }));
  console.log(`share ${share}：亮起来 ${row.brighter} 颗（平均 +${row.meanLift}）、晕到 ≥100 的 ${row.halo} 颗、变暗 ${row.darker} 颗、`
    + `中位 ${row.median} p90 ${row.p90} p999 ${row.p999} 最亮 ${row.max} 烧掉的 ${row.blown} 颗`
    + ` | drawCalls ${panel.calls} strength ${panel.bloom.strength?.toFixed(2)} fps ${panel.fps?.join(' / ')}`);
}
await page.evaluate(() => window.__n.setBloom(1));
await page.waitForTimeout(1500);
console.log('面板：', await page.evaluate(() => document.querySelector('.engine-stats').textContent.replace(/\s+/g, ' ')));
await browser.close();
