// 夜里"换窗交叉淡"到底看不看得见：不改任何样式（改样式会触发 MapLibre 重图集，像素差就变成渲染器的
// 抖动而不是这一层的贡献，见 README 的 #114 一条），只让动效自己跑，连拍一整周期（11 s 与 17 s 的最小
// 公倍数太长，取 14 s ≈ 组 0 的一整圈 + 组 1 的 0.82 圈），看一块固定墙面的亮度随时间怎么动。
// 同一时间序列里再量一份"画面里最亮的那批窗格"的亮度，两条一起才说明是"整墙在呼吸"还是"个别窗在换"。
import { chromium } from '@playwright/test';
const app = process.env.APP_URL || 'http://127.0.0.1:5174';
const camera = '#map=15.5/23.1095/113.31913/-25/62';
const wall = { x: 620, y: 520, width: 300, height: 200 };
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
const series = [];
for (let i = 0; i < 28; i++) {
  const shot = (await page.screenshot({ clip: wall })).toString('base64');
  const clocks = await page.evaluate(() => { const s = window.__n.motionStatus(); return { t: s.lampTicks, w: s.lamps }; });
  series.push({ ...clocks, shot, ...(await page.evaluate(async ({ shot, width, height }) => {
    const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${shot}`)).blob());
    const buffer = new OffscreenCanvas(image.width, image.height);
    const context = buffer.getContext('2d');
    context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, image.width, image.height).data;
    let sum = 0, count = 0, bright = 0, brightSum = 0;
    for (let i = 0; i < data.length; i += 4) {
      const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      sum += luma; count++;
      if (luma > 120) { bright++; brightSum += luma; }
    }
    return { mean: Math.round(sum / count * 10) / 10, brightPx: bright,
      brightMean: bright ? Math.round(brightSum / bright * 10) / 10 : 0 };
  }, { shot, width: wall.width, height: wall.height })) });
  await page.waitForTimeout(500);
}
const means = series.map((row) => row.mean);
const brights = series.map((row) => row.brightPx);
const spread = (list) => Math.round((Math.max(...list) - Math.min(...list)) * 10) / 10;
console.log('时间序列（每 500 ms 一点，共 14 s）：');
console.log(series.map((row) => `${row.mean}/${row.brightPx}/w${row.w.map((v) => Math.round(v * 100)).join(',')}`).join('  '));
console.log(`\n墙面平均亮度：min ${Math.min(...means)} max ${Math.max(...means)} 全距 ${spread(means)}`);
console.log(`亮着的窗格像素数：min ${Math.min(...brights)} max ${Math.max(...brights)} 全距 ${spread(brights)}`
  + `（占这块墙 ${(Math.max(...brights) / (wall.width * wall.height) * 100).toFixed(1)} %）`);
console.log('灯窗拍在走吗：', series[0].t, '→', series[series.length - 1].t);

// 上面两个量都看不见"换的是哪几格"：交叉淡的设计就是出去几格进来几格，总量天生不动。
// 所以要直接量"哪几格"：取组 0 权重最远的一对帧做差，再取权重几乎相同的一对做噪声地板（车流、塔身、江面
// 在这块框里也会动）。不改样式，所以不踩 #114 那个重图集陷阱。
const pair = async (a, b) => page.evaluate(async ({ a, b }) => {
  const load = async (source) => {
    const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${source}`)).blob());
    const buffer = new OffscreenCanvas(image.width, image.height);
    const context = buffer.getContext('2d');
    context.drawImage(image, 0, 0);
    return { width: image.width, height: image.height, data: context.getImageData(0, 0, image.width, image.height).data };
  };
  const x = await load(a), y = await load(b);
  let moved = 0, sum = 0;
  for (let i = 0; i < x.data.length; i += 4) {
    const d = Math.abs(x.data[i] - y.data[i]) + Math.abs(x.data[i + 1] - y.data[i + 1]) + Math.abs(x.data[i + 2] - y.data[i + 2]);
    if (d > 6) { moved++; sum += d; }
  }
  return { moved, of: x.width * x.height, meanDelta: moved ? Math.round(sum / moved) : 0 };
}, { a, b });
const weightOf = (row) => row.w[0];
const highest = series.reduce((a, b) => (weightOf(b) > weightOf(a) ? b : a));
const lowest = series.reduce((a, b) => (weightOf(b) < weightOf(a) ? b : a));
const neighbours = series[3];
const crossFade = await pair(highest.shot, lowest.shot);
const noiseFloor = await pair(neighbours.shot, series[4].shot);
console.log(`\n组 0 权重 ${Math.round(weightOf(highest) * 100)} → ${Math.round(weightOf(lowest) * 100)} 这一对：这块墙里变了 ${JSON.stringify(crossFade)}`);
console.log(`同一对权重相邻 500 ms（噪声地板：车流/塔身/江面也在这块框里）：${JSON.stringify(noiseFloor)}`);
console.log(`⇒ 换窗真正改到的像素 ≈ ${crossFade.moved - noiseFloor.moved} 颗，占这块墙 `
  + `${((crossFade.moved - noiseFloor.moved) / (wall.width * wall.height) * 100).toFixed(2)} %`);
await browser.close();
