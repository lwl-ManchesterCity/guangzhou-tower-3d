// 一次性：江面那层波光的格子"锚"在哪——跟着地面走（平移地图时格子一起滑），还是钉在视口上（格子不动，地面从它底下过）。
// 这件事必须在每台引擎自己内部量：拍这一版时跨引擎比会把 #191 那 140×70 像素的取景差算进偏移里（那格 2026-10-16 已收口）。
// 收口之后这一格仍然各量各的：两引擎的瓦片相位律本来就不同，能对齐的是"移动量"而不是"绝对落点"（见 README #189 那一节末）。
// 方法：同一处镜头各拍一组"开/关"差值图（差值图里只有这一层画的东西），把镜头平移一段再拍一组，
// 然后拿两组的差值图互相挪着找最对齐的那个偏移。峰在 0 就是钉在视口，峰在这一次的实际平移量就是跟着地面。
// 平移量不靠猜：平移前后各读一次"原中心现在落在屏幕哪个像素"，读到的差就是这一层应当跟着走的量。
import { chromium } from '@playwright/test';
const app = process.env.APP_URL || 'http://127.0.0.1:5174';
const VIEW = '#map=16/23.1105/113.3205/0/0';
const CLIP = { x: 0, y: 0, width: 1440, height: 960 };
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });

const ANALYSE = `
window.__lum = async (b64) => {
  const bitmap = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob());
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width; canvas.height = bitmap.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0);
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  const lum = new Float64Array(bitmap.width * bitmap.height);
  for (let i = 0; i < lum.length; i++) lum[i] = 0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2];
  return { lum, width: bitmap.width, height: bitmap.height };
};
window.__sheen = async (a, b) => {
  const x = await window.__lum(a), y = await window.__lum(b);
  const d = new Float64Array(x.lum.length);
  const m = new Uint8Array(x.lum.length);
  let changed = 0;
  for (let i = 0; i < x.lum.length; i++) { d[i] = x.lum[i] - y.lum[i]; if (Math.abs(d[i]) > 2) { m[i] = 1; changed++; } }
  return { d, m, changed, width: x.width, height: x.height };
};
// 两张差值图之间：只取两边都确实画了波光的地方（各自 |差值|>2），看同一屏幕位置上落的还是不是同一个值。
// 钉在视口 → 平移前后同一屏点采的是同一个纹素， disagreement 应该接近 0；
// 跟着地面 → 平移 120 像素后纹素换了行（64 像素一圈，120 不是整圈），大半像素会翻符号。
window.__agree = async (A, B, floor = 2) => {
  let pairs = 0, disagree = 0, sum = 0;
  for (let i = 0; i < A.d.length; i++) {
    if (!(A.m[i] && B.m[i])) continue;
    pairs++;
    const gap = Math.abs(A.d[i] - B.d[i]);
    sum += gap;
    if (gap > floor) disagree++;
  }
  return { pairs, disagree, share: Math.round(disagree / (pairs || 1) * 1000) / 10,
    meanGap: Math.round(sum / (pairs || 1) * 100) / 100 };
};
// 归一化相关：对齐了应当接近 1。
window.__corr = async (A, B, dx, dy) => {
  const W = A.width;
  let num = 0, denA = 0, denB = 0, pairs = 0;
  for (let row = Math.max(0, -dy); row + dy < A.height; row++) {
    for (let col = Math.max(0, -dx); col + dx < W; col++) {
      const i = row * W + col, j = (row + dy) * W + (col + dx);
      if (!(A.m[i] && B.m[j])) continue;
      num += A.d[i] * B.d[j]; denA += A.d[i] * A.d[i]; denB += B.d[j] * B.d[j]; pairs++;
    }
  }
  return [Math.round(num / (Math.sqrt(denA * denB) || 1) * 100) / 100, pairs];
};
// 用来判断幅度漂移：同一批像素在两台镜头下的均值比。
window.__level = async (S) => {
  let sum = 0, n = 0;
  for (let i = 0; i < S.d.length; i++) if (S.m[i]) { sum += S.d[i]; n++; }
  return Math.round(sum / (n || 1) * 100) / 100;
};
// 同一对差值图自己挪 (dx,dy) 之后的符合度：用来确认"跟着地面"那一种假说在这台引擎里是不是也存在一个对齐点。
window.__agreeShift = async (A, B, dx, dy, floor = 2) => {
  const W = A.width;
  let pairs = 0, disagree = 0;
  for (let row = Math.max(0, -dy); row + dy < A.height; row++) {
    for (let col = Math.max(0, -dx); col + dx < W; col++) {
      const i = row * W + col, j = (row + dy) * W + (col + dx);
      if (!(A.m[i] && B.m[j])) continue;
      pairs++;
      if (Math.abs(A.d[i] - B.d[j]) > floor) disagree++;
    }
  }
  return { pairs, disagree, share: Math.round(disagree / (pairs || 1) * 1000) / 10 };
};
`;

const pan = process.env.PAN === 'both' ? ['three', 'legacy'] : ['three', 'legacy'];
for (const engine of pan) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
  page.on('pageerror', (error) => console.log(`[${engine}] page error:`, error.message));
  await page.goto(`${app}/?scene=canton&motion=off${engine === 'three' ? '&engine=three' : ''}${VIEW}`);
  if (engine === 'three') {
    await page.waitForFunction(() => document.querySelector('.engine-stats')?.textContent?.includes('fps'), { timeout: 120000 });
  } else {
    await page.waitForSelector('#places-toggle:not([disabled])', { timeout: 180000 });
  }
  await page.waitForTimeout(2500);
  await page.evaluate(ANALYSE);
  await page.evaluate(async () => {
    const { neighborhood: n } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    window.__probe = { n };
    // 动效必须按住：车、人、船与波光自己的那一拍都在走，两帧的差里混着它们，对齐峰就量不出来。
    n.setMotion(false);
    if (n.map) n.map.jumpTo({ center: [113.3205, 23.1105], zoom: 16, bearing: 0, pitch: 0 });
    else n.setView({ ...n.view(), zoom: 16, bearing: 0, pitch: 0, center: { lat: 23.1105, lng: 113.3205 } });
    await new Promise((r) => setTimeout(r, 800));
  });
  // 氛围给夜景：这一层在深色江面上振幅最大（白昼那一份逐像素平均只有 0.11 个灰阶，掩膜太薄）。
  await page.evaluate(() => document.querySelector('[data-atmosphere-option="night"]').click());
  await page.waitForTimeout(1200);
  await page.evaluate(() => window.__probe.n.setMotion(false));

  // 开关这一层各拍两张：一次在原中心，一次把镜头往右下各挪约 120 屏幕像素。
  const shoot = async () => {
    await page.evaluate(() => document.querySelector('.engine-stats')?.style.setProperty('visibility', 'hidden'));
    const setOn = (v) => engine === 'three'
      ? page.evaluate((v) => {
        let mesh = null;
        window.__probe.n.scene.traverse((o) => { if (o.name === 'river-sheen-water') mesh = o; });
        mesh.visible = v;
        mesh.material.userData.shader.uniforms.riverScroll.value = 0;
      }, v)
      : page.evaluate((v) => window.__probe.n.map.setLayoutProperty('river-surface', 'visibility', v ? 'visible' : 'none'), v);
    const settle = () => engine === 'three'
      ? page.evaluate(() => new Promise((r) => setTimeout(r, 500)))
      : page.evaluate(() => Promise.race([new Promise((r) => window.__probe.n.map.once('idle', r)), new Promise((r) => setTimeout(r, 3000))]))
    await setOn(true); await settle(); await page.waitForTimeout(600);
    const on = (await page.screenshot({ clip: CLIP })).toString('base64');
    await setOn(false); await settle(); await page.waitForTimeout(600);
    const off = (await page.screenshot({ clip: CLIP })).toString('base64');
    await setOn(true);
    await page.evaluate(() => document.querySelector('.engine-stats')?.style.removeProperty('visibility'));
    return { on, off };
  };

  const centreOf = () => engine === 'three'
    ? page.evaluate(() => window.__probe.n.view().center)
    : page.evaluate(() => { const c = window.__probe.n.map.getCenter(); return { lat: c.lat, lng: c.lng }; });
  const screenOf = (centre) => engine === 'three'
    ? page.evaluate((c) => { const p = window.__probe.n.screen(c); return [Math.round(p.x), Math.round(p.y)]; }, centre)
    : page.evaluate((c) => { const p = window.__probe.n.map.project([c.lng, c.lat]); return [Math.round(p.x), Math.round(p.y)]; }, centre);
  const moveTo = (centre) => engine === 'three'
    ? page.evaluate((c) => window.__probe.n.setView({ ...window.__probe.n.view(), center: c }), centre)
    : page.evaluate((c) => window.__probe.n.map.jumpTo({ center: c }), centre);

  const start = await centreOf();
  const before = await screenOf(start);
  const first = await shoot();
  // 目标：原中心在屏幕上落到 (before + (120, 120))。用两次试凑把平移量对准。
  let target = { lat: start.lat, lng: start.lng };
  for (let attempt = 0; attempt < 6; attempt++) {
    await moveTo(target);
    await page.waitForTimeout(500);
    const now = await screenOf(start);
    const dx = before[0] + 120 - now[0], dy = before[1] + 120 - now[1];
    if (Math.abs(dx) <= 2 && Math.abs(dy) <= 2) break;
    target = { lat: target.lat + dy / 110540, lng: target.lng - dx / (111320 * Math.cos(target.lat * Math.PI / 180)) };
  }
  await moveTo(target);
  await page.waitForTimeout(700);
  const after = await screenOf(start);
  const moved = [after[0] - before[0], after[1] - before[1]];
  const offsetBefore = await page.evaluate(() => window.__probe.n.counts?.().river?.offset ?? null);
  const offsetAfter = await page.evaluate(() => window.__probe.n.counts?.().river?.offset ?? null);
  const second = await shoot();

  const shots = [];
  for (const shot of [first, second]) {
    shots.push(await page.evaluate(async ({ on, off }) => {
      const S = await window.__sheen(on, off);
      return { changed: S.changed };
    }, shot));
  }
  console.log(`[${engine}] 相位 ${JSON.stringify([offsetBefore, offsetAfter])} · 平移 ${JSON.stringify(moved)} px · 两帧各画的量 ${JSON.stringify(shots)}`);
  const report = await page.evaluate(async ({ first, second, moved }) => {
    const A = await window.__sheen(first.on, first.off);
    const B = await window.__sheen(second.on, second.off);
    const scan = [];
    for (const [dx, dy] of [[0, 0], moved, [-moved[0], -moved[1]], [moved[0], 0], [0, moved[1]],
      [moved[0] + 8, moved[1]], [moved[0] - 8, moved[1] - 8], [Math.round(moved[0] / 2), Math.round(moved[1] / 2)]]) {
      scan.push([[Math.round(dx), Math.round(dy)], await window.__corr(A, B, Math.round(dx), Math.round(dy))]);
    }
    return { level: [await window.__level(A), await window.__level(B)],
      sameScreenDisagree: (await window.__agree(A, B)).share, scan };
  }, { first, second, moved });
  console.log(`[${engine}] 符合度（sameScreen 低＝跟着地面；atPan 低＝这一层的格子确实跟着地面挪了平移量）：`, JSON.stringify(report));
  await page.context().close();
}
await browser.close();
