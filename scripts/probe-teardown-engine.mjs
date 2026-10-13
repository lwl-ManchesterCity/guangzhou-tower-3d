// 一次性：#177 的现场盘点——把引擎场景图里每一样几何/材质/贴图点名，挂上 dispose 监听，
// 喊一次 `neighborhood.dispose()`，看谁没还。按「最近的有名祖先」分组统计，才知道漏的是哪一块。
import { chromium } from '@playwright/test';
const app = process.env.APP_URL || 'http://127.0.0.1:5174';
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
page.on('pageerror', (error) => console.log('page error:', error.message));
page.on('console', (message) => { if (message.type() === 'error') console.log('console error:', message.text()); });
const night = process.argv.includes('--night');
await page.goto(`${app}/?engine=three${night ? '&atmosphere=night' : ''}#map=15.5/23.1095/113.31913/-25/62`);
await page.waitForFunction(() => document.querySelector('.engine-stats')?.textContent?.includes('fps'), { timeout: 120000 });
await page.waitForTimeout(4000);
if (night) { await page.locator('[data-atmosphere-option="night"]').click(); await page.waitForTimeout(3000); }
await page.evaluate(async () => {
  const { neighborhood: n } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
  window.__probe = { n };
});

const census = await page.evaluate(() => {
  const rows = [];
  const seen = new Set();
  const owner = (object) => { for (let node = object; node; node = node.parent) if (node.name) return node.name; return '(unnamed)'; };
  const add = (item, kind, object) => {
    if (!item || seen.has(item)) return;
    seen.add(item);
    const ordinal = rows.length;
    rows.push({ ordinal, kind, owner: owner(object), label: item.type ?? kind, fired: false });
    item.addEventListener('dispose', () => { rows[ordinal].fired = true; });
  };
  window.__probe.n.scene.traverse((object) => {
    add(object.geometry, 'geometry', object);
    for (const material of [].concat(object.material ?? [])) {
      add(material, 'material', object);
      for (const value of Object.values(material)) if (value && value.isTexture) add(value, 'texture', object);
    }
  });
  window.__ledger = rows;
  const near = window.__probe.n.nearTraffic();
  return { rows: rows.length, byKind: rows.reduce((a, r) => { a[r.kind] = (a[r.kind] ?? 0) + 1; return a; }, {}),
    near: near && { cars: near.cars, walkers: near.walkers, boats: near.boats, signals: near.signals } };
});
console.log('场景里的可还资源：', JSON.stringify(census));

const after = await page.evaluate(() => {
  window.__probe.n.dispose();
  const rows = window.__ledger;
  const tally = {};
  for (const row of rows) {
    const cell = (tally[row.owner] ??= { total: 0, missed: 0 });
    cell.total += 1;
    if (!row.fired) cell.missed += 1;
  }
  return { fired: rows.filter((r) => r.fired).length, stillThere: rows.filter((r) => !r.fired).length, tally,
    detail: rows.filter((r) => !r.fired).slice(0, 40).map((row) => `${row.kind}:${row.owner}:${row.label}`) };
});
console.log('dispose 之后：', JSON.stringify(after, null, 1));
await browser.close();
