// 地面覆盖对账（常驻工具）：`node scripts/surface-coverage-audit.mjs`，需要 dev 预览在 127.0.0.1:5174。
// 它量的是"新引擎本地取的那三份面，盖没盖住底图原本画的那四层"——2026-10-04 第一跑就抓到
// `prepare-canton-surface.mjs` 里一条写错的规则（118 个 landuse=grass 面静默漏掉），所以每次重取数之后都该再跑一遍。
// 判据本身在 tests/engine.test.js（来源、数量、江心落点、洞、kind 全覆盖）与 tests/engine.browser.spec.js（面板名册、
// 像素等于调色板、draw call 门槛）；这一份出的是"差在哪一类"，不是通过/失败。
// 对账方法：在现版（瓦片引擎）开屏机位上撒一张屏幕格点，每格问两件事——
//   ① 底图在这一格画的是哪一层（water / landcover / landuse / park / background），按 Liberty 的压色顺序取最上面那一层；
//   ② 同一格反投回经纬度，落在本地新取的哪一份面上（水 / 绿 / 地块）。
// 两边答不上来的格数就是"取漏了"或"多取了"。
import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const appUrl = 'http://127.0.0.1:5174';
const START = '#map=15.5/23.1095/113.31913/-25/62';
const WIDE = '#map=12.6/23.1095/113.31913/0/58';
const NEAR = '#map=17/23.1112/113.3225/-25/66';

const read = async (name) => JSON.parse(await readFile(`public/data/${name}.geojson`, 'utf8'));
const files = { water: await read('canton-water'), greens: await read('canton-greens'), blocks: await read('canton-blocks') };
const inRing = (ring, lng, lat) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lng < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
const covers = (geometry, lng, lat) => {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  return polygons.some((rings) => inRing(rings[0], lng, lat) && !rings.slice(1).some((hole) => inRing(hole, lng, lat)));
};
const localClass = (lng, lat) => {
  for (const group of ['water', 'greens', 'blocks']) if (files[group].features.some((f) => covers(f.geometry, lng, lat))) return group;
  return 'none';
};

const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });

async function open(page, engine, hash) {
  await page.goto('about:blank');
  await page.goto(`${appUrl}/?scene=canton${engine === 'three' ? '&engine=three' : ''}${hash}`);
  if (engine === 'three') {
    await page.waitForFunction(() => document.querySelector('.engine-stats')?.textContent?.includes('fps'), { timeout: 180000 });
    await page.waitForTimeout(1500);
    return;
  }
  await page.waitForSelector('#places-toggle:not([disabled])', { timeout: 240000 });
  await page.waitForTimeout(3000);
}

const page = await context.newPage();
await open(page, 'maplibre', START);
const grid = await page.evaluate(async () => {
  const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
  const m = neighborhood.map;
  const style = m.getStyle().layers;
  const ids = (sourceLayer) => style.filter((l) => l.source === 'openmaptiles' && l['source-layer'] === sourceLayer && l.type === 'fill').map((l) => l.id);
  const groups = [['water', ids('water')], ['landcover', ids('landcover')], ['landuse', ids('landuse')], ['park', ids('park')]];
  const rows = [];
  for (let y = 260; y <= 950; y += 12) for (let x = 10; x <= 1430; x += 12) {
    let tile = 'background', detail = null;
    for (const [name, layerIds] of groups) {
      if (!layerIds.length) continue;
      const hits = m.queryRenderedFeatures([[x, y], [x, y]], { layers: layerIds });
      if (hits.length) {
        tile = name;
        detail = { layer: hits[0].layer?.id ?? null, class: hits[0].properties?.class ?? null, subclass: hits[0].properties?.subclass ?? null };
        break;
      }
    }
    const point = m.unproject({ x: x + 0.5, y: y + 0.5 });
    rows.push({ x, y, tile, detail, lng: point.lng, lat: point.lat });
  }
  return rows;
});
await page.close();

const tally = new Map();
const mismatch = [];
for (const cell of grid) {
  const mine = localClass(cell.lng, cell.lat);
  const key = `${cell.tile}→${mine}`;
  tally.set(key, (tally.get(key) ?? 0) + 1);
  const agrees = (cell.tile === 'water' && mine === 'water')
    || (['park', 'landcover', 'landuse'].includes(cell.tile) && (mine === 'greens' || mine === 'blocks'))
    || (cell.tile === 'background' && mine === 'none');
  if (!agrees && mismatch.length < 12) mismatch.push({ ...cell, mine });
}
const total = grid.length;
console.log(`格点 ${total} 个（现版压色顺序 water>landcover>landuse>park）`);
for (const [key, n] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`  ${key.padEnd(24)} ${String(n).padStart(5)}  ${(n * 100 / total).toFixed(1)}%`);
console.log('不一致样本：', JSON.stringify(mismatch.slice(0, 4)));

// 底图在那一格画得出来、本地矢量答不上来的，到底是 OMT 的哪个 class
const gaps = new Map();
for (const cell of grid) {
  if (localClass(cell.lng, cell.lat) !== 'none' || !cell.detail) continue;
  const key = `${cell.tile}:${cell.detail.layer}/${cell.detail.class}/${cell.detail.subclass ?? ''}`;
  const entry = gaps.get(key) ?? { n: 0, sample: cell };
  entry.n++;
  gaps.set(key, entry);
}
for (const [key, entry] of [...gaps].sort((a, b) => b[1].n - a[1].n).slice(0, 14)) {
  console.log(`  漏 ${String(entry.n).padStart(4)} 格 ${key.padEnd(44)} 例 ${entry.sample.lng.toFixed(5)},${entry.sample.lat.toFixed(5)}`);
}

await browser.close();
