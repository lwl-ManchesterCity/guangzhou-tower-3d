// 一次性：地标那一层"不吃泛光"要量成什么数（#190 给泛光那一项补的那一格判据）。
// 三张帧：① 泛光开·地标在，② 泛光关·地标在，③ 泛光开·地标藏。
// ③与①的差 = 这一层自己画了哪些像素（footprint）；①与②在同一批像素上的差 = 泛光把这一层抬了多少。
// 地标不吃这条链的话，后者该是 0；链里替它开门（把 `exclude` 那一格删掉）就会立刻涨起来。
import { chromium } from '@playwright/test';
const app = process.env.APP_URL || 'http://127.0.0.1:5174';
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
  window.__group = () => { let node = null; n.scene.traverse((o) => { if (o.name === 'landmarks') node = o; }); return node; };
  window.__lum = async (b64) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    const lum = new Float32Array(bitmap.width * bitmap.height);
    for (let i = 0; i < lum.length; i++) lum[i] = 0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2];
    return lum;
  };
  window.__veil = async ({ on, off, hidden }, clip) => {
    const A = await window.__lum(on), B = await window.__lum(off), C = await window.__lum(hidden);
    const [x0, y0, w, h] = clip;
    const inside = [], outside = [];
    let footprint = 0;
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
      const i = y * 1440 + x;
      const lift = A[i] - B[i];
      if (Math.abs(A[i] - C[i]) > 2) { footprint += 1; inside.push(lift); } else outside.push(lift);
    }
    const median = (values) => { const s = Float32Array.from(values).sort(); return +(s[s.length >> 1]).toFixed(2); };
    // 最坏那一格只报正方向：泛光只会往上抬，往下走的是透明带底下那一批（对照用 median）。
    // 不用 `Math.max(...values)`：两万个参数会把调用栈撑爆。
    const worst = (values) => +values.reduce((top, value) => (value > top ? value : top), 0).toFixed(1);
    return { footprint, inside: { median: median(inside), worst: worst(inside) },
      outside: { median: median(outside), worst: worst(outside) } };
  };
});
await page.locator('[data-atmosphere-option="night"]').click();
await page.waitForTimeout(3000);
const shoot = async () => {
  await page.evaluate(() => { document.querySelector('.engine-stats').style.visibility = 'hidden'; });
  const shot = async () => (await page.screenshot({ clip: { x: 0, y: 0, width: 1440, height: 960 } })).toString('base64');
  await page.evaluate(async () => {
    window.__probe.n.setBloom(1);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  const on = await shot();
  const hidden = await (async () => {
    await page.evaluate(() => { window.__group().visible = false; });
    await page.waitForTimeout(700);
    const frame = await shot();
    await page.evaluate(() => { window.__group().visible = true; });
    await page.waitForTimeout(700);
    return frame;
  })();
  await page.evaluate(async () => {
    window.__probe.n.setBloom(0);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  const off = await shot();
  await page.evaluate(async () => {
    window.__probe.n.setBloom(1);
    document.querySelector('.engine-stats').style.visibility = '';
  });
  return { on, off, hidden };
};
const frames = await shoot();
for (const clip of [[300, 120, 900, 700], [0, 0, 1440, 960]]) {
  console.log(`clip=${clip.join(',')}:`, JSON.stringify(await page.evaluate(async ({ frames, clip }) => window.__veil(frames, clip), { frames, clip })));
}
console.log('泛光那一格报的 exclude：', JSON.stringify(await page.evaluate(() => window.__probe.n.bloomState())));
await browser.close();
