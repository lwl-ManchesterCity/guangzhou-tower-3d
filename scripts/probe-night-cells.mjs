// 夜景灯火两层的取样：门控（三种氛围各读一次可见性与不透明度）、逐楼格号（几何里的 aLampCell 分布 vs 数据本身算出来的）。
import { chromium } from '@playwright/test';
const app = process.env.APP_URL || 'http://127.0.0.1:5174';
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
await page.goto(`${app}/?scene=canton&engine=three#map=15.5/23.1095/113.31913/-25/62`);
await page.waitForFunction(() => document.querySelector('.engine-stats')?.textContent?.includes('fps'), { timeout: 120000 });
await page.evaluate(async () => {
  const { neighborhood: n } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
  window.__probe = { n };
});

for (const mode of ['day', 'sunset', 'night']) {
  await page.locator(`[data-atmosphere-option="${mode}"]`).click();
  await page.waitForTimeout(1200);
  const state = await page.evaluate(() => {
    const rows = [];
    window.__probe.n.scene.traverse((object) => {
      if (!/^building-(lamps|glow)-/.test(object.name ?? '')) return;
      rows.push({ name: object.name, visible: object.visible, opacity: Math.round(object.material.opacity * 100) / 100,
        renderOrder: object.renderOrder, cells: object.material.map?.image?.width });
    });
    return { rows, counts: window.__probe.n.counts(),
      drawCalls: window.__probe.n.counts().drawCalls };
  });
  console.log(mode, JSON.stringify(state.rows.map((r) => `${r.name.slice(0, 17)}:${r.visible}/${r.opacity}/o${r.renderOrder}`)));
  console.log('  counts', JSON.stringify(state.counts));
}

const cells = await page.evaluate(async () => {
  const { lampCellOf, LAMP_OFF_ROW, LAMP_GRID } = await import('/src/engine/facades.js');
  const { drawnHeight } = await import('/src/engine/buildings.js');
  const features = (await (await fetch('/data/canton-buildings.geojson')).json()).features;
  // 与分桶同一把筛子：环不够长的楼不进几何，也就不该出现在格号里。
  const kept = features.filter((feature) => {
    const ring = feature.geometry.type === 'Polygon' ? feature.geometry.coordinates[0] : feature.geometry.coordinates[0]?.[0];
    return ring && ring.length >= 4;
  });
  const expected = new Map();
  for (const feature of kept) {
    const category = String(feature.properties?.category ?? 'unknown');
    const cell = lampCellOf({ height: drawnHeight(feature), osmId: Number(feature.properties?.osmId) || 0,
      distance: Number(feature.properties?.distance) || 0 });
    const key = `${cell.col},${cell.row}`;
    if (!expected.has(category)) expected.set(category, new Map());
    expected.get(category).set(key, (expected.get(category).get(key) ?? 0) + 1);
  }
  const observed = [];
  window.__probe.n.scene.traverse((object) => {
    if (!/^building-lamps-/.test(object.name ?? '')) return;
    const attribute = object.geometry.getAttribute('aLampCell');
    if (!attribute) { observed.push({ name: object.name, missing: true }); return; }
    const pairs = new Map();
    let dark = 0;
    for (let i = 0; i < attribute.count; i++) {
      const key = `${attribute.getX(i)},${attribute.getY(i)}`;
      pairs.set(key, (pairs.get(key) ?? 0) + 1);
      if (attribute.getY(i) === LAMP_OFF_ROW) dark++;
    }
    observed.push({ name: object.name, category: object.userData.category, vertices: attribute.count,
      distinct: pairs.size, darkVertexShare: Math.round(dark / attribute.count * 1000) / 10,
      expectedDistinct: expected.get(object.userData.category)?.size ?? 0,
      expectedMissing: [...(expected.get(object.userData.category)?.keys() ?? [])].filter((key) => !pairs.has(key)),
      unexpected: [...pairs.keys()].filter((key) => !expected.get(object.userData.category)?.has(key)),
      rows: [...new Set([...pairs.keys()].map((key) => Number(key.split(',')[1])))].sort((a, b) => a - b),
      cols: [...new Set([...pairs.keys()].map((key) => Number(key.split(',')[0])))].sort((a, b) => a - b),
      maxPairShare: Math.round(Math.max(...pairs.values()) / attribute.count * 100) });
  });
  return { grid: LAMP_GRID, blocks: kept.length, features: features.length, observed };
});
console.log(JSON.stringify({ grid: cells.grid, blocks: cells.blocks, features: cells.features }, null, 1));
for (const row of cells.observed) console.log(JSON.stringify(row));
await browser.close();
