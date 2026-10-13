// #114 的取证：把那条判据的动作重放一遍（夜里 → 停动效 → 取基线 → 开动效跑够换窗 → 再停），
// 沿途记录基线之后发生的每一笔样式写入（五层灯的 visibility、灯窗权重、江面图、光轨虚线），
// 最后把"停下那一帧"与基线逐像素比，报出差异像素数与差异包围盒。目的不是让它绿，是看差异长在哪一块。
import { chromium } from '@playwright/test';

const appUrl = process.env.APP_URL || 'http://127.0.0.1:5174';
const CLIP = { x: 620, y: 300, width: 720, height: 460 };
const LAMP_IDS = ['building-lights', 'building-lights-alt', 'building-lights-2', 'building-lights-2-alt', 'building-glow'];

const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
page.on('pageerror', (error) => console.log('pageerror:', error.message));
page.on('console', (message) => { if (['error', 'warning'].includes(message.type())) console.log('console:', message.text()); });
await page.goto(appUrl);
await page.waitForSelector('#places-toggle', { timeout: 60000 });
await page.waitForFunction(async () => {
  const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
  return neighborhood.map.loaded() && !neighborhood.map.isMoving();
}, null, { timeout: 60000 });
await page.waitForTimeout(2000);

await page.evaluate(async (LAMP_IDS) => {
  const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
  const map = neighborhood.map;
  window.__log = [];
  window.__mark = (phase) => window.__log.push({ phase, at: Math.round(performance.now()) });
  const wrap = (name, host) => {
    const original = host[name].bind(host);
    host[name] = (...args) => {
      if (window.__armed) {
        const key = String(args[0]);
        if (name !== 'setLayoutProperty' || LAMP_IDS.includes(key) || key === 'canton-tower') {
          window.__log.push({ call: name, args: args.slice(0, 3).map((a) => JSON.stringify(a).slice(0, 60)) });
        }
      }
      return original(...args);
    };
  };
  ['setLayoutProperty', 'setPaintProperty', 'setGlobalStateProperty', 'updateImage', 'addImage'].forEach((m) => wrap(m, map));
}, LAMP_IDS);

const settle = async () => page.evaluate(async () => {
  const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
  const map = neighborhood.map;
  await new Promise((resolve) => { map.once('idle', resolve); map.triggerRepaint(); });
});

// 判据里基线不是"停下就拍一张"，而是先把两组权重手工写成 1/1 并等两帧相同；基线之后还要把五层灯
// 隐藏再打开、再写 0/1、0/0、1/1。这一段照抄那个顺序，否则量到的"能回帧"不是它那一遍。
const weights = async (a, b) => {
  await page.evaluate(async ([x, y]) => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const map = neighborhood.map;
    map.setGlobalStateProperty('lamp-0', x);
    map.setGlobalStateProperty('lamp-1', y);
    map.triggerRepaint();
    await new Promise((resolve) => map.once('idle', resolve));
  }, [a, b]);
  await page.waitForTimeout(700);
  const first = await page.screenshot({ clip: CLIP });
  // 与判据同一条口径：基线必须是"再要一帧还是它"，不是"连着两次读一样"。
  for (let i = 0; i < 40; i++) {
    await page.evaluate(async () => {
      const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
      await new Promise((resolve) => { neighborhood.map.once('idle', resolve); neighborhood.map.triggerRepaint(); });
    });
    if ((await page.screenshot({ clip: CLIP })).equals(first)) return first;
    await page.waitForTimeout(500);
  }
  return first;
};
const hideLamps = async () => {
  await page.evaluate(async (ids) => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const map = neighborhood.map;
    for (const id of ids) map.setLayoutProperty(id, 'visibility', 'none');
    map.triggerRepaint();
    await new Promise((resolve) => map.once('idle', resolve));
  }, LAMP_IDS);
  const bare = await page.screenshot({ clip: CLIP });
  await page.evaluate(async (ids) => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const map = neighborhood.map;
    for (const id of ids) map.setLayoutProperty(id, 'visibility', 'visible');
    map.triggerRepaint();
    await new Promise((resolve) => map.once('idle', resolve));
  }, LAMP_IDS);
  return bare;
};
const markers = () => page.evaluate((clip) => [...document.querySelectorAll('.marker')].map((node) => {
  const box = node.getBoundingClientRect();
  return { text: node.textContent.trim().slice(0, 8), x: Math.round(box.x), y: Math.round(box.y),
    inside: box.x > clip.x && box.x < clip.x + clip.width && box.y > clip.y && box.y < clip.y + clip.height };
}), CLIP);

// 氛围切换走真实那一次 1.2 s 的 walk（判据的基线就是在那之后、且动效已停的状态下取的），
// 然后照抄判据里的 32 s 漂移采样、五层灯隐藏再打开、三次手工权重，最后才用开关去还帧。
await page.evaluate(() => document.querySelector('[data-atmosphere-option="night"]').click());
await settle();
await page.waitForTimeout(1500);
const drift = await page.evaluate(async () => {
  const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
  const seen = [];
  for (let i = 0; i < 16; i++) {
    seen.push(neighborhood.motionStatus().lamps.slice());
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return seen;
});
console.log('漂移里两组真的错开过:', drift.some(([a, b]) => Math.abs(a - b) > 0.2));
await page.locator('#motion-toggle').click();
await page.waitForTimeout(2000);
const base = await weights(1, 1);
const markersBefore = await markers();
const bare = await hideLamps();
console.log('把五层灯关掉再打开，基线回得回来:', (await weights(1, 1)).equals(base), '｜关灯那张确实不同:', !bare.equals(base));
await weights(0, 1);
await weights(0, 0);
const handed = await weights(1, 1);
console.log('手工还权重能回基线:', handed.equals(base));

await page.evaluate(() => { window.__armed = true; window.__mark('baseline-taken'); });
await page.locator('#motion-toggle').click();
for (let i = 0; i < 40; i++) {
  const left = await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    return neighborhood.motionStatus().lamps.some((value) => value < 0.999);
  });
  if (left) break;
  await page.waitForTimeout(1000);
}
await page.evaluate(() => window.__mark('before-stop'));
await page.locator('#motion-toggle').click();
await page.waitForTimeout(1200);
await settle();
const after = await page.screenshot({ clip: CLIP });
await page.waitForTimeout(4000);
const after2 = await page.screenshot({ clip: CLIP });
const markersAfter = await markers();
await page.evaluate(() => window.__mark('after-shot'));
console.log('框内名牌（基线那一刻）:', JSON.stringify(markersBefore.filter((m) => m.inside)));
console.log('框内名牌（停下之后）:', JSON.stringify(markersAfter.filter((m) => m.inside)));

const diff = await page.evaluate(async ({ a, b }) => {
  const load = async (base64) => {
    const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
    const canvas = new OffscreenCanvas(image.width, image.height);
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, image.width, image.height);
    return { data: data.data, width: image.width, height: image.height };
  };
  const [from, to] = await Promise.all([load(a), load(b)]);
  let changed = 0, lit = 0;
  let box = { x0: 1e9, y0: 1e9, x1: -1, y1: -1 };
  const spots = [];
  for (let i = 0; i < from.data.length; i += 4) {
    const delta = Math.max(Math.abs(from.data[i] - to.data[i]), Math.abs(from.data[i + 1] - to.data[i + 1]), Math.abs(from.data[i + 2] - to.data[i + 2]));
    if (delta <= 8) continue;
    changed++;
    if (to.data[i] - to.data[i + 2] > 20 && to.data[i] > 40) lit++;
    const pixel = i / 4;
    const x = pixel % from.width, y = (pixel / from.width) | 0;
    box.x0 = Math.min(box.x0, x); box.y0 = Math.min(box.y0, y);
    box.x1 = Math.max(box.x1, x); box.y1 = Math.max(box.y1, y);
    if (spots.length < 400) spots.push([x, y, delta, from.data[i], to.data[i]]);
  }
  return { changed, lit, box, spots, size: [from.width, from.height] };
}, { a: base.toString('base64'), b: after.toString('base64') });

// 差异落在哪一层：把每个差异像素搬回页面坐标，问地图"这一格画的是哪个图层"。
if (diff.changed > 0) {
  const layers = await page.evaluate(async ({ spots, clip }) => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const map = neighborhood.map;
    const tally = {};
    for (const [x, y] of spots) {
      const px = clip.x + x, py = clip.y + y;
      const hits = map.queryRenderedFeatures([[px - 1, py - 1], [px + 1, py + 1]]);
      const key = hits.length ? [...new Set(hits.map((f) => f.layer.id))].join('+') : 'no feature';
      tally[key] = (tally[key] ?? 0) + 1;
    }
    return tally;
  }, { spots: diff.spots, clip: CLIP });
  diff.layers = layers;
}

const camera = await page.evaluate(async () => {
  const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
  const map = neighborhood.map;
  return { zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch(),
    lamps: neighborhood.motionStatus().lamps, near: neighborhood.nearTraffic() };
});
console.log('差异:', JSON.stringify(diff));
console.log('停下两帧相同:', after.equals(after2), '与基线相同:', base.equals(after));
console.log('镜头:', JSON.stringify(camera));
const log = await page.evaluate(() => window.__log);
const collapsed = [];
for (const entry of log) {
  const key = JSON.stringify(entry);
  if (collapsed[collapsed.length - 1]?.key !== key) collapsed.push({ key, count: 1 });
  else collapsed[collapsed.length - 1].count++;
}
console.log('基线之后的样式写入（合并相邻重复）:');
for (const entry of collapsed) console.log(' ', entry.count > 1 ? `x${entry.count}` : ' ', entry.key.slice(1, entry.key.length - 1).slice(0, 150));
await browser.close();
