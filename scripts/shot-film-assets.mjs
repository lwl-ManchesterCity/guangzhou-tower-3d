// 宣传片的 README 素材：六张分镜静帧、48 秒正片、一段可内嵌自播的 GIF。
// 静帧不另摆镜头——进片后等时间走到那一幕，按暂停把这一帧钉住再拍，拍到的就是观众看到的那一帧。
import { chromium } from '@playwright/test';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const app = process.env.APP_URL || 'http://127.0.0.1:5174';
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ffmpeg = '/opt/homebrew/bin/ffmpeg';
const raw = 'shots/film-raw';
const shots = [
  ['city', '江城初见'], ['twins', '双塔入云'], ['axis', '花城中轴'],
  ['bridge', '步过珠江'], ['tower', '小蛮腰亮起'], ['banks', '一江两岸'],
];
const SHOT_MS = 8000, SHOTS = shots.length;
const FILM_MS = SHOT_MS * SHOTS;

await mkdir('docs/film', { recursive: true });
const browser = await chromium.launch({ executablePath: chrome });

async function ready(page) {
  page.on('pageerror', (error) => console.log('page error:', error.message));
  await page.goto(`${app}/?scene=canton`);
  await page.waitForFunction(() => document.querySelector('#film-start')?.disabled === false, null, { timeout: 180000 });
  await page.evaluate(async () => {
    const src = document.querySelector('script[type="module"][src*="/src/main.js"]').src;
    window.filmApp = (await import(src)).neighborhood;
  });
  await page.waitForFunction(() => filmApp.map.loaded() && !filmApp.map.isMoving(), null, { timeout: 60000 });
  await page.waitForTimeout(2500);
}

// 六张分镜静帧。
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await ready(page);
  await page.locator('#film-start').click();
  await page.waitForFunction(() => document.body.dataset.film === 'open');
  for (const [index, [slug, title]] of shots.entries()) {
    await page.waitForFunction((want) => document.querySelector('#film-chapter')?.textContent?.includes(want), title, { timeout: 90000 });
    await page.waitForTimeout(1200);
    await page.locator('#film-play').click();
    await page.waitForFunction(() => filmApp.film.state.playing === false);
    await page.screenshot({ path: `docs/screenshots/canton-film-${String(index + 1).padStart(2, '0')}-${slug}.png` });
    console.log(`· canton-film-${String(index + 1).padStart(2, '0')}-${slug}.png`);
    if (index < SHOTS - 1) await page.locator('#film-play').click();
  }
  await page.locator('#film-exit').click();
  await page.close();
}

// 正片：整段录下来，按 48 秒从尾巴上截，前头的加载时间自然被切掉。
await rm(raw, { recursive: true, force: true });
{
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1,
    recordVideo: { dir: raw, size: { width: 1280, height: 720 } },
  });
  const page = await context.newPage();
  await ready(page);
  const video = page.video();
  await page.locator('#film-start').click();
  await page.waitForFunction(() => document.body.dataset.film === 'open');
  await page.waitForFunction(() => document.body.dataset.film === 'closed', null, { timeout: 120000 });
  await page.close();
  const recorded = await video.path();
  await context.close();

  const { stdout } = await run('/opt/homebrew/bin/ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', recorded]);
  const total = Number.parseFloat(stdout.trim());
  const head = Math.max(0, total - FILM_MS / 1000).toFixed(3);
  console.log(`· 录制 ${total.toFixed(2)}s，正片从 ${head}s 起`);
  await run(ffmpeg, ['-y', '-ss', head, '-i', recorded, '-t', '48', '-an',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '25', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    'docs/film/guangzhou-film.mp4'], { maxBuffer: 1 << 28 });
  console.log('· docs/film/guangzhou-film.mp4');

  // GIF：六幕各截 1.2 秒接起来，只有这个在 GitHub 的 README 里会自己动。
  const parts = [];
  for (let i = 0; i < SHOTS; i++) {
    const part = `/tmp/guangzhou-film-part-${i}.mp4`;
    await run(ffmpeg, ['-y', '-ss', String(i * SHOT_MS / 1000 + 0.6), '-i', 'docs/film/guangzhou-film.mp4', '-t', '1.2',
      '-an', '-vf', 'fps=8,scale=640:-2:flags=lanczos', '-c:v', 'libx264', '-crf', '18', part]);
    parts.push(part);
  }
  const list = '/tmp/guangzhou-film-list.txt';
  await writeFile(list, parts.map((part) => `file '${part}'`).join('\n'));
  const joined = '/tmp/guangzhou-film-joined.mp4';
  await run(ffmpeg, ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', joined]);
  await run(ffmpeg, ['-y', '-i', joined, '-vf',
    'split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle',
    '-loop', '0', 'docs/film/guangzhou-film.gif'], { maxBuffer: 1 << 28 });
  console.log('· docs/film/guangzhou-film.gif');
}

await browser.close();
