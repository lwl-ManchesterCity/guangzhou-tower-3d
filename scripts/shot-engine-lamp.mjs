// V8 Phase 2-3 的成图：夜景灯火进新引擎之后，同一机位把新引擎与现版各拍一张整幅 + 一块近场细部。
//   node scripts/shot-engine-lamp.mjs
// 命名成 `engine-lamp-<kind>-night-<engine>.png`。两幅不是逐字节对照物：现版那侧还有塔身壳体发光与江面波光，
// 那两格要等地标与水面资产搬进引擎（待办 #170）；车流与行人在 2026-10-07 已经接上，所以这一对现在量的是"窗与晕这两层进了画面之后读起来像不像一座夜里的城"。
import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const app = process.env.APP_URL || 'http://127.0.0.1:5174';
const camera = '#map=15.5/23.1095/113.31913/-25/62';
// 细部框：开屏机位上最近那一排 112 m 的楼（osmId 735437864~735437869）落在这一带。
const close = { x: 520, y: 300, width: 560, height: 360 };
const out = (name) => fileURLToPath(new URL(`../docs/screenshots/${name}.png`, import.meta.url));
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });

for (const engine of ['three', 'maplibre']) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  await page.goto('about:blank');
  await page.goto(`${app}/?scene=canton${engine === 'three' ? '&engine=three' : ''}&atmosphere=night${camera}`);
  if (engine === 'three') {
    await page.waitForFunction(() => document.querySelector('.engine-stats')?.textContent?.includes('fps'), { timeout: 120000 });
  } else {
    await page.waitForSelector('#places-toggle:not([disabled])', { timeout: 180000 });
  }
  await page.locator('[data-atmosphere-option="night"]').click();
  await page.waitForTimeout(engine === 'three' ? 1400 : 3000);
  await page.screenshot({ path: out(`engine-lamp-full-night-${engine}`) });
  await page.screenshot({ path: out(`engine-lamp-close-night-${engine}`), clip: close });
  console.log(`engine-lamp-night-${engine}`,
    (await page.locator(engine === 'three' ? '.engine-stats' : '#map').first().textContent().catch(() => '')).slice(0, 72));
  await page.close();
}
await browser.close();
