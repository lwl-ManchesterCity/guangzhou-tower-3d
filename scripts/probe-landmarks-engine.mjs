// 一次性：地标那一整批资产进新引擎之后的现场盘点（#190）。
// 读四样：这一层自己报的账、它在发数与三角形上占多少、把它藏掉之后画面差多少、以及报错清单。
import { writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
const app = process.env.APP_URL || 'http://127.0.0.1:5174';
const VIEW = process.env.VIEW || '#map=15.5/23.1095/113.31913/-25/62';
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
page.on('pageerror', (error) => console.log('page error:', error.message));
page.on('console', (message) => { if (['error', 'warning'].includes(message.type())) console.log(`console ${message.type()}:`, message.text()); });
await page.goto(`${app}/?engine=three${VIEW}`);
await page.waitForFunction(() => document.querySelector('.engine-stats')?.textContent?.includes('fps'), { timeout: 180000 });
await page.waitForTimeout(3000);
await page.evaluate(async () => {
  const { neighborhood: n } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
  window.__probe = { n };
  n.setMotion(false);
  window.__group = () => { let node = null; n.scene.traverse((object) => { if (object.name === 'landmarks') node = object; }); return node; };
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
  window.__diff = async (a, b) => {
    const x = await window.__lum(a), y = await window.__lum(b);
    let sum = 0, changed = 0, worst = 0, box = null;
    for (let i = 0; i < x.lum.length; i++) {
      const d = Math.abs(x.lum[i] - y.lum[i]);
      sum += d;
      if (d > worst) worst = d;
      if (d > 2) {
        changed++;
        const row = Math.floor(i / x.width), col = i % x.width;
        box = box ? { x0: Math.min(box.x0, col), x1: Math.max(box.x1, col), y0: Math.min(box.y0, row), y1: Math.max(box.y1, row) }
          : { x0: col, x1: col, y0: row, y1: row };
      }
    }
    return { changed, mean: Math.round(sum / x.lum.length * 100) / 100, worst: Math.round(worst), box };
  };
});

const shot = async (visible) => {
  await page.evaluate((visible) => {
    document.querySelector('.engine-stats').style.visibility = 'hidden';
    window.__group().visible = visible;
  }, visible);
  await page.waitForTimeout(900);
  const image = (await page.screenshot({ clip: { x: 0, y: 0, width: 1440, height: 960 } })).toString('base64');
  const counts = await page.evaluate(() => { const c = window.__probe.n.counts(); return { landmarks: c.landmarks, drawCalls: c.drawCalls, triangles: c.triangles, buildings: c.buildings }; });
  return { image, counts };
};

for (const atmosphere of ['day', 'night']) {
  if (atmosphere === 'night') {
    await page.evaluate(() => document.querySelector('[data-atmosphere-option="night"]').click());
    await page.waitForTimeout(1600);
  }
  const on = await shot(true);
  const off = await shot(false);
  await page.evaluate(() => { document.querySelector('.engine-stats').style.visibility = ''; window.__group().visible = true; });
  const diff = await page.evaluate(async ({ a, b }) => window.__diff(a, b), { a: on.image, b: off.image });
  console.log(`\n【${atmosphere}】这一层的账：`, JSON.stringify(on.counts.landmarks));
  console.log(`  发数 ${off.counts.drawCalls} → ${on.counts.drawCalls}｜三角形 ${off.counts.triangles} → ${on.counts.triangles}｜楼块 ${on.counts.buildings} 栋`);
  console.log('  画面差：', JSON.stringify(diff));
  writeFileSync(`/tmp/landmarks-${atmosphere}-on.png`, Buffer.from(on.image, 'base64'));
}
const motion = await page.evaluate(async () => {
  const n = window.__probe.n;
  n.setMotion(true);
  const rows = [];
  for (let i = 0; i < 6; i++) {
    await new Promise((resolve) => setTimeout(resolve, 700));
    rows.push(n.counts().landmarks.hue);
  }
  n.setMotion(false);
  return { walked: rows, afterStop: n.counts().landmarks.hue };
});
console.log('\n色相走查：', JSON.stringify(motion));
await browser.close();
