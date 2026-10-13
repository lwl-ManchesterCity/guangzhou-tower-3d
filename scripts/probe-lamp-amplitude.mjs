// 夜景换窗的幅度与"成簇度"：把动效停住，只钉两组权重（`setGlobalStateProperty` 不是样式改动，
// 不会触发 MapLibre 的重图集，所以这一对比是干净的；改可见性才会，见 README 的 #114 一条）。
// 两个量分开看：`moved` 是变了多少颗，`cluster` 是"最挤的 24×24 小窗里同时变了多少颗"——
// 后者才是"整栋灭"与"全城各换一格"的分水岭：像素总数可以一样，成簇度差一个量级。
import { chromium } from '@playwright/test';
const app = process.env.APP_URL || 'http://127.0.0.1:5174';
const camera = '#map=15.5/23.1095/113.31913/-25/62';
const CLIP = { x: 620, y: 300, width: 720, height: 460 };
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
await page.goto(`${app}/?scene=canton&atmosphere=night${camera}`);
await page.waitForSelector('#places-toggle:not([disabled])', { timeout: 180000 });
await page.locator('[data-atmosphere-option="night"]').click();
await page.waitForTimeout(3400);
await page.evaluate(async () => {
  const { neighborhood: n } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
  window.__n = n;
});
await page.evaluate(() => window.__n.setMotion(false));
await page.waitForTimeout(800);

const settle = async (a, b) => {
  await page.evaluate(async ([x, y]) => {
    const map = window.__n.map;
    map.setGlobalStateProperty('lamp-0', x);
    map.setGlobalStateProperty('lamp-1', y);
    map.triggerRepaint();
    await new Promise((resolve) => map.once('idle', resolve));
  }, [a, b]);
  await page.waitForTimeout(900);
  return (await page.screenshot({ clip: CLIP })).toString('base64');
};
const grade = async (a, b) => page.evaluate(async ({ a, b }) => {
  const load = async (source) => {
    const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${source}`)).blob());
    const buffer = new OffscreenCanvas(image.width, image.height);
    const context = buffer.getContext('2d');
    context.drawImage(image, 0, 0);
    return { width: image.width, height: image.height, data: context.getImageData(0, 0, image.width, image.height).data };
  };
  const x = await load(a), y = await load(b);
  const changed = new Uint8Array(x.width * x.height);
  let moved = 0, sum = 0;
  for (let i = 0, p = 0; i < x.data.length; i += 4, p++) {
    const d = Math.max(Math.abs(x.data[i] - y.data[i]), Math.abs(x.data[i + 1] - y.data[i + 1]), Math.abs(x.data[i + 2] - y.data[i + 2]));
    if (d > 8) { moved++; sum += d; changed[p] = 1; }
  }
  // 最挤的 24×24 小窗里有多少颗在变（步长 6，整幅扫一遍）。
  let cluster = 0;
  const box = 24;
  for (let top = 0; top + box < x.height; top += 6) {
    const rowSums = new Int32Array(x.width);
    for (let py = top; py < top + box; py++) for (let px = 0; px < x.width; px++) rowSums[px] += changed[py * x.width + px];
    for (let left = 0; left + box < x.width; left += 6) {
      let count = 0;
      for (let px = left; px < left + box; px++) count += rowSums[px];
      cluster = Math.max(cluster, count);
    }
  }
  return { moved, meanDelta: moved ? Math.round(sum / moved) : 0, cluster,
    share: Math.round(moved / (x.width * x.height) * 1000) / 10 };
}, { a, b });

const frames = {};
for (const [name, [a, b]] of Object.entries({ '1/1': [1, 1], '0/1': [0, 1], '1/0': [1, 0], '0/0': [0, 0] })) {
  frames[name] = await settle(a, b);
}
console.log('权重对钉到两端后，这块 720×460 的画面：');
for (const [pair, [a, b]] of Object.entries({ '组0 换档 1/1→0/1': ['1/1', '0/1'], '组1 换档 1/1→1/0': ['1/1', '1/0'], '两组都换 1/1→0/0': ['1/1', '0/0'] })) {
  console.log(' ', pair, JSON.stringify(await grade(frames[a], frames[b])));
}
await browser.close();
