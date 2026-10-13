// V7 阶段 A 的量尺：把夜景画面按十档亮度预算归并，逐档给读数，并做眯眼模拟。
//
//   node scripts/night-budget-meter.mjs            # 三机位逐档读数
//   node scripts/night-budget-meter.mjs --json     # 同一份数据，机器读
//
// 归档不靠颜色猜。每个采样点先问地图"这个位置画的是哪个图层"，图层答不上来的（three.js 的塔与壳体）按画面算：
// 同一机位拍白昼与夜景两张，逐像素取差，差值连成的竖条就是那个要素在屏幕上的真实高度——因为 `map.project` 只吃一个
// 参数（源码 `project(e) { return this._camera.transform.locationToScreenPoint(...) }`），标高会被静默丢掉，
// 所以塔有多高不能靠投影，只能量。
//
// 采样前把动效关掉：窗灯固定在出厂那批、障碍灯停在周期峰顶，两次跑出来的数才可比。
//
// 第 4 档给两行读数。「亮窗」整档按图层归并，采样点落在楼脚印到的每一个格子上，而一格只有中间一小块是窗——所以它的
// 中位数其实是"透过灯的墙"，跟"这扇窗有多亮"不是一回事。为此每个机位多拍一张"只关窗、不关晕"的夜景：同一像素两次
// 亮度之差就是窗自己那份贡献，差得过 4 的像素才进「亮窗（灯芯）」。文档的死标准（塔身主体不得超过旁边普通楼的亮窗）
// 读的是灯芯那一行，不是含间隙的那一行。
import { chromium } from 'playwright';
import { BELOW_TOLERANCE, NIGHT_BANDS, bandOf } from '../src/night-budget.js';

const appUrl = process.env.APP_URL || 'http://127.0.0.1:5174';
const executablePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const asJson = process.argv.includes('--json');

// 文档点名的三个机位：广州塔位（出厂首屏）、北岸中轴位、高空位。
const CAMERAS = [
  { name: '广州塔位', camera: null },
  { name: '北岸中轴位', camera: { center: [113.319181, 23.122579], zoom: 15.4, pitch: 62, bearing: 180 } },
  { name: '高空位', camera: { center: [113.31913, 23.114], zoom: 13.6, pitch: 55, bearing: 0 } },
];

// 档位、代表图层与标签都取自 `src/night-budget.js`：这份量尺只是那张表的执行器，改档位得先改表。
const BANDS = Object.fromEntries(NIGHT_BANDS.map((entry) => [String(entry.band), entry]));
const WINDOW_LAYERS = BANDS['4b'].layers;
// The meter wants band -> layers; `layerBands()` is the inverse and exists for the duplicate check in the tests.
const BAND_LAYERS = Object.fromEntries(NIGHT_BANDS.filter((entry) => !entry.sub && entry.layers.length)
  .map((entry) => [entry.band, entry.layers]));
const LABELS = Object.fromEntries(NIGHT_BANDS.map((entry) => [entry.band, entry.label]));
const CROWN_FROM = { 511404889: 0.74, 184738716: 0.81 };

const browser = await chromium.launch({ executablePath });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const problems = [];
page.on('pageerror', (error) => problems.push(error.message));
await page.goto(`${appUrl}/?scene=canton`);
await page.waitForSelector('#places-toggle:not([disabled])', { timeout: 180000 });

const settle = () => page.evaluate(async () => {
  const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
  while (neighborhood.atmosphere.running) await new Promise((resolve) => setTimeout(resolve, 50));
  await new Promise((resolve) => { neighborhood.map.once('idle', resolve); neighborhood.map.triggerRepaint(); });
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
});
await page.evaluate(async () => {
  const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
  if (neighborhood.motionStatus().on) neighborhood.setMotion(false);
});
// `NO_TRAFFIC=1` takes the near-field vehicles out of the picture, to tell a road that is bright from a road that is
// bright because a car is standing on it.
if (process.env.NO_TRAFFIC) await page.evaluate(async () => {
  const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
  neighborhood.map.getLayer('canton-tower').implementation.setTraffic(false);
});

const shot = async () => {
  const clip = await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const box = neighborhood.map.getCanvas().getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  });
  return (await page.screenshot({ clip })).toString('base64');
};

const results = [];
for (const { name, camera } of CAMERAS) {
  await page.evaluate(async (camera) => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    if (camera) neighborhood.map.jumpTo(camera);
    await new Promise((resolve) => { neighborhood.map.once('idle', resolve); neighborhood.map.triggerRepaint(); });
  }, camera);
  await page.waitForTimeout(900);
  await page.locator('[data-atmosphere-option="day"]').click();
  await settle();
  await page.waitForTimeout(900);
  const day = await shot();
  await page.locator('[data-atmosphere-option="night"]').click();
  await settle();
  await page.waitForTimeout(1200);
  const night = await shot();
  // 只关窗、不关晕：这张与上一张同一像素的亮度差，就是窗自己那份贡献。
  const setWindows = async (visibility) => {
    await page.evaluate(async ({ ids, visibility }) => {
      const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
      for (const id of ids) neighborhood.map.setLayoutProperty(id, 'visibility', visibility);
      await new Promise((resolve) => { neighborhood.map.once('idle', resolve); neighborhood.map.triggerRepaint(); });
    }, { ids: WINDOW_LAYERS, visibility });
    await page.waitForTimeout(400);
  };
  await setWindows('none');
  const noWindows = await shot();
  await setWindows('visible');
  results.push(await page.evaluate(async ({ day, night, noWindows, name, BAND_LAYERS, LABELS, BANDS, CROWN_FROM }) => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const { LANDMARKS } = await import('/src/landmarks.js');
    const map = neighborhood.map;
    const load = async (base64) => {
      const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
      const canvas = new OffscreenCanvas(image.width, image.height);
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      return { data: context.getImageData(0, 0, image.width, image.height).data, width: image.width, height: image.height, image };
    };
    const [lit, dark, bare] = await Promise.all([load(night), load(day), load(noWindows)]);
    // 眯眼：1/8 降采样再模糊一次，模拟"只剩大块明暗"的看法。
    const squint = new OffscreenCanvas(Math.round(lit.width / 8), Math.round(lit.height / 8));
    const squintContext = squint.getContext('2d');
    squintContext.filter = 'blur(1px)';
    squintContext.drawImage(lit.image, 0, 0, squint.width, squint.height);
    const squintData = squintContext.getImageData(0, 0, squint.width, squint.height).data;

    const luma = (array, offset) => 0.2126 * array[offset] + 0.7152 * array[offset + 1] + 0.0722 * array[offset + 2];
    const deltaAt = (x, y) => {
      const offset = (y * lit.width + x) * 4;
      return Math.max(Math.abs(lit.data[offset] - dark.data[offset]), Math.abs(lit.data[offset + 1] - dark.data[offset + 1]),
        Math.abs(lit.data[offset + 2] - dark.data[offset + 2]));
    };
    // 塔顶落在屏幕哪一格不能靠投影：`map.project` 只吃一个参数（源码 `project(e) { return ...locationToScreenPoint(...) }`），
    // 标高被静默丢掉。V7 那一轮这一格是按三盏障碍灯的红色找的（`#ff4a30` 加性混合，全画面唯一强红）；2026-10-04 用户
    // 裁定把红圈撤了，所以改问**隐形命中盒**——`canton-tower-hit` / `landmark-forms-hit` 是按同一份 footprint 挤到本体
    // 高度的，从上往下扫到第一次命中就是那个要素在画面里的顶，地面点是它的脚。
    const hitLayer = (osmId) => (osmId === 584204634 ? 'canton-tower-hit' : 'landmark-forms-hit');
    const ownAt = (osmId, x, y) => {
      if (!map.getLayer(hitLayer(osmId))) return false;
      return map.queryRenderedFeatures([[x, y], [x, y]], { layers: [hitLayer(osmId)] })
        .some((feature) => String(feature.properties?.osmId) === String(osmId));
    };
    const footprintHalf = (landmark, fallback) => {
      const id = landmark.osmId === 584204634 ? 'canton-tower-hit' : 'landmark-forms-hit';
      const point = map.project(landmark.center);
      const hit = map.getLayer(id) ? map.queryRenderedFeatures(point, { layers: [id] })[0] : null;
      const ring = hit?.geometry?.type === 'Polygon' ? hit.geometry.coordinates[0] : hit?.geometry?.coordinates?.[0]?.[0];
      if (!ring) return fallback;
      const xs = ring.map(([lng, lat]) => map.project([lng, lat]).x);
      return Math.max(6, (Math.max(...xs) - Math.min(...xs)) / 2);
    };
    const regions = [];
    const barFor = (landmark, fallbackHalf) => {
      const ground = map.project(landmark.center);
      const half = footprintHalf(landmark, fallbackHalf);
      const left = Math.max(0, Math.round(ground.x - half)), right = Math.min(lit.width - 1, Math.round(ground.x + half));
      // Top down, and stop at the first hit: the hit box is a solid volume, so scanning *up* from the foot returns the
      // row one step above where it started - measured, that turns a 440 px shaft into a 3 px stub and moves every
      // number on the bar. The 24 px floor is what makes a bad anchor read as "no reading" instead of nonsense.
      let top = null;
      for (let y = 0; top === null && y <= ground.y - 24; y += 3) {
        for (let x = left; x <= right && top === null; x += 6) if (ownAt(landmark.osmId, x, y)) top = y;
      }
      if (top === null) return null;
      return { x: ground.x, top, bottom: ground.y, half };
    };
    for (const landmark of LANDMARKS.filter((entry) => CROWN_FROM[entry.osmId])) {
      const bar = barFor(landmark, 26);
      if (!bar) continue;
      // 命中盒的顶就是壳体的顶，往上留 2 px 吃掉抗锯齿，剩下的按 `crownFrom` 切成冠段与身段。
      const split = bar.top + (bar.bottom - bar.top) * (1 - CROWN_FROM[landmark.osmId]);
      regions.push({ band: 1, x: bar.x, half: bar.half, top: bar.top - 2, bottom: split });
      regions.push({ band: 1.5, x: bar.x, half: bar.half, top: split, bottom: bar.bottom });
    }
    const tower = LANDMARKS.find((landmark) => landmark.osmId === 584204634);
    const towerBar = barFor(tower, 46);
    if (towerBar) {
      const height = towerBar.bottom - towerBar.top;
      regions.push({ band: 1, x: towerBar.x, half: towerBar.half, top: towerBar.top - 2, bottom: towerBar.top + height * 0.12 });
      regions.push({ band: 2, x: towerBar.x, half: towerBar.half, top: towerBar.top + height * 0.12, bottom: towerBar.bottom });
    }

    const plateBoxes = [...document.querySelectorAll('.landmark')].filter((node) => getComputedStyle(node).visibility !== 'hidden')
      .map((node) => node.getBoundingClientRect());
    const order = map.getStyle().layers.filter((layer) => ['fill', 'line', 'fill-extrusion'].includes(layer.type)).map((layer) => layer.id).reverse();
    const known = new Set(Object.values(BAND_LAYERS).flat());
    const keys = Object.keys(LABELS).filter((key) => !BANDS[key].sub).map(Number);
    const bucket = new Map(keys.map((band) => [band, { values: [], squint: [], delta: [], core: [], coreSquint: [], coreDelta: [] }]));
    const step = 3;
    for (let y = 0; y < lit.height; y += step) {
      for (let x = 0; x < lit.width; x += step) {
        const offset = (y * lit.width + x) * 4;
        if (lit.data[offset + 3] !== 255) continue;
        let band = null;
        for (const region of regions) {
          if (x >= region.x - region.half && x <= region.x + region.half && y >= region.top && y <= region.bottom) { band = region.band; break; }
        }
        if (band === null && plateBoxes.some((box) => x >= box.left && x <= box.right && y >= box.top && y <= box.bottom)) band = 3;
        if (band === null) {
          const hit = order.find((id) => known.has(id) && map.queryRenderedFeatures([x, y], { layers: [id] }).length > 0);
          if (hit) band = Number(Object.entries(BAND_LAYERS).find(([, ids]) => ids.includes(hit))[0]);
        }
        if (band === null) continue;
        const row = bucket.get(band);
        row.values.push(luma(lit.data, offset));
        row.delta.push(Math.max(0, luma(lit.data, offset) - luma(dark.data, offset)));
        row.squint.push(luma(squintData, (Math.floor(y / 8) * squint.width + Math.floor(x / 8)) * 4));
        // 关掉窗之后同一像素暗下去 4 以上，说明这里画的确实是窗而不是墙上的间隙。
        if (band === 4 && luma(lit.data, offset) - luma(bare.data, offset) > 4) {
          row.core.push(luma(lit.data, offset));
          row.coreDelta.push(Math.max(0, luma(lit.data, offset) - luma(dark.data, offset)));
          row.coreSquint.push(luma(squintData, (Math.floor(y / 8) * squint.width + Math.floor(x / 8)) * 4));
        }
      }
    }
    const quantile = (list, q) => {
      if (!list.length) return null;
      const sorted = [...list].sort((a, b) => a - b);
      return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] * 10) / 10;
    };
    const stats = (list, squintList, deltaList) => ({ n: list.length, median: quantile(list, 0.5), p90: quantile(list, 0.9),
      p999: quantile(list, 0.999), litDelta: quantile(deltaList, 0.9), squintMedian: quantile(squintList, 0.5), squintP90: quantile(squintList, 0.9) });
    return { camera: name, size: [lit.width, lit.height], regions: regions.map((region) => `${region.band}@${Math.round(region.x)},${Math.round(region.top)}→${Math.round(region.bottom)}`),
      rows: [...bucket.entries()].sort((a, b) => a[0] - b[0]).flatMap(([band, row]) => {
        const all = { band, label: LABELS[band], ...stats(row.values, row.squint, row.delta) };
        // 灯芯只有在确实筛出像素时才是读数；高空位没有楼在灯层的最小缩放里画得出窗，那一行就是空，如实留着。
        return row.values.length ? (row.core.length ? [all, { band, kind: 'core', label: `${LABELS[band]}（灯芯）`,
          ...stats(row.core, row.coreSquint, row.coreDelta) }] : [all]) : [all];
      }) };
  }, { day, night, noWindows, name, BAND_LAYERS, LABELS, BANDS, CROWN_FROM }));
}

// 逐档判合规：绝对值对 `range`，先后顺序对 `below`，两者都只在同一机位内比。没有读数的档（高空位没有窗可穿）
// 如实跳过并在末尾点名，不当成通过。
const verdicts = results.map((result) => {
  const median = new Map(result.rows.map((row) => [String(row.kind === 'core' ? '4b' : row.band), row.median]));
  const out = [];
  for (const entry of NIGHT_BANDS) {
    const key = String(entry.band);
    const value = median.get(key);
    if (!entry.range) { out.push({ band: key, ungraded: true }); continue; }
    if (value === null || value === undefined) { out.push({ band: key, missing: true }); continue; }
    const [lo, hi] = entry.range;
    if (value < lo) out.push({ band: key, over: `低于区间 ${value} < ${lo}` });
    else if (value > hi) out.push({ band: key, over: `高于区间 ${value} > ${hi}` });
    for (const target of entry.below) {
      if (!bandOf(target)?.range) continue;
      const above = median.get(String(target));
      if (above === null || above === undefined) continue;
      if (value > above + BELOW_TOLERANCE) out.push({ band: key, over: `压过了本应更亮的第 ${target} 档（${value} > ${above}）` });
    }
  }
  return { camera: result.camera, rows: out };
});
const violations = verdicts.flatMap((verdict) => verdict.rows
  .filter((row) => row.over)
  .map((row) => `${verdict.camera} 第 ${row.band} 档：${row.over}`));
const missing = verdicts.flatMap((verdict) => verdict.rows
  .filter((row) => row.missing)
  .map((row) => `${verdict.camera} 第 ${row.band} 档`));

if (asJson) console.log(JSON.stringify({ results, verdicts, violations, missing }, null, 1));
else {
  for (const result of results) {
    console.log(`\n${result.camera}  画面 ${result.size.join('×')}  竖条 ${result.regions.join(' ')}`);
    console.log('档位 | 元素 | 区间 | 采样 | 中位 | p90 | p99.9 | 夜景比白昼亮 | 眯眼中位 | 眯眼p90 | 判定');
    const verdict = verdicts.find((entry) => entry.camera === result.camera);
    for (const row of result.rows) {
      const key = String(row.kind === 'core' ? '4b' : row.band);
      const row0 = verdict.rows.find((entry) => entry.band === key) ?? {};
      const note = row0.over ?? (BANDS[key].range ? (row.median === null ? '无读数' : '合规') : '不判（竖条中位量的是天）');
      console.log(`${key} | ${row.label} | ${(BANDS[key].range ?? []).join('~')} | ${row.n} | ${row.median} | ${row.p90} | ${row.p999} | ${row.litDelta} | ${row.squintMedian} | ${row.squintP90} | ${note}`);
    }
  }
  console.log(violations.length ? `\n越档 ${violations.length} 处：\n  ${violations.join('\n  ')}` : '\n预算表在可判的档位上全档合规（三机位，绝对区间与先后顺序；不判的三档见 night-budget.js 的注释）');
  if (missing.length) console.log(`无读数（不算通过，也不判违规）：${missing.join('、')}`);
}
if (violations.length) process.exitCode = 1;
if (problems.length) console.log('\n页面异常：' + problems.join(' | '));
await browser.close();
