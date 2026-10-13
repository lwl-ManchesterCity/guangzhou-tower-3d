// 动效现状量数：① 各氛围各机位问一次"时钟走不走"（`motionStatus()` 的计数器差）与"画面变了多少颗像素"；
// ② 夜景把两组亮窗的权重钉到两端各拍一张，量"换窗交叉淡"的真实幅度——整幅与一块墙分开给，因为整幅里
// 车流光带与塔身会盖过窗。只读不改产品代码：`setGlobalStateProperty` 就是动效循环自己走的那条通道。
import { chromium } from '@playwright/test';
const app = process.env.APP_URL || 'http://127.0.0.1:5174';
// 细部框：开屏机位上最近那一排 112 m 的楼（osmId 735437864~735437869）落在这一带。
const wall = { x: 620, y: 520, width: 300, height: 200 };
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });

const cases = [
  { mode: 'day', camera: '#map=15.5/23.1095/113.31913/-25/62' },
  { mode: 'day', camera: '#map=17/23.1095/113.31913/-25/62' },
  { mode: 'sunset', camera: '#map=15.5/23.1095/113.31913/-25/62' },
  { mode: 'night', camera: '#map=15.5/23.1095/113.31913/-25/62' },
];

const clocks = (page) => page.evaluate(() => ({ ...window.__n.motionStatus(), near: window.__n.nearTraffic() }));
const moved = async (page, pairs, clip) => page.evaluate(async ({ list, clip: box }) => {
  const load = async (source) => {
    const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${source}`)).blob());
    const buffer = new OffscreenCanvas(image.width, image.height);
    const context = buffer.getContext('2d');
    context.drawImage(image, 0, 0);
    return { width: image.width, data: context.getImageData(0, 0, image.width, image.height).data };
  };
  const out = [];
  for (const [a, b] of list) {
    const x = await load(a), y = await load(b);
    let moved = 0, sum = 0, peak = 0;
    const x0 = box ? box.x : 0, y0 = box ? box.y : 0;
    const x1 = box ? box.x + box.width : x.width, y1 = box ? box.y + box.height : 960;
    for (let py = y0; py < y1; py++) for (let px = x0; px < x1; px++) {
      const i = (py * x.width + px) * 4;
      const d = Math.abs(x.data[i] - y.data[i]) + Math.abs(x.data[i + 1] - y.data[i + 1]) + Math.abs(x.data[i + 2] - y.data[i + 2]);
      if (d > 6) { moved++; sum += d; peak = Math.max(peak, d); }
    }
    out.push({ moved, meanDelta: moved ? Math.round(sum / moved) : 0, peak });
  }
  return out;
}, { list: pairs, clip });

for (const item of cases) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  await page.goto('about:blank');
  await page.goto(`${app}/?scene=canton&atmosphere=${item.mode}${item.camera}`);
  await page.waitForSelector('#places-toggle:not([disabled])', { timeout: 180000 });
  await page.locator(`[data-atmosphere-option="${item.mode}"]`).click();
  await page.waitForTimeout(3200);
  await page.evaluate(async () => {
    const { neighborhood: n } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    window.__n = n;
  });
  const before = await clocks(page);
  await page.waitForTimeout(2400);
  const after = await clocks(page);
  const frames = [];
  for (let i = 0; i < 5; i++) { frames.push((await page.screenshot()).toString('base64')); await page.waitForTimeout(600); }
  const pairs = [];
  for (let i = 0; i + 1 < frames.length; i++) pairs.push([frames[i], frames[i + 1]]);
  console.log(`\n== ${item.mode} @ ${item.camera.match(/#map=([\d.]+)/)[1]}`);
  console.log('  2.4 s 时钟差：近场', after.lights - before.lights, '/ 江面拍', after.steps - before.steps,
    '/ 光带步进', after.marches - before.marches, '/ 灯窗拍', after.lampTicks - before.lampTicks,
    '/ 灯权重', JSON.stringify(before.lamps), '→', JSON.stringify(after.lamps));
  console.log('  近场读数：', JSON.stringify(after.near));
  console.log('  连拍每 600 ms 变动像素：', JSON.stringify(await moved(page, pairs)));
  if (item.mode === 'night') {
    // 先关动效，否则循环每拍都会把权重写回去，量到的就是抖动不是幅度。
    await page.evaluate(() => window.__n.setMotion(false));
    await page.waitForTimeout(700);
    const forced = [];
    for (const [key, value] of [['lamp-0', 1], ['lamp-0', 0]]) {
      await page.evaluate(({ key, value }) => window.__n.map.setGlobalStateProperty(key, value), { key, value });
      await page.waitForTimeout(700);
      forced.push((await page.screenshot()).toString('base64'));
    }
    const [whole] = await moved(page, [[forced[0], forced[1]]]);
    const [crop] = await moved(page, [[forced[0], forced[1]]], wall);
    console.log('  换窗幅度（把 lamp-0 从 1 钉到 0）：整幅', JSON.stringify(whole), '/ 墙面细部', JSON.stringify(crop));
    await page.evaluate(() => window.__n.map.setGlobalStateProperty('lamp-0', 1));
    await page.evaluate(() => window.__n.setMotion(true));
  }
  await page.close();
}
await browser.close();
