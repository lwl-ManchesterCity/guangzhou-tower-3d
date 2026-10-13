// V8 Phase 2 的成图：同一机位、同一氛围，把新引擎与现版各拍一张，存进 docs/screenshots/。
//   node scripts/shot-engine-facade.mjs
// 命名成 `engine-facade-<mode>-<engine>.png`，README 里两两并排贴。
import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const app = process.env.APP_URL || 'http://127.0.0.1:5174';
const camera = '#map=15.5/23.1095/113.31913/-25/62';
const out = (name) => fileURLToPath(new URL(`../docs/screenshots/${name}.png`, import.meta.url));
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });

for (const engine of ['three', 'maplibre']) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  for (const mode of ['day', 'sunset', 'night']) {
    await page.goto('about:blank');
    await page.goto(`${app}/?scene=canton${engine === 'three' ? '&engine=three' : ''}${mode === 'day' ? '' : `&atmosphere=${mode}`}${camera}`);
    if (engine === 'three') {
      await page.waitForFunction(() => document.querySelector('.engine-stats')?.textContent?.includes('fps'), { timeout: 120000 });
    } else {
      await page.waitForSelector('#places-toggle:not([disabled])', { timeout: 180000 });
    }
    if (mode !== 'day') await page.locator(`[data-atmosphere-option="${mode}"]`).click();
    await page.waitForTimeout(engine === 'three' ? 900 : 2600);
    await page.screenshot({ path: out(`engine-facade-${mode}-${engine}`) });
    console.log(`engine-facade-${mode}-${engine}`, (await page.locator(engine === 'three' ? '.engine-stats' : '#map').first().textContent().catch(() => '')).slice(0, 60));
  }
  await page.close();
}
await browser.close();
