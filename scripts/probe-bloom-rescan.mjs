// 一次性：地标进来之后重扫泛光那三个数（#190 撞红的那一条）。
// 上一轮 0.75/0.4/0.3 是在**没有塔**的画面上扫出来的；现在塔身那一大片亮面进了阈值，
// 塔腰烧成一团白、全幅中位抬 4.7。这里把 threshold × strength × radius 各扫一档，
// 每档读同一对帧（关/开）出来的五个数，门槛照判据原样：blown ≤40、中位抬升 ≤4、halo ≥250、lifted ≥2 万。
import { writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
const app = process.env.APP_URL || 'http://127.0.0.1:5174';
const GRID = [];
for (const threshold of [0.3, 0.5, 0.65, 0.8]) for (const strength of [0.75, 0.5]) for (const radius of [0.4, 0.2]) {
  GRID.push({ threshold, strength, radius });
}
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
page.on('pageerror', (error) => console.log('page error:', error.message));
await page.goto(`${app}/?engine=three#map=15.5/23.1095/113.31913/-25/62`);
await page.waitForFunction(() => document.querySelector('.engine-stats')?.textContent?.includes('fps'), { timeout: 180000 });
await page.waitForTimeout(3000);
await page.evaluate(async () => {
  const { neighborhood: n } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
  window.__probe = { n };
  n.setMotion(false);
  window.__lum = async (b64) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    const lum = new Float32Array(bitmap.width * bitmap.height);
    for (let i = 0; i < lum.length; i++) lum[i] = 0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2];
    return { lum, width: bitmap.width, height: bitmap.height };
  };
  // 一次算全：整幅的蒙灰账 + 判据那块 900×700 + 塔腰那一格（塔身自己的像素，用来量"格子还在不在"）。
  window.__sweep = async ({ off, on, tower }) => {
    const A = await window.__lum(off), B = await window.__lum(on);
    const { width, height } = A;
    const rows = {};
    const tally = (label, pick) => {
      let halo = 0, lifted = 0, overA = 0, overB = 0, max = 0;
      const la = [], lb = [];
      for (const i of pick) {
        const a = A.lum[i], b = B.lum[i];
        if (a < 100 && b >= 100) halo += 1;
        if (b - a > 2) lifted += 1;
        if (a >= 250) overA += 1;
        if (b >= 250) overB += 1;
        if (b > max) max = b;
        la.push(a); lb.push(b);
      }
      const median = (values) => Float32Array.from(values).sort()[values.length >> 1];
      return { label, pixels: pick.length, halo, lifted, blown: overB - overA,
        medianOff: +median(la).toFixed(1), medianOn: +median(lb).toFixed(1), maxOn: Math.round(max) };
    };
    const whole = [];
    for (let i = 0; i < A.lum.length; i++) whole.push(i);
    rows.whole = tally('整幅', whole);
    const clip = [];
    for (let y = 120; y < 820; y++) for (let x = 300; x < 1200; x++) clip.push(y * width + x);
    rows.clip = tally('判据那块', clip);
    rows.tower = tally('塔腰', tower);
    return rows;
  };
});
await page.locator('[data-atmosphere-option="night"]').click();
await page.waitForTimeout(3000);
// 塔腰那一格：把塔脚与塔顶投到屏幕上，取两者之间靠上的一段（皇冠与塔腰的格子都在那里）。
const towerPixels = await page.evaluate(async () => {
  const n = window.__probe.n;
  const foot = n.screen({ lng: 113.31913, lat: 23.109, altitude: 120 });
  const top = n.screen({ lng: 113.31913, lat: 23.109, altitude: 460 });
  const x0 = Math.max(0, Math.round(Math.min(foot.x, top.x) - 60));
  const x1 = Math.min(1439, Math.round(Math.max(foot.x, top.x) + 60));
  const y0 = Math.max(0, Math.round(Math.min(foot.y, top.y) - 20));
  const y1 = Math.min(959, Math.round(Math.max(foot.y, top.y) + 20));
  const out = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push(y * 1440 + x);
  return { box: [x0, y0, x1, y1], pixels: out };
});
console.log('塔腰那一格：', JSON.stringify(towerPixels.box), towerPixels.pixels.length, '像素');
// 关的那一张必须是**档位 0**（那条链整个不走），不是"某一组参数下的开"。
await page.evaluate(async () => {
  window.__probe.n.setBloom(0);
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
});
await page.waitForTimeout(700);
const off = (await page.screenshot({ clip: { x: 0, y: 0, width: 1440, height: 960 } })).toString('base64');
const rows = [];
for (const tune of GRID) {
  await page.evaluate(async (value) => {
    window.__probe.n.setBloom({ ...value, samples: 4 });
    window.__probe.n.setBloom(1);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, tune);
  await page.waitForTimeout(700);
  const on = (await page.screenshot({ clip: { x: 0, y: 0, width: 1440, height: 960 } })).toString('base64');
  const stats = await page.evaluate(async ({ off, on, tower }) => window.__sweep({ off, on, tower }),
    { off, on, tower: towerPixels.pixels });
  rows.push({ ...tune, whole: stats.whole, clip: stats.clip, tower: stats.tower });
  const pass = stats.whole.blown <= 40 && stats.whole.medianOn - stats.whole.medianOff <= 4
    && stats.whole.halo >= 250 && stats.whole.lifted >= 20000;
  console.log(`t=${tune.threshold} s=${tune.strength} r=${tune.radius} `
    + `整幅[halo ${stats.whole.halo} lifted ${stats.whole.lifted} blown ${stats.whole.blown} 中位 ${stats.whole.medianOff}→${stats.whole.medianOn}] `
    + `那块[blown ${stats.clip.blown} 中位 ${stats.clip.medianOff}→${stats.clip.medianOn}] `
    + `塔腰[max ${stats.tower.maxOn} blown ${stats.tower.blown}] ${pass ? '← 四条全过' : ''}`);
  if (tune.threshold === 0.65 && tune.strength === 0.5 && tune.radius === 0.2) {
    writeFileSync('/tmp/bloom-sweep-t065s05r02.png', Buffer.from(on, 'base64'));
  }
  if (tune.threshold === 0.8 && tune.strength === 0.75 && tune.radius === 0.4) {
    writeFileSync('/tmp/bloom-sweep-t08s075r04.png', Buffer.from(on, 'base64'));
  }
}
writeFileSync('/tmp/bloom-sweep.json', JSON.stringify(rows, null, 1));
await browser.close();
