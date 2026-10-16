// 一次性：江面波光进新引擎（#189）那条浏览器判据要钉的数，先在页面里量出来。
// 只在新引擎这一侧量：拍这一版时现版那侧的取景还带着 `setPadding`（#191），同一串 hash 两边画面错开 140×70 像素，
// 跨引擎的像素比会把取景差算到波光头上（那一格 2026-10-16 已收口，但"各量各的"这条方法不动——要钉的是这一层自己画了多少）。
// 跨引擎的像素比会把取景差算到波光头上。量六件事：这一层在不在、它单独画了多少像素、
// 它在屏幕上是不是正好 64 像素一圈（不随缩放走）、这一圈跟不跟镜头转、滚动的环、以及透明度那条斜坡。
import { chromium } from '@playwright/test';
const app = process.env.APP_URL || 'http://127.0.0.1:5174';
const VIEW = '#map=15.5/23.1105/113.3205/-12/58';
const FULL = { x: 0, y: 0, width: 1440, height: 960 };
const OFFSETS = [[0, 1], [0, 2], [0, 3], [0, 4], [0, 5], [0, 6], [0, 7], [0, 8], [0, 12], [0, 16], [0, 32],
  [0, 64], [1, 0], [4, 0], [8, 0], [64, 0]];
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
page.on('pageerror', (error) => console.log('page error:', error.message));
page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) console.log('console:', m.text()); });
await page.goto(`${app}/?scene=canton&engine=three&motion=off${VIEW}`);
await page.waitForFunction(() => document.querySelector('.engine-stats')?.textContent?.includes('fps'), { timeout: 120000 });
await page.waitForTimeout(2500);
await page.evaluate(async () => {
  const { neighborhood: n } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
  window.__probe = { n };
  // 先把动效按住：车、人、船都在走，任何两帧的差里都混着近场那批移动物，波光的像素账与格子周期都不干净。
  n.setMotion(false);
  window.__mesh = () => {
    let mesh = null;
    n.scene.traverse((object) => { if (object.name === 'river-sheen-water') mesh = object; });
    return mesh;
  };
  // 页面里算：不把两帧的原始数组搬过 CDP。
  window.__lum = async (b64) => {
    const bitmap = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob());
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    const lum = new Float32Array(bitmap.width * bitmap.height);
    for (let i = 0; i < lum.length; i++) lum[i] = 0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2];
    return { lum, width: bitmap.width, height: bitmap.height };
  };
  window.__diff = async (a, b) => {
    const x = await window.__lum(a), y = await window.__lum(b);
    let sum = 0, changed = 0, worst = 0;
    for (let i = 0; i < x.lum.length; i++) {
      const d = Math.abs(x.lum[i] - y.lum[i]);
      sum += d;
      if (d > worst) worst = d;
      if (d > 1) changed++;
    }
    return { changed, mean: Math.round(sum / x.lum.length * 100) / 100, worst: Math.round(worst), pixels: x.lum.length };
  };
  // 这一层在屏幕上是不是正好 64 个 CSS 像素一圈：把"开减关"的差值图按 (dx, dy) 挪一格再自比，
  // 只在这一层确实画了像素的地方比（|差值|>2），楼体、绿地与网格边那些抗锯齿像素不进这个账。
  // 屏幕空间的 `fract` 平铺意味着挪一整格就落回同一批纹素，相关必须接近 1；
  // 米制那一种假说在 17 级上一格占 256 像素，(0,64) 那格就只剩噪声。
  window.__periodic = async (a, b, offsets, floor = 2) => {
    if (window.__cacheKey !== `${a.length}:${b.length}`) {
      const x = await window.__lum(a), y = await window.__lum(b);
      const d = new Float32Array(x.lum.length);
      const mask = new Uint8Array(x.lum.length);
      for (let i = 0; i < x.lum.length; i++) { d[i] = x.lum[i] - y.lum[i]; mask[i] = Math.abs(d[i]) > floor ? 1 : 0; }
      window.__cache = { d, mask, width: x.width, height: x.height };
      window.__cacheKey = `${a.length}:${b.length}`;
    }
    const { d, mask, width, height } = window.__cache;
    const x = { width, height };
    const out = {};
    for (const [dx, dy] of offsets) {
      let num = 0, den = 0, pairs = 0;
      for (let row = Math.max(0, -dy); row + dy < height; row++) {
        for (let col = Math.max(0, -dx); col + dx < width; col++) {
          const i = row * width + col, j = (row + dy) * width + (col + dx);
          if (!mask[i] || !mask[j]) continue;
          num += d[i] * d[j]; den += d[i] * d[i]; pairs++;
        }
      }
      out[`${dx},${dy}`] = [Math.round(num / (den || 1) * 100) / 100, pairs];
    }
    return out;
  };
});

// 这一层的开关：藏网格 = 关掉这一层；两张都把手上的偏移钉回第 0 行，差值图里剩下的就只有"这一层画了什么"。
const set = (visible) => page.evaluate(({ visible }) => {
  const mesh = window.__mesh();
  mesh.visible = visible;
  mesh.material.userData.shader.uniforms.riverScroll.value = 0;
  const n = window.__probe.n;
  n.setView({ ...n.view(), zoom: n.view().zoom });
  return { river: n.counts().river, drawCalls: n.counts().drawCalls, triangles: n.counts().triangles };
}, { visible });

const hidePanel = (hidden) => page.evaluate((hidden) => {
  document.querySelector('.engine-stats').style.visibility = hidden ? 'hidden' : '';
}, hidden);

const pair = async () => {
  await hidePanel(true);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.waitForTimeout(400);
  await set(true);
  await page.waitForTimeout(600);
  const a = (await page.screenshot({ clip: FULL })).toString('base64');
  const on = await page.evaluate(() => ({ drawCalls: window.__probe.n.counts().drawCalls,
    triangles: window.__probe.n.counts().triangles }));
  await set(false);
  await page.waitForTimeout(600);
  const b = (await page.screenshot({ clip: FULL })).toString('base64');
  const off = await page.evaluate(() => ({ drawCalls: window.__probe.n.counts().drawCalls,
    triangles: window.__probe.n.counts().triangles }));
  await set(true);
  await hidePanel(false);
  return { a, b, on, off };
};

const ledger = await page.evaluate(() => ({ river: window.__probe.n.counts().river, drawCalls: window.__probe.n.counts().drawCalls,
  triangles: window.__probe.n.counts().triangles, panel: document.querySelector('.engine-stats').textContent }));
console.log('① 读数：', JSON.stringify(ledger));

const first = await pair();
console.log('② 这一层单独画的量：', JSON.stringify(await page.evaluate(async ({ a, b }) => window.__diff(a, b), first)));
console.log('② 开与关的发数：', JSON.stringify([first.on.drawCalls, first.off.drawCalls, first.on.triangles, first.off.triangles]));

// ③ 屏幕尺度不随缩放走：方位角钉 0（格子的环正好轴对齐），氛围给夜景（深色江面上这一层振幅最大）。
await page.evaluate(() => document.querySelector('[data-atmosphere-option="night"]').click());
await page.waitForTimeout(900);
for (const zoom of [13, 15.5, 17, 18]) {
  await page.evaluate(async (z) => {
    window.__probe.n.setView({ ...window.__probe.n.view(), zoom: z, bearing: 0 });
    await new Promise((r) => setTimeout(r, 500));
  }, zoom);
  await page.waitForTimeout(900);
  const { a, b } = await pair();
  console.log(`③ zoom ${zoom}：`, JSON.stringify(await page.evaluate(async ({ a, b, offsets }) => ({
    ...await window.__diff(a, b), lattice: await window.__periodic(a, b, offsets),
  }), { a, b, offsets: OFFSETS })));
}

// ④ 这一圈跟不跟镜头转：镜头转 25°，(0,64) 那一格就该让位给转了 25° 的 (27,58)。
for (const bearing of [0, -25, -40]) {
  await page.evaluate(async (bearing) => {
    window.__probe.n.setView({ ...window.__probe.n.view(), zoom: 15.5, bearing });
    await new Promise((r) => setTimeout(r, 500));
  }, bearing);
  await page.waitForTimeout(900);
  const { a, b } = await pair();
  const rad = (bearing * Math.PI) / 180;
  const turned = [[Math.round(64 * Math.sin(rad)), Math.round(64 * Math.cos(rad))]];
  console.log(`④ bearing ${bearing} → 转过的整格 ${JSON.stringify(turned[0])}：`, JSON.stringify(await page.evaluate(async ({ a, b, turned }) =>
    window.__periodic(a, b, [[0, 64], [64, 0], turned[0], [-turned[0][0], -turned[0][1]]]), { a, b, turned })));
}

// ⑤ 滚动的环：开动效后每 120 ms 推进约 1 像素、绕回 64；停动效回到 0 且画面与第 0 帧逐像素相同；换氛围回到 0。
// 采样从 Node 这一侧一拍一次：整段循环放进页面里跑 6 秒，实测会把那个 execution context 弄丢。
await page.evaluate(() => {
  const n = window.__probe.n;
  n.setView({ ...n.view(), bearing: 0 });
  n.setMotion(true);
});
const samples = [];
for (let i = 0; i < 12; i++) {
  await page.waitForTimeout(700);
  samples.push(await page.evaluate(() => {
    const status = window.__probe.n.motionStatus();
    return [status.phase, status.steps, window.__probe.n.counts().river.scroll];
  }));
}
console.log('⑤ 开动效采样 [phase, steps, scroll]：', JSON.stringify(samples));
console.log('⑤ 停动效之后：', JSON.stringify(await page.evaluate(async () => {
  const n = window.__probe.n;
  n.setMotion(false);
  await new Promise((r) => setTimeout(r, 400));
  return { phase: n.motionStatus().phase, scroll: n.counts().river.scroll, offset: n.counts().river.offset };
})));
const still1 = (await page.screenshot({ clip: FULL })).toString('base64');
await page.waitForTimeout(1500);
const still2 = (await page.screenshot({ clip: FULL })).toString('base64');
console.log('⑤ 停住之后两帧差：', JSON.stringify(await page.evaluate(async ({ a, b }) => window.__diff(a, b), { a: still1, b: still2 })));

console.log('⑤c 换氛围：', JSON.stringify(await page.evaluate(async () => {
  const n = window.__probe.n;
  n.setMotion(true);
  await new Promise((r) => setTimeout(r, 900));
  const before = n.counts().river;
  document.querySelector('[data-atmosphere-option="sunset"]').click();
  await new Promise((r) => setTimeout(r, 120));
  const after = n.counts().river;
  n.setMotion(false);
  return { before: { atmosphere: before.atmosphere, scroll: before.scroll }, after: { atmosphere: after.atmosphere, scroll: after.scroll } };
})));

// ⑥ 透明度那条斜坡：读数这一侧只看引擎的 counts。
console.log('⑥ 斜坡：', JSON.stringify(await page.evaluate(async () => {
  const n = window.__probe.n;
  const rows = [];
  for (const zoom of [10, 12, 13, 14, 15.5, 18.5, 20, 22]) {
    n.setView({ ...n.view(), zoom });
    await new Promise((r) => requestAnimationFrame(() => r()));
    rows.push([zoom, n.counts().river.opacity]);
  }
  return rows;
})));

await page.context().close();
await browser.close();
