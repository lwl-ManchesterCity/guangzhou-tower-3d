// 一次性：地标那一层进来之后，泛光那一项的"不许蒙灰"还成立吗（#190 撞上的第二条红）。
// 同一个夜景机位、同一对开/关帧，量三种口径：① 判据现在用的那块 900×700；② 整幅 1440×960；
// ③ 把地标那一层藏掉之后的同一块 900×700。第三条用来定性——抬起来的到底是塔自己的晕，还是整幅蒙了一层灰。
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
  // 一次解码两帧，全部逐像素运算留在页面里：三份口径共用同一对亮度数组。
  window.__stats = async ({ off, on }, clip) => {
    const A = await window.__lum(off), B = await window.__lum(on);
    const width = 1440, height = 960;
    const [x0, y0, w, h] = clip;
    const pick = [];
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) pick.push(y * width + x);
    const sorted = (values) => Float32Array.from(values).sort();
    const median = (values) => sorted(values)[values.length >> 1];
    let halo = 0, lifted = 0, overA = 0, overB = 0;
    const diff = [], la = [], lb = [];
    for (const i of pick) {
      if (A[i] < 100 && B[i] >= 100) halo += 1;
      if (B[i] - A[i] > 2) lifted += 1;
      if (A[i] >= 250) overA += 1;
      if (B[i] >= 250) overB += 1;
      diff.push(B[i] - A[i]);
      la.push(A[i]); lb.push(B[i]);
    }
    // 与判据同一个口径：那一档多烧掉的是"总数差"，不是" crossings 数"。
    const blown = overB - overA;
    const p90 = sorted(diff)[Math.floor(diff.length * 0.9)];
    return { pixels: pick.length, halo, lifted, blown,
      medianOff: +median(la).toFixed(1), medianOn: +median(lb).toFixed(1),
      p90Diff: +p90.toFixed(1) };
  };
});
await page.locator('[data-atmosphere-option="night"]').click();
await page.waitForTimeout(3000);

const shot = async () => {
  await page.evaluate(() => { document.querySelector('.engine-stats').style.visibility = 'hidden'; });
  const out = {};
  for (const share of [0, 1]) {
    await page.evaluate(async (value) => {
      window.__probe.n.setBloom(value);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }, share);
    out[share] = (await page.screenshot({ clip: { x: 0, y: 0, width: 1440, height: 960 } })).toString('base64');
  }
  await page.evaluate(() => { document.querySelector('.engine-stats').style.visibility = ''; });
  return out;
};

for (const shells of [true, false]) {
  await page.evaluate((visible) => { window.__group().visible = visible; }, shells);
  await page.waitForTimeout(900);
  const pair = await shot();
  for (const clip of [[300, 120, 900, 700], [0, 0, 1440, 960]]) {
    const stats = await page.evaluate(async ({ pair, clip }) => window.__stats({ off: pair[0], on: pair[1] }, clip), { pair, clip });
    console.log(`地标${shells ? '在' : '藏'} clip=${clip.join(',')}:`, JSON.stringify(stats));
  }
  if (shells) {
    for (const share of [0, 1]) {
      const buffer = Buffer.from(pair[share], 'base64');
      const { writeFileSync } = await import('node:fs');
      writeFileSync(`/tmp/landmarks-bloom-${share}.png`, buffer);
    }
  }
}
await browser.close();
