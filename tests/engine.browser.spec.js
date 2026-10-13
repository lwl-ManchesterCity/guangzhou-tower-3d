import { expect, test } from '@playwright/test';

// V8 Phase 0 的验收。这一项单独成文件：现版那 63 项量的是 legacy 引擎，新引擎在 Phase 4 之前不该改动它们，
// 也不该被它们误伤。开关两边各测一次，是因为"旧版随时可回退"这条硬约束本身就是可测的。
test.use({ launchOptions: { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }, viewport: { width: 1440, height: 960 } });
const appUrl = process.env.APP_URL || 'http://127.0.0.1:5174';
const START = '#map=15.5/23.1095/113.31913/-25/62';

const parse = (hash) => {
  const parts = (hash.match(/#map=([^&]+)/) ?? [, ''])[1].split('/').map(Number);
  return { zoom: parts[0], lat: parts[1], lng: parts[2], bearing: parts[3], pitch: parts[4] };
};
const metres = (a, b) => {
  const dx = (b.lng - a.lng) * 111320 * Math.cos((a.lat * Math.PI) / 180);
  const dy = (b.lat - a.lat) * 110540;
  return Math.hypot(dx, dy);
};
const turn = (from, to) => ((to - from + 540) % 360) - 180;

async function openEngine(page, engine, hash = START) {
  // A second `goto` that only changes the fragment does not reload the page, so measuring two gestures back to back
  // would quietly reuse the previous one's camera. Blank first.
  await page.goto('about:blank');
  await page.goto(`${appUrl}/?scene=canton${engine === 'three' ? '&engine=three' : ''}${hash}`);
  if (engine === 'three') {
    await page.waitForFunction(() => document.querySelector('.engine-stats')?.textContent?.includes('fps'), { timeout: 120000 });
    return;
  }
  await page.waitForSelector('#places-toggle:not([disabled])', { timeout: 180000 });
  await page.waitForTimeout(2500);
}

// The camera keeps easing after the button is released and the hash is rewritten on a half-second beat, so a gesture
// read too early hands the next one a moving baseline - the first version of the parity test tripped its own
// "a turn must not slide the map" claim on the leftover of the previous pan rather than on the turn itself.
async function settledHash(page, previous = null) {
  // Two reads agreeing is only "settled" once the page has had its chance to write: the engine rewrites the hash on a
  // half-second beat, so reading at 0 and 400 ms after a gesture can see the old value twice and call it stable.
  if (previous !== null) {
    await page.waitForFunction((from) => location.hash !== from, previous, { timeout: 3000 }).catch(() => {});
  }
  let last = await page.evaluate(() => location.hash);
  for (let tries = 0; tries < 30; tries++) {
    await page.waitForTimeout(400);
    const now = await page.evaluate(() => location.hash);
    if (now === last) return parse(now);
    last = now;
  }
  return parse(last);
}

async function drag(page, { x = 720, y = 520, dx = 0, dy = 0, alt = false, ctrl = false, right = false, steps = 10 }) {
  const started = await page.evaluate(() => location.hash);
  await page.mouse.move(x, y);
  for (const [key, held] of [['Alt', alt], ['Control', ctrl]]) if (held) await page.keyboard.down(key);
  await page.mouse.down(right ? { button: 'right' } : {});
  for (let step = 1; step <= steps; step++) await page.mouse.move(x + (dx * step) / steps, y + (dy * step) / steps);
  await page.mouse.up(right ? { button: 'right' } : {});
  for (const [key, held] of [['Alt', alt], ['Control', ctrl]]) if (held) await page.keyboard.up(key);
  return settledHash(page, started);
}

test('the three.js engine mounts behind the switch, draws the ground and all 3,990 blocks, and keeps the old path', async ({ page }) => {
  test.setTimeout(240000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await openEngine(page, 'three');

  expect(await page.locator('.engine-canvas').count(), 'the new engine did not take the canvas').toBe(1);
  expect(await page.locator('.maplibregl-map').count(), 'MapLibre is still alive under the new engine').toBe(0);

  const scene = await page.evaluate(() => ({
    panel: document.querySelector('.engine-stats').textContent,
    size: [document.querySelector('.engine-canvas').width, document.querySelector('.engine-canvas').height],
    disabled: [...document.querySelectorAll('button')].filter((node) => node.disabled).length,
    atmosphere: [...document.querySelectorAll('#atmosphere-controls button')].filter((node) => !node.disabled).length,
  }));
  expect(scene.size, 'the canvas did not take the viewport').toEqual([1440, 960]);
  // Phase 1 后半：全量。面板报的是快照里每一面都立起来了，不是十栋样品。
  expect(scene.panel, 'the FPS panel does not say what it is grading').toContain('3990 栋');
  // Phase 1 起，面板报的是地面每一档认领了多少面 - 数字来自那三份派生文件，画不上屏就报不出来。
  // `路` 从 504 涨到 2,972：2026-10-05 把 `canton-streets` 的抽取半径从 1 km 提到 2.2 km（花城大道以前根本不在
  // 快照里），晋升后每一档都是整条 way，不再是一公里那一段。
  for (const roster of ['水 41', '绿 379', '地块 572', '铺装 23', '路 2972']) {
    expect(scene.panel, `面板里没有 ${roster}：${scene.panel}`).toContain(roster);
  }
  // Phase 0 那侧只有三个氛围按钮答得出话；项 5 把车流、行人与交叉淡接进引擎之后，动效开关也有东西可答了，
  // 所以这一格从三变四。别的控件仍然灰着（业务功能按文档要到 Phase 4 才回迁）。
  expect(scene.atmosphere, 'the skeleton serves three atmosphere modes plus the motion switch, nothing else').toBe(4);

  // Something has to be on screen, and it has to be more than one flat colour: the ground, the road ribbons and the
  // river ribbon are three distinct tones before any building is counted.
  // Read off a screenshot, not off the canvas: a WebGL canvas without a preserved drawing buffer hands back a blank
  // bitmap, which would make any pixel claim about the live frame quietly true.
  const tonesOf = async (clip) => page.evaluate(async ({ source }) => {
    const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${source}`)).blob());
    const buffer = new OffscreenCanvas(image.width, image.height);
    const context = buffer.getContext('2d');
    context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, image.width, image.height).data;
    const seen = new Map();
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) {
      const key = `${data[i] >> 4},${data[i + 1] >> 4},${data[i + 2] >> 4}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
      sum += data[i] + data[i + 1] + data[i + 2];
    }
    return { distinct: seen.size, dominant: Math.max(...seen.values()) / (data.length / 4), mean: sum / (data.length / 4) / 3 };
  }, { source: (await page.screenshot({ clip })).toString('base64') });

  const spread = await tonesOf({ x: 200, y: 200, width: 1000, height: 600 });
  expect(spread.distinct, `the frame carries only ${spread.distinct} tones`).toBeGreaterThan(12);
  expect(spread.dominant, 'one tone covers the frame, so the picture is a background, not a city').toBeLessThan(0.8);

  // Phase 1 的地面判据：把三个已知地点投到屏幕上，再看那一格的像素偏不偏那个色相。水 #94c1c6 是蓝在红前，
  // 公园 #9ab88a 是红在蓝前，塔脚那片基底 #e9eeeb 两边都不偏 - 读的是差值的符号与量级，不是绝对亮度，
  // 所以光照怎么调都判得动。
  const spots = await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const { ATMOSPHERES } = await import('/src/atmosphere.js');
    return {
      channel: neighborhood.screen({ lng: 113.319130, lat: 23.111893, altitude: 0.2 }),
      square: neighborhood.screen({ lng: 113.31921, lat: 23.116, altitude: 0.13 }),
      foot: neighborhood.screen({ lng: 113.31913, lat: 23.109, altitude: 0 }),
      palette: (() => { const day = ATMOSPHERES.day; return { water: day.water, background: day.background }; })(),
      calls: neighborhood.counts(),
    };
  });
  const rgbAt = async (spot, label) => {
    expect(spot.onScreen, `${label} 那一点不在画面里`).toBe(true);
    const box = { x: Math.max(0, Math.round(spot.x) - 4), y: Math.max(0, Math.round(spot.y) - 4), width: 9, height: 9 };
    return page.evaluate(async ({ source }) => {
      const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${source}`)).blob());
      const buffer = new OffscreenCanvas(image.width, image.height);
      const context = buffer.getContext('2d');
      context.drawImage(image, 0, 0);
      const data = context.getImageData(0, 0, image.width, image.height).data;
      const mean = [0, 0, 0];
      for (let i = 0; i < data.length; i += 4) for (let channel = 0; channel < 3; channel++) mean[channel] += data[i + channel];
      const pixels = data.length / 4;
      return mean.map((value) => Math.round(value / pixels));
    }, { source: (await page.screenshot({ clip: box })).toString('base64') });
  };
  const channel = await rgbAt(spots.channel, '江心');
  const square = await rgbAt(spots.square, '花城广场');
  const foot = await rgbAt(spots.foot, '塔脚');
  // 地面是不受光的（与 MapLibre 的 fill 同构），所以近处那一格应当就是调色板本身：江心离镜头 260 m、雾还没起，
  // 水色与 `ATMOSPHERES.day.water` 的差必须逐通道在 8 级以内；塔脚那格同理对 `background`。
  const against = (rgb, hex) => rgb.map((value, index) => Math.abs(value - parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16)));
  expect(Math.max(...against(channel, spots.palette.water)), `江心那一格 ${channel.join(',')} 与水色 ${spots.palette.water} 对不上`).toBeLessThanOrEqual(8);
  expect(Math.max(...against(foot, spots.palette.background)), `塔脚那一格 ${foot.join(',')} 与基底色 ${spots.palette.background} 对不上`).toBeLessThanOrEqual(8);
  expect(channel[2] - channel[0], `江心那一格蓝减红只有 ${channel[2] - channel[0]}（${channel.join(',')}），水面没画上`).toBeGreaterThan(20);
  expect(square[0] - square[2], `花城广场那一格红减蓝只有 ${square[0] - square[2]}（${square.join(',')}），绿地没画上`).toBeGreaterThan(10);
  expect(Math.abs(foot[2] - foot[0]), `塔脚那一格偏蓝 ${foot[2] - foot[0]}（${foot.join(',')}），基底被涂成了水`).toBeLessThan(12);
  expect(spots.calls.ground, `地面只有 ${spots.calls.ground} 块`).toBeGreaterThanOrEqual(7);
  // 文档 Phase 1 的门槛：合并之后 draw call 必须在一百以内。实测 12 个（4 个类别桶 + 8 块地面），
  // 所以这里同时钉"桶数没有偷偷回到一栋一个"：全量 3,990 面若是一栋一个 Mesh，这一发就是四千个 draw call。
  expect(spots.calls.drawCalls, `合并之后还有 ${spots.calls.drawCalls} 个 draw call`).toBeLessThan(100);
  expect(spots.calls.buildings, `面板说画了 ${spots.calls.buildings} 栋`).toBe(3990);
  expect(spots.calls.triangles, `全量合并之后只有 ${spots.calls.triangles} 个三角，桶大概是空的`).toBeGreaterThan(60000);

  // The frame the brief opens on: the hash the old engine writes must come back out of the new camera unchanged.
  const opened = parse(await page.evaluate(() => location.hash));
  expect(Math.abs(opened.zoom - 15.5), `the opening zoom drifted to ${opened.zoom}`).toBeLessThan(0.05);
  expect(Math.abs(opened.pitch - 62), `the opening pitch drifted to ${opened.pitch}`).toBeLessThan(0.6);
  expect(Math.abs(turn(-25, opened.bearing)), `the opening bearing drifted to ${opened.bearing}`).toBeLessThan(0.6);

  // A link written by the old engine, pasted into the new one. This has to be a real load: `goto` with only the
  // fragment changed is a same-document navigation, so the page keeps its 15.5 camera and the engine's half-second hash
  // beat then overwrites the pasted value - reading before that beat made this pass by accident.
  await openEngine(page, 'three', '#map=15.2/23.1095/113.31913/-25/58');
  const restored = parse(await page.evaluate(() => location.hash));
  expect(Math.abs(restored.zoom - 15.2), `the pasted link landed at zoom ${restored.zoom}`).toBeLessThan(0.05);
  expect(Math.abs(restored.pitch - 58), `the pasted link landed at pitch ${restored.pitch}`).toBeLessThan(0.6);

  // Three modes, and each one has to change the frame rather than only the buttons.
  const tones = [];
  for (const mode of ['night', 'sunset', 'day']) {
    await page.locator(`[data-atmosphere-option="${mode}"]`).click();
    await page.waitForTimeout(700);
    tones.push(Math.round((await tonesOf({ x: 300, y: 300, width: 800, height: 400 })).mean));
  }
  expect(new Set(tones).size, `the three modes drew the same frame: ${tones.join('/')}`).toBe(3);
  expect(tones[0], `night (${tones[0]}) is not darker than day (${tones[2]})`).toBeLessThan(tones[2]);

  // The panel is the FPS acceptance, and 50 is the line the brief draws. The first window after boot is skipped:
  // it carries the shader compile, measured at 416 ms for one frame.
  await page.waitForTimeout(1500);
  const fps = Number((await page.locator('.engine-stats').textContent()).match(/three ([\d.]+) fps/)[1]);
  expect(fps, `the skeleton runs at ${fps} fps`).toBeGreaterThanOrEqual(50);

  expect(errors, `the engine threw: ${errors.slice(0, 3).join(' | ')}`).toEqual([]);

  // 看全范围那颗按钮写的是 12.6 级：雾带不跟着视线走的话，那一档会退成一片空色，所以这一发单独量。
  await openEngine(page, 'three', '#map=12.6/23.1095/113.31913/0/58');
  // 一条横切江面的剖面，不是江心那一个点：全量城市立起来之后，12.6 级上任何一个单点都可能正好被一栋屋顶挡住，
  // 那种时候"这一格不是水色"说的是屋顶，不是雾。剖面里要求至少三处仍读得出蓝于红，才是"雾没有把城市吞掉"。
  const far = await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const section = [];
    for (let index = 0; index < 9; index++) {
      const spot = neighborhood.screen({ lng: 113.319130, lat: 23.1074 + index * 0.001125, altitude: 0.2 });
      if (spot.onScreen) section.push(spot);
    }
    return { section, calls: neighborhood.counts() };
  });
  expect(far.section.length, '剖面的九个点不能掉出画面').toBeGreaterThanOrEqual(7);
  const farSource = (await page.screenshot()).toString('base64');
  const blues = await page.evaluate(async ({ source, section }) => {
    const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${source}`)).blob());
    const buffer = new OffscreenCanvas(image.width, image.height);
    const context = buffer.getContext('2d');
    context.drawImage(image, 0, 0);
    return section.map((spot) => {
      const data = context.getImageData(Math.max(0, Math.round(spot.x) - 4), Math.max(0, Math.round(spot.y) - 4), 9, 9).data;
      const mean = [0, 0, 0];
      for (let i = 0; i < data.length; i += 4) for (let channel = 0; channel < 3; channel++) mean[channel] += data[i + channel];
      const pixels = data.length / 4;
      return Math.round(mean[2] - mean[0]);
    });
  }, { source: farSource, section: far.section });
  const readable = blues.filter((delta) => delta > 10).length;
  expect(readable, `全景档的江面剖面只有 ${readable}/9 处读得出水色（蓝减红：${blues.join('·')}），雾把城市吞了`)
    .toBeGreaterThanOrEqual(3);
  expect(far.calls.drawCalls, `全景档 ${far.calls.drawCalls} 个 draw call`).toBeLessThan(100);

  // And the switch is a switch: without it the shipped page is what loads.
  const legacy = await page.context().newPage();
  await legacy.setViewportSize({ width: 1440, height: 960 });
  await openEngine(legacy, 'maplibre');
  expect(await legacy.locator('.maplibregl-map').count(), 'the old path stopped working').toBe(1);
  expect(await legacy.locator('.engine-canvas').count(), 'the new engine mounted without the switch').toBe(0);

  // 名牌也统一到像素。新引擎没有 MapLibre 的 marker 层，是自己按同一套投影把牌摆上去的，所以"两边一样"这件事
  // 只能拿同一镜头下两边的实际盒子比。比的是盒子的**下边中点**：两边的挂法都是 `anchor: bottom` 加 offset [0, -6]，
  // 牌压在它指的那一点上方，于是盒子自身的高度差（现版那块带剪影、拥挤时还会把名字收掉只剩 30 px 宽）不体现在落点上，
  // 而盒子中心会 —— 实测两块的牌高是 23.4 与 24 px，拿中心当落点就先给自己埋下 11.7 px 的假差。
  // 现版那侧还要先把 `setPadding` 抹平：map.js 按面板位置给了 {top:200,left:280,right:0,bottom:60}，那套排版把投影
  // 中心从画布中心挪走（实测横向 140 px），而"让位给面板"这件事新引擎要到 Phase 4 才有。抹掉它不是放宽门槛，是把两边
  // 还没对齐的那一维从对照里拿走；剩下的那一维（同一个点落在哪个像素）两边现在差 0.4 px 以内。
  const anchors = () => [...document.querySelectorAll('.landmark[data-osm-id]')].map((node) => {
    const box = node.getBoundingClientRect();
    return { osmId: Number(node.dataset.osmId), name: node.textContent.trim(),
      x: Math.round((box.x + box.width / 2) * 10) / 10, y: Math.round((box.y + box.height) * 10) / 10 };
  });
  await openEngine(page, 'three');
  const mine = await page.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    return neighborhood.landmarkLabels();
  });
  await legacy.evaluate(async () => {
    const { neighborhood } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    neighborhood.map.setPadding({ top: 0, left: 0, right: 0, bottom: 0 });
  });
  // 抹掉 padding 之后 marker 是在渲染帧里重新摆的，读早了拿到的是上一秒的盒子；连续两读一致才算落定。
  let theirs = await legacy.evaluate(anchors);
  for (let tries = 0; tries < 20; tries++) {
    await legacy.waitForTimeout(250);
    const now = await legacy.evaluate(anchors);
    if (now.length === theirs.length && now.every((row, index) => Math.abs(row.x - theirs[index].x) < 0.2 && Math.abs(row.y - theirs[index].y) < 0.2)) { theirs = now; break; }
    theirs = now;
  }
  expect(mine.length, '地标名牌一块都不能少').toBe(7);
  expect(theirs.length, '现版那侧的名牌数量变了，这条对照就没有对象了').toBe(7);
  for (const plate of mine) {
    const twin = theirs.find((row) => row.osmId === plate.osmId);
    expect(twin, `${plate.name} 在现版那侧找不到同一块 osmId 的名牌`).toBeTruthy();
    // 3 px 而不是 10：两边实测差 0.4 px 以内，而"挂法错一档"（中心当成下边、offset 漏掉）是 6~12 px 的量级，
    // 卡在 10 就正好放走那一档。
    expect(Math.abs(plate.x - twin.x), `${plate.name} 横向落点 ${plate.x} vs 现版 ${twin.x}`).toBeLessThanOrEqual(3);
    expect(Math.abs(plate.y - twin.y), `${plate.name} 纵向落点 ${plate.y} vs 现版 ${twin.y}`).toBeLessThanOrEqual(3);
  }
  await legacy.close();
});

// V8 Phase 2：立面窗纹进新引擎。量三件事——那四层真的进了画面、窗格落在墙上而不是屋顶、
// 以及每块墙上的层带周期等于本类别节奏表算出来的那个数（周期自己带在判据里，与 `facade.js` 同一张表）。
test('the new engine puts a storey grid on the walls, with the shipped rhythm table', async ({ page }) => {
  test.setTimeout(240000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await openEngine(page, 'three');

  const scene = await page.evaluate(async () => {
    const { neighborhood: n } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    window.__probe = { n };
    const { FACADE_CELL_METRES } = await import('/src/engine/facades.js');
    const { FACADE_CATEGORY_SHAPES, FACADE_SHAPES } = await import('/src/facade.js');
    const features = (await (await fetch('/data/canton-buildings.geojson')).json()).features;
    const centre = { x: innerWidth / 2, y: innerHeight / 2 };
    const rows = features.filter((feature) => Number(feature.properties.height ?? 0) > 60).map((feature) => {
      const ring = feature.geometry.type === 'Polygon' ? feature.geometry.coordinates[0] : feature.geometry.coordinates[0][0];
      const lng = ring.reduce((sum, p) => sum + p[0], 0) / ring.length;
      const lat = ring.reduce((sum, p) => sum + p[1], 0) / ring.length;
      const height = Number(feature.properties.height);
      const point = n.screen({ lng, lat, altitude: height * 0.55 });
      // 每像素多少米不猜：拿这台相机自己投两个相距 1e-4 度的点，差多少像素就是多少米。
      const east = n.screen({ lng: lng + 1e-4, lat, altitude: height * 0.55 });
      const metresPerPixel = 11.132 * Math.cos((lat * Math.PI) / 180) / (east.x - point.x);
      const shape = FACADE_SHAPES[FACADE_CATEGORY_SHAPES[feature.properties.category] ?? 'plain'];
      return { osmId: feature.properties.osmId, category: feature.properties.category, height: Math.round(height),
        x: Math.round(point.x), y: Math.round(point.y),
        away: Math.round(Math.hypot(point.x - centre.x, point.y - centre.y)),
        // 一格平铺 29.3 m，里面有 `rows` 条层带；自相关量到的是**层带**的周期，不是整格的。
        band: Math.round(FACADE_CELL_METRES / metresPerPixel / shape.rows * 10) / 10,
        columns: shape.columns };
    }).filter((row) => row.x > 260 && row.x < 1150 && row.y > 200 && row.y < 780);
    rows.sort((a, b) => a.away - b.away);
    return { targets: rows.slice(0, 8), counts: n.counts(), panel: document.querySelector('.engine-stats').textContent };
  });
  expect(scene.counts.facades, `窗格层数不是 4：${JSON.stringify(scene.counts)}`).toBe(4);
  // 12 是窗纹进场之前那一发（4 桶墙 + 8 块地面）。多出来的 4 发就是覆盖层，它们必须真的在提交。
  expect(scene.counts.drawCalls, `加了窗格之后只有 ${scene.counts.drawCalls} 个 draw call`).toBeGreaterThan(12);
  expect(scene.counts.drawCalls, `加了窗格之后 ${scene.counts.drawCalls} 个 draw call`).toBeLessThan(100);
  expect(scene.panel, `面板里没有窗纹那一格：${scene.panel}`).toContain('窗纹 4 层');
  expect(scene.targets.length, '开屏机位上一块 60 m 以上的墙都找不到，这一发就没有取样对象了').toBeGreaterThanOrEqual(4);

  // 关一层再拍：差出来的那张图就是"窗格画了什么"，墙、地面、天空全部抵消。
  const shots = [];
  for (const visible of [true, false, true]) {
    const touched = await page.evaluate((wanted) => {
      let count = 0;
      window.__probe.n.scene.traverse((object) => {
        if (object.name?.startsWith('building-facade')) { object.visible = wanted; count++; }
      });
      return count;
    }, visible);
    expect(touched, '开关窗格层时遍历到的层数不对，取样没有对照物').toBe(4);
    await page.waitForTimeout(400);
    shots.push((await page.screenshot()).toString('base64'));
  }
  const grid = await page.evaluate(async ({ shots, targets }) => {
    const load = async (source) => {
      const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${source}`)).blob());
      const buffer = new OffscreenCanvas(image.width, image.height);
      const context = buffer.getContext('2d');
      context.drawImage(image, 0, 0);
      return context.getImageData(0, 0, image.width, image.height).data;
    };
    const on = await load(shots[0]), off = await load(shots[1]);
    const width = 1440;
    const delta = (x, y) => {
      const at = (y * width + x) * 4;
      return Math.abs(on[at] - off[at]) + Math.abs(on[at + 1] - off[at + 1]) + Math.abs(on[at + 2] - off[at + 2]);
    };
    let moved = 0;
    for (let y = 0; y < 960; y += 2) for (let x = 0; x < width; x += 2) if (delta(x, y) > 6) moved++;
    const walls = targets.map((target) => {
      const profile = [];
      for (let column = 0; column < 96; column++) {
        let sum = 0;
        for (let row = 0; row < 32; row++) sum += delta(target.x - 48 + column, target.y - 16 + row);
        profile.push(sum / 32);
      }
      const mean = profile.reduce((p, q) => p + q, 0) / profile.length;
      const spread = Math.sqrt(profile.reduce((p, q) => p + (q - mean) ** 2, 0) / profile.length);
      let peak = { lag: 0, score: -2 };
      for (let lag = 4; lag <= 32; lag++) {
        let sum = 0;
        for (let i = 0; i + lag < profile.length; i++) sum += (profile[i] - mean) * (profile[i + lag] - mean);
        const score = spread ? sum / (profile.length - lag) / (spread ** 2) : 0;
        if (score > peak.score) peak = { lag, score: Math.round(score * 100) / 100 };
      }
      return { osmId: target.osmId, category: target.category, band: target.band, mean: Math.round(mean),
        spread: Math.round(spread * 10) / 10, lag: peak.lag, score: peak.score };
    });
    return { movedShare: Math.round(moved / ((width / 2) * 480) * 1000) / 10, walls };
  }, { shots, targets: scene.targets });

  // 实测 18.1 %。上下限都留得宽：下限证明窗格真的画到屏上（关掉是 0），上限证明它没把画面糊成一整片。
  expect(grid.movedShare, `窗格开与关只差 ${grid.movedShare} % 的画面，这一层基本没上屏`).toBeGreaterThan(5);
  expect(grid.movedShare, `窗格开与关差 ${grid.movedShare} % 的画面，多到不像一层窗纹`).toBeLessThan(45);
  const onBeat = grid.walls.filter((wall) => wall.mean > 10 && Math.abs(wall.lag - wall.band) <= wall.band * 0.35);
  expect(onBeat.length, `八块墙里只有 ${onBeat.length} 块的层带周期对得上本类别的节奏表：${JSON.stringify(grid.walls)}`)
    .toBeGreaterThanOrEqual(3);
  expect(errors, `窗纹进场之后引擎抛了：${errors.slice(0, 3).join(' | ')}`).toEqual([]);
});

// V8 Phase 2-3：夜景灯火（亮窗 + 光晕）进新引擎。现版那侧的分档/色温/距离环/整栋不亮是四张 `addImage` 贴图 +
// 三层 `fill-extrusion-pattern`；新引擎没有"按要素换贴图"这条路，所以同一套规则改走图集：一栋楼在片元里按自己的
// 格号取那一格，格内再由 uv 的小数部分平铺。这一发量三件事——只有夜景在、每栋楼拿到的是自己的格、真的上屏。
test('the new engine lights the night windows with the shipped band ladder', async ({ page }) => {
  test.setTimeout(300000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await openEngine(page, 'three');
  await page.evaluate(async () => {
    const { neighborhood: n } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    window.__probe = { n };
  });

  // 门控：白昼与日落这两层一个都不画（现版那侧同样是三层 visibility 门控），夜景八层全在。
  const gating = [];
  for (const mode of ['day', 'sunset', 'night']) {
    await page.locator(`[data-atmosphere-option="${mode}"]`).click();
    await page.waitForTimeout(1200);
    gating.push(await page.evaluate(async () => {
      const seen = { lampHidden: 0, lampShown: 0, glowHidden: 0, glowShown: 0, lamps: 0, glows: 0 };
      window.__probe.n.scene.traverse((object) => {
        if (/^building-lamps-/.test(object.name ?? '')) {
          seen.lamps++;
          seen[object.visible ? 'lampShown' : 'lampHidden']++;
        }
        if (/^building-glow-/.test(object.name ?? '')) {
          seen.glows++;
          seen[object.visible ? 'glowShown' : 'glowHidden']++;
        }
      });
      // 灯火的账要单独结：把车流那一组临时藏起来读一次发数，差值就是车流自己占的那几发。
      const twoFrames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const withTraffic = window.__probe.n.counts().drawCalls;
      // 路口那三层（杆 / 灯珠 / 停止线）是挂在车流那一组里面的，所以它自己的账在这里单独结一次：
      // 先只藏它，差值就是它占的发数；后面那笔"车流占几发"因此还是车自己的事。
      const signalLayers = [];
      window.__probe.n.scene.traverse((object) => {
        if (object.name === 'traffic-signals') { object.visible = false; signalLayers.push(object); }
      });
      await twoFrames();
      const noSignals = window.__probe.n.counts().drawCalls;
      for (const object of signalLayers) object.visible = true;
      await twoFrames();
      const hidden = [];
      window.__probe.n.scene.traverse((object) => {
        if (object.name === 'traffic-life') { object.visible = false; hidden.push(object); }
      });
      await twoFrames();
      const noTraffic = window.__probe.n.counts().drawCalls;
      // 江上那组也一样要藏：它跟着氛围只多出一发窗带（船身白天也在画），混进"八层多出八发"这句话里
      // 就成了九发（2026-10-09 补船之后第一次整套就是这么红的）。它自己的账在下面单独结。
      const boatHidden = [];
      window.__probe.n.scene.traverse((object) => {
        if (object.name === 'water-life') { object.visible = false; boatHidden.push(object); }
      });
      await twoFrames();
      const trafficFree = window.__probe.n.counts().drawCalls;
      // "八层各占一发"改成在**同一档氛围里**比：把八层灯火的网格藏掉再读一次。
      // 原来拿白昼做对照，可夜景这一档多走了泛光那条链（每道 pass 都算一发，见 `src/engine/bloom.js`），
      // 跨档比就把后处理的发数混进了"多出八发"这句话——门槛一个字没动，只是把它挪到能唯一归因的那一格。
      const lampLayers = [];
      window.__probe.n.scene.traverse((object) => {
        if (/^building-(lamps|glow)-/.test(object.name ?? '')) {
          lampLayers.push([object, object.visible]);
          object.visible = false;
        }
      });
      await twoFrames();
      const lampsOff = window.__probe.n.counts().drawCalls;
      // 还原要按"它原来是什么"还，不能一律写成 true：白昼那八层本来就是被门控藏着的，
      // 写 true 等于替它们开门，后面每一格读数都多出八发（第一版就是这么报出 [-6, -6, 5] 的）。
      for (const [object, was] of lampLayers) object.visible = was;
      await twoFrames();
      for (const object of boatHidden) object.visible = true;
      await twoFrames();
      const boatsBack = window.__probe.n.counts().drawCalls;
      for (const object of hidden) object.visible = true;
      await twoFrames();
      return { ...seen, signals: withTraffic - noSignals, traffic: noSignals - boatsBack, boat: boatsBack - trafficFree, trafficFree,
        lampsOff, bloom: window.__probe.n.counts().bloom ?? null,
        counts: window.__probe.n.counts(), panel: document.querySelector('.engine-stats').textContent };
    }));
  }
  const [day, sunset, night] = gating;
  expect([day.lamps, day.glows, night.lamps, night.glows], `灯火层数不对：${JSON.stringify(gating.map((g) => g.counts))}`)
    .toEqual([4, 4, 4, 4]);
  for (const [label, frame] of [['白昼', day], ['日落', sunset]]) {
    expect([frame.lampShown, frame.glowShown], `${label}有点亮的灯火层：${JSON.stringify(frame)}`).toEqual([0, 0]);
  }
  expect([night.lampHidden, night.glowHidden], `夜景有没在画的灯火层：${JSON.stringify(night)}`).toEqual([0, 0]);
  // 八层各一发：在同一档氛围里把八层藏掉，正好少八发；白昼那八层本来就不画，所以那一档的差值必须是 0。
  // 这一格同时钉住"门控只改可见性，几何与贴图都不动"与"白昼真的没在画"（写法改于泛光这一轮，门槛 8 未动）。
  expect([day.lampsOff - day.trafficFree, night.trafficFree - night.lampsOff],
    `灯火八层占的发数不对：白昼 ${day.lampsOff - day.trafficFree} 发、夜景 ${night.trafficFree - night.lampsOff} 发`
    + `（车流与江上都已藏起：${JSON.stringify([day.trafficFree, day.lampsOff, night.trafficFree, night.lampsOff])}）`).toEqual([0, 8]);
  // 泛光那条链只在夜景这一档走：白昼那份画面一个像素都不过合成器，所以 `built` 必须是 false。
  expect([day.bloom?.built ?? false, Boolean(night.bloom?.built)],
    `泛光那条链的开关不在夜景这一档：白昼 ${JSON.stringify(day.bloom)}、夜景 ${JSON.stringify(night.bloom)}`).toEqual([false, true]);
  expect(night.bloom.strength, `夜景的泛光强度是 ${night.bloom.strength}，不在满档`).toBeGreaterThan(0);
  // 车流那一组的账单独结一次，这是项 7 的护栏：白昼与日落只有车体与它们脚下那片影（人那一档以下不在场），
  // 夜景才把灯珠与光点放上来。2026-10-10 项 1 之前这一格是 [1, 1, 4]，多出来的那一发是贴片；
  // 它的缺陷值是 [1, 1, 4]（贴片没进组）与 [2, 2, 6]（影子被画了两遍）。
  expect([day.traffic, sunset.traffic, night.traffic],
    `车流占的发数不对：${JSON.stringify([day.traffic, sunset.traffic, night.traffic])}`).toEqual([2, 2, 5]);
  // 路口那三层是模型不是灯：三档氛围都在画，各一发（停止线是单面透明材质，所以它不占两发）。
  // 2026-10-13 项 6 之前这一格根本不存在；它的缺陷值是 [0, 0, 0]（灯没进组）与 [4, 4, 4]（灯珠材质被改成双面透明）。
  expect([day.signals, sunset.signals, night.signals],
    `灯杆、灯珠、停止线占的发数不对：${JSON.stringify([day.signals, sunset.signals, night.signals])}`).toEqual([3, 3, 3]);
  // 江上那组的账：船身是一个实例网格、一个 draw call，三档都在画（它是模型不是灯）；夜景才把加色窗带放上来。
  expect([day.boat, sunset.boat, night.boat],
    `船占的发数不对：${JSON.stringify([day.boat, sunset.boat, night.boat])}`).toEqual([1, 1, 2]);
  expect(night.panel, `面板里没有灯火那一格：${night.panel}`).toContain('灯火 8 层');

  // 逐楼格号：合并几何里那份 `aLampCell` 必须与"这批楼各自该穿哪一格"逐格对上，且不被同一格糊平。
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
      if (!expected.has(category)) expected.set(category, new Set());
      expected.get(category).add(`${cell.col},${cell.row}`);
    }
    const buckets = [];
    window.__probe.n.scene.traverse((object) => {
      if (!/^building-lamps-/.test(object.name ?? '')) return;
      const attribute = object.geometry.getAttribute('aLampCell');
      if (!attribute) { buckets.push({ name: object.name, missing: true }); return; }
      const pairs = new Map();
      let dark = 0;
      for (let i = 0; i < attribute.count; i++) {
        const key = `${attribute.getX(i)},${attribute.getY(i)}`;
        pairs.set(key, (pairs.get(key) ?? 0) + 1);
        if (attribute.getY(i) === LAMP_OFF_ROW) dark++;
      }
      const want = expected.get(object.userData.category) ?? new Set();
      buckets.push({ category: object.userData.category, vertices: attribute.count,
        // 少一格 = 有的楼被分错了格子；多一格 = 有的楼拿到了数据里没有的格子（合并串位就是这样露出来的）。
        missing: [...want].filter((key) => !pairs.has(key)),
        unexpected: [...pairs.keys()].filter((key) => !want.has(key)),
        distinct: pairs.size, expectedDistinct: want.size,
        rows: [...new Set([...pairs.keys()].map((key) => Number(key.split(',')[1])))].length,
        cols: [...new Set([...pairs.keys()].map((key) => Number(key.split(',')[0])))].length,
        darkShare: Math.round(dark / attribute.count * 1000) / 10,
        maxPairShare: Math.round(Math.max(...pairs.values()) / attribute.count * 100),
        grid: [LAMP_GRID.columns, LAMP_GRID.rows] });
    });
    return buckets;
  });
  expect(cells.length, '亮窗层里读不到几何，这一发就没有取样对象了').toBe(4);
  for (const bucket of cells) {
    expect(bucket.missing ?? ['几何没有 aLampCell'], `${bucket.category} 的楼少了格号：`).toEqual([]);
    expect(bucket.unexpected ?? [], `${bucket.category} 的楼拿到了数据之外的格号：`).toEqual([]);
    expect(bucket.distinct, `${bucket.category} 只有 ${bucket.distinct} 种格号，与数据里的 ${bucket.expectedDistinct} 种不符`)
      .toBe(bucket.expectedDistinct);
    // 三档高度 × 两行密度 + 一行全暗 = 七行；public 那一桶只有矮楼，实测到第 3 档为止，所以门槛是 4 不是 7。
    expect(bucket.rows, `${bucket.category} 的高度档只有 ${bucket.rows} 行`).toBeGreaterThanOrEqual(4);
    expect(bucket.cols, `${bucket.category} 的色温×距离环只有 ${bucket.cols} 列`).toBe(9);
    // 整栋不亮那 1/11（9.1 %）：按顶点数摊下来会偏一些，留 4–15 % 的窗口。实测 7.4–9.0。
    expect(bucket.darkShare, `${bucket.category} 的全暗顶点占 ${bucket.darkShare} %，不像 1/11`).toBeGreaterThan(4);
    expect(bucket.darkShare, `${bucket.category} 的全暗顶点占 ${bucket.darkShare} %，暗得过头了`).toBeLessThan(15);
    // 最挤的那一格（同一高度档 + 同色温 + 同距离环）占多少顶点：3,990 栋摊到 63 格，实测最大 6~10 %。
    // 25 % 这一档挡住的是退化情形——"格号没逐楼算、全城共用一格"，那正是现版 V7 抱怨过的"白色大棋盘"。
    expect(bucket.maxPairShare, `${bucket.category} 有 ${bucket.maxPairShare} % 的顶点共用同一格，快糊成一块板了`)
      .toBeLessThan(25);
  }

  // 上屏证据：开与关各拍一张，差的这两层就是"灯火画了什么"，墙、窗格、地面、天空全部抵消。
  // 这一对先关掉泛光再拍：那层晕会把灯火的能量摊到邻域去，占比当场从 7.3 % 涨到 21.5 %，
  // 量的就不再是"这两层画了多少"而是后处理链的扩散——后者由项 7 那一判据单独管（门槛 15 % 一字未动）。
  await page.evaluate(() => window.__probe.n.setBloom(0));
  await page.waitForTimeout(400);
  const shots = [];
  for (const wanted of [true, false, true]) {
    const touched = await page.evaluate((flag) => {
      let count = 0;
      window.__probe.n.scene.traverse((object) => {
        if (/^building-(lamps|glow)-/.test(object.name ?? '')) { object.visible = flag; count++; }
      });
      return count;
    }, wanted);
    expect(touched, '开关灯火层时遍历到的层数不对，取样没有对照物').toBe(8);
    await page.waitForTimeout(400);
    shots.push((await page.screenshot()).toString('base64'));
  }
  // 拍完就把泛光放回满档：这一项后面的每一格（含面板与截图）都该是出厂那一档的画面。
  await page.evaluate(() => window.__probe.n.setBloom(1));
  await page.waitForTimeout(400);
  const fire = await page.evaluate(async ({ shots }) => {
    const load = async (source) => {
      const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${source}`)).blob());
      const buffer = new OffscreenCanvas(image.width, image.height);
      const context = buffer.getContext('2d');
      context.drawImage(image, 0, 0);
      return context.getImageData(0, 0, image.width, image.height).data;
    };
    const on = await load(shots[0]), off = await load(shots[1]);
    const width = 1440;
    const luma = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const delta = (x, y) => {
      const at = (y * width + x) * 4;
      return Math.abs(on[at] - off[at]) + Math.abs(on[at + 1] - off[at + 1]) + Math.abs(on[at + 2] - off[at + 2]);
    };
    let moved = 0, peak = 0;
    for (let y = 0; y < 960; y += 2) for (let x = 0; x < width; x += 2) {
      const d = delta(x, y);
      if (d > 6) { moved++; peak = Math.max(peak, d); }
    }
    // 取样面上是开屏机位里最近的 8 面高墙：每面量"关掉两层之后平均暗了多少"与"亮着的像素有几个"。
    const { n } = window.__probe;
    const features = (await (await fetch('/data/canton-buildings.geojson')).json()).features;
    const centre = { x: innerWidth / 2, y: innerHeight / 2 };
    const targets = features.filter((feature) => Number(feature.properties?.height ?? 0) > 60).map((feature) => {
      const ring = feature.geometry.type === 'Polygon' ? feature.geometry.coordinates[0] : feature.geometry.coordinates[0][0];
      const lng = ring.reduce((sum, p) => sum + p[0], 0) / ring.length;
      const lat = ring.reduce((sum, p) => sum + p[1], 0) / ring.length;
      const height = Number(feature.properties.height);
      const point = n.screen({ lng, lat, altitude: height * 0.55 });
      return { osmId: feature.properties.osmId, height: Math.round(height), x: Math.round(point.x), y: Math.round(point.y),
        away: Math.round(Math.hypot(point.x - centre.x, point.y - centre.y)) };
    }).filter((row) => row.x > 260 && row.x < 1150 && row.y > 200 && row.y < 780).sort((a, b) => a.away - b.away).slice(0, 8);
    const walls = targets.map((target) => {
      let total = 0, count = 0, bright = 0;
      for (let y = target.y - 16; y < target.y + 16; y++) for (let x = target.x - 48; x < target.x + 48; x++) {
        if (x < 0 || y < 0 || x >= width || y >= 960) continue;
        total += delta(x, y); count++;
        const at = (y * width + x) * 4;
        if (luma(on, at) > 90) bright++;
      }
      return { osmId: target.osmId, height: target.height, meanDelta: Math.round(total / count), brightPx: bright };
    });
    return { movedShare: Math.round(moved / ((width / 2) * 480) * 1000) / 10, peakDelta: peak, walls };
  }, { shots });

  // 实测 7.3 %（窗纹那发是 18.1 %）：灯火是稀的点，占比本就低，下限证明它真的上屏、上限证明它没糊过窗纹。
  expect(fire.movedShare, `灯火开与关只差 ${fire.movedShare} % 的画面，这两层基本没上屏`).toBeGreaterThan(4);
  expect(fire.movedShare, `灯火开与关差 ${fire.movedShare} % 的画面，多过窗纹那一层了`).toBeLessThan(15);
  expect(fire.peakDelta, `灯火最亮的那处只把像素推动 ${fire.peakDelta}，不像加色层`).toBeGreaterThan(200);
  const lit = fire.walls.filter((wall) => wall.meanDelta > 10 && wall.brightPx > 0);
  expect(lit.length, `八面墙里只有 ${lit.length} 面被点亮：${JSON.stringify(fire.walls)}`).toBeGreaterThanOrEqual(6);
  // 同一排同样 112 m 的楼，点亮的多少差着一倍量——这才是"逐楼分档"而非"全城一块板"的屏幕证据。实测 19 对 57。
  const strong = fire.walls.filter((wall) => wall.meanDelta > 10);
  const ratio = Math.max(...strong.map((wall) => wall.meanDelta)) / Math.min(...strong.map((wall) => wall.meanDelta));
  expect(Math.round(ratio * 10) / 10, `最亮与最暗的墙只差 ${ratio.toFixed(2)} 倍，分档没落到屏上：${JSON.stringify(fire.walls)}`)
    .toBeGreaterThanOrEqual(1.8);
  expect(errors, `灯火进场之后引擎抛了：${errors.slice(0, 3).join(' | ')}`).toEqual([]);
});

// V4-8 的接力原来只接在现版那侧，理由是新引擎的相机不会飞（`setView` 是瞬移）。Phase 2 补了 `rig.flyTo` 之后
// 这一发就成立了：从 `?engine=three` 点顶栏那条链接，也要先把广州塔升成一枚圆盘再换页，对面那页照旧降下来。
test('the scene link hands the camera over from the new engine too', async ({ page }) => {
  test.setTimeout(240000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await openEngine(page, 'three');
  const lifted = await page.evaluate(async () => {
    const { neighborhood: n } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const { relayView, FLY_OUT_MS, writeHandoff, HANDOFF_KEY } = await import('/src/scene-flight.js');
    const { SCENES } = await import('/src/scenes.js');
    sessionStorage.removeItem(HANDOFF_KEY);
    sessionStorage.removeItem('probe.lowest');
    document.getElementById('scene-nav').addEventListener('click', (event) => {
      sessionStorage.setItem('probe.prevented', String(event.defaultPrevented));
    });
    window.setInterval(() => {
      const zoom = n.view ? n.view().zoom : null;
      if (Number.isFinite(zoom) && zoom < Number(sessionStorage.getItem('probe.lowest') ?? 99)) sessionStorage.setItem('probe.lowest', String(zoom));
    }, 50);
    // 起飞那一格应当落在哪一级，是引擎自己算出来的：3 km 圈缩到 150 px 需要 11.81 级。
    await n.liftOff(relayView(SCENES.canton), FLY_OUT_MS);
    return { zoom: n.view().zoom, pitch: n.view().pitch, relay: relayView(SCENES.canton).zoom };
  });
  expect(Math.abs(lifted.zoom - lifted.relay), `引擎的 liftOff 落在 ${lifted.zoom} 级，中继那一格该是 ${lifted.relay}`).toBeLessThan(0.15);
  // 现版那侧 `getPitch()` 返回的是它自己被设进去的那个数，可以正好是 0；新引擎每一帧从相机反解出俯仰
  // （`viewFromEye`），所以 0 读回来是 5.7e-5。判据按"读得回零"写，不按"字面等于零"写。
  expect(lifted.pitch, `引擎起飞之后俯仰还有 ${lifted.pitch}°，中继那一格是正俯视`).toBeLessThan(0.01);
  // 回到开屏机位，然后让**链接自己**做这件事：上面那一发量的是 `liftOff` 这个 API，下面这一发量的才是点击。
  await page.evaluate(async () => {
    const { neighborhood: n } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    n.setView({ center: { lat: 23.1095, lng: 113.31913 }, zoom: 15.5, bearing: -25, pitch: 62 });
    sessionStorage.removeItem('probe.lowest');
    sessionStorage.removeItem('probe.prevented');
  });
  await page.locator('#scene-nav a[href="?scene=jingtai"]').click();
  await page.waitForURL(/scene=jingtai/, { timeout: 60000 });
  const witnessed = await page.evaluate(() => ({
    prevented: sessionStorage.getItem('probe.prevented'), lowest: Number(sessionStorage.getItem('probe.lowest')),
  }));
  expect(witnessed.prevented, `新引擎那侧的链接没有被接走（defaultPrevented=${witnessed.prevented}）`).toBe('true');
  expect(witnessed.lowest, `点击之后、换页之前只到 ${witnessed.lowest} 级，链接没有先把街区升起来`).toBeLessThan(13.2);
  // 对面那页（链接不带 engine，所以落到现版）照旧要有降落那一段。
  const descent = await page.evaluate(async () => {
    const samples = [];
    const deadline = performance.now() + 12000;
    let n = null;
    while (performance.now() < deadline) {
      if (!n) {
        try {
          n = (await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src)).neighborhood;
        } catch { /* 模块还在下载 */ }
      }
      if (n?.map) samples.push({ zoom: Math.round(n.map.getZoom() * 100) / 100, moving: n.map.isMoving() });
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return samples;
  });
  expect(descent.length, '落地那侧一个采样都没拿到').toBeGreaterThan(5);
  expect(descent[0].moving, '从新引擎起飞之后，对面那页没有接着飞的那一段').toBe(true);
  const widest = descent.reduce((best, row) => (row.zoom < best.zoom ? row : best), descent[0]);
  expect(widest.zoom, `落地那侧最宽只到 ${widest.zoom} 级`).toBeLessThan(14.5);
  await page.waitForFunction(async () => {
    const { neighborhood: n } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    return n.map.loaded() && !n.map.isMoving();
  }, null, { timeout: 60000 });
  const landed = await page.evaluate(async () => {
    const { neighborhood: n } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const { HANDOFF_KEY } = await import('/src/scene-flight.js');
    const record = sessionStorage.getItem(HANDOFF_KEY);
    for (const key of ['probe.lowest', 'probe.prevented']) sessionStorage.removeItem(key);
    return { zoom: Math.round(n.map.getZoom() * 100) / 100, pitch: Math.round(n.map.getPitch() * 10) / 10,
      campus: n.map.queryRenderedFeatures({ layers: ['school-campus'] }).length, record };
  });
  expect(landed.campus, '落到的那侧不是景泰').toBeGreaterThan(0);
  expect(landed.zoom, `降落的终点停在 ${landed.zoom} 级，不是景泰的开屏机位 16.65`).toBeCloseTo(16.65, 2);
  expect(landed.pitch, `降落的终点俯仰是 ${landed.pitch}°，不是 58°`).toBeCloseTo(58, 1);
  expect(landed.record, '落地之后交接记录还在').toBeNull();
  expect(errors, `引擎换页时抛了：${errors.slice(0, 3).join(' | ')}`).toEqual([]);
});

test('both engines answer the same drag with the same numbers', async ({ page }) => {
  test.setTimeout(600000);
  // One gesture per page load. The first version ran them back to back on one page and the camera was still easing
  // from the previous drag when the next one started, so a defect in the pan rate failed the rotate claim - which
  // reads as a passing suite that cannot say which number broke.
  const legacy = await page.context().newPage();
  await legacy.setViewportSize({ width: 1440, height: 960 });
  const measure = async (target, engine, gesture) => {
    await openEngine(target, engine);
    const from = await settledHash(target);
    await target.mouse.move(720, 520);
    if (gesture === 'wheel') {
      await target.mouse.wheel(0, -100);
      await settledHash(target, await target.evaluate(() => location.hash));
    }
    else await drag(target, { dx: gesture === 'pan' || gesture === 'alt-rotate' ? 100 : 0, dy: gesture === 'alt-tilt' ? 100 : 0, alt: gesture.startsWith('alt') });
    const to = await settledHash(target);
    return { from, to };
  };
  const gestures = ['pan', 'alt-rotate', 'alt-tilt', 'wheel'];
  for (const gesture of gestures) {
    const mine = await measure(page, 'three', gesture);
    const theirs = await measure(legacy, 'maplibre', gesture);
    const readout = (sample) => ({ zoom: Math.round(sample.zoom * 1000) / 1000, pitch: Math.round(sample.pitch * 10) / 10, bearing: Math.round(sample.bearing) });
    if (gesture === 'pan') {
      const slid = metres(mine.from, mine.to), moved = metres(theirs.from, theirs.to);
      expect(moved / slid, `平移 100 像素：现版 ${moved.toFixed(1)} m，新引擎 ${slid.toFixed(1)} m`).toBeGreaterThan(0.95);
      expect(moved / slid, `平移 100 像素：现版 ${moved.toFixed(1)} m，新引擎 ${slid.toFixed(1)} m`).toBeLessThan(1.05);
    } else if (gesture === 'wheel') {
      const mine2 = mine.to.zoom - mine.from.zoom, theirs2 = theirs.to.zoom - theirs.from.zoom;
      expect(Math.abs(mine2), `滚轮一格：新引擎 ${mine2} 级，现版 ${theirs2} 级`).toBeGreaterThan(0.1);
      expect(Math.abs(theirs2 - mine2), `滚轮一格：现版 ${theirs2} 级，新引擎 ${mine2} 级`).toBeLessThan(0.04);
    } else {
      const spun = turn(mine.from.bearing, mine.to.bearing), tilted = mine.from.pitch - mine.to.pitch;
      const legacySpun = turn(theirs.from.bearing, theirs.to.bearing), legacyTilted = theirs.from.pitch - theirs.to.pitch;
      if (gesture === 'alt-rotate') {
        expect(Math.abs(spun), `⌥ 横向 100 像素转了 ${spun}°，现版 ${legacySpun}°`).toBeGreaterThan(18);
        expect(Math.abs(spun - legacySpun), `⌥ 横向 100 像素：现版 ${legacySpun}°，新引擎 ${spun}°`).toBeLessThan(1);
        // A turn that also slides the map is the bug the shipped gesture avoids, and it is what an ⌥ handler that
        // leaves OrbitControls' own pan live produces.
        expect(metres(mine.from, mine.to), `⌥ 横向 100 像素把地图平移了 ${metres(mine.from, mine.to).toFixed(1)} m`).toBeLessThan(2);
      } else {
        expect(tilted, `⌥ 纵向 100 像素压了 ${tilted}°，现版 ${legacyTilted}°`).toBeGreaterThan(23);
        expect(Math.abs(tilted - legacyTilted), `⌥ 纵向 100 像素：现版 ${legacyTilted}°，新引擎 ${tilted}°`).toBeLessThan(1);
        expect(Math.abs(turn(mine.from.bearing, mine.to.bearing)), `⌥ 纵向 100 像素顺带转了方位角 ${turn(mine.from.bearing, mine.to.bearing)}°`).toBeLessThan(1);
      }
    }
    console.log(`${gesture.padEnd(11)} 现版 ${JSON.stringify(readout(theirs.from))} → ${JSON.stringify(readout(theirs.to))} | 新引擎 ${JSON.stringify(readout(mine.from))} → ${JSON.stringify(readout(mine.to))}`);
  }
  await legacy.close();
});

// 右键拖拽不写"和现版一样"的平价判据，是刻意的。现版那一路是库的 around-center 模型：同一动作按抓取行不同转
// −12.8° / −20.3° / −83.8° / +33.2° / +25°（画面中心 y=480，跨过中心行方向反过来），既没法验收也没法解释，而中心行
// 那一档 0.8°/像素本身就是被否掉的"太灵"档的 1.6 倍。新引擎把三个旋转入口收到同一套已定数上，所以判据写成"抓在哪
// 都一样、且等于出厂定数"。上面那排数字来自 2026-10-04 的一次量测，对照表在 src/engine/gestures.js 的头注里。
test('the rotate entries turn at the calibrated rate wherever the drag starts', async ({ page }) => {
  test.setTimeout(420000);
  const samples = [];
  for (const [entry, options] of [
    ['右键@120', { y: 120, dx: 100, right: true }],
    ['右键@480', { y: 480, dx: 100, right: true }],
    ['右键@840', { y: 840, dx: 100, right: true }],
    ['⌃+左键@480', { y: 480, dx: 100, ctrl: true }],
    ['⌥+左键@480', { y: 480, dx: 100, alt: true }],
  ]) {
    await openEngine(page, 'three');
    const from = await settledHash(page);
    const to = await drag(page, options);
    samples.push({ entry, turned: turn(from.bearing, to.bearing), slid: metres(from, to) });
  }
  for (const sample of samples) {
    expect(Math.abs(sample.turned - 20), `${sample.entry} 横拖 100 像素转了 ${sample.turned.toFixed(1)}°，出厂定数是 20°`).toBeLessThan(1);
    expect(sample.slid, `${sample.entry} 横拖顺带把地图平移了 ${sample.slid.toFixed(1)} m`).toBeLessThan(2);
  }
  const spread = Math.max(...samples.map((sample) => sample.turned)) - Math.min(...samples.map((sample) => sample.turned));
  expect(spread, `同一动作按抓取点转得不一样：${samples.map((sample) => `${sample.entry} ${sample.turned.toFixed(1)}°`).join(' / ')}`).toBeLessThan(1);

  // The vertical half of the same drag lays the camera flat at its own measured rate and does not touch the bearing.
  await openEngine(page, 'three');
  const from = await settledHash(page);
  const to = await drag(page, { y: 480, dy: 100, right: true });
  expect(Math.abs(to.pitch - from.pitch + 25), `右键纵拖 100 像素压了 ${(from.pitch - to.pitch).toFixed(1)}°，定数是 25°`).toBeLessThan(1);
  expect(Math.abs(turn(from.bearing, to.bearing)), `右键纵拖 100 像素顺带转了方位角 ${turn(from.bearing, to.bearing).toFixed(1)}°`).toBeLessThan(1);
});

// 项 5：新引擎的动效对等。车流与行人用的是现版那套确定性算法（同一份路网、同一个米制原点），
// 交叉淡用的是同一份 `lampWeight` 与同一对周期，所以这一项钉的不是"引擎里有什么在动"，而是
// "同一时刻两边交出来的是不是同一批数"——读数并排、幅度并排、停下来还帧并排。
test('the new engine drives the near field and cross-fades the windows on the shipped clock', async ({ page }) => {
  test.setTimeout(300000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
  const CLIP = { x: 620, y: 300, width: 720, height: 460 };
  await openEngine(page, 'three');
  await page.evaluate(async () => {
    const { neighborhood: n } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    window.__probe = { n };
  });
  const read = () => page.evaluate(() => {
    const status = window.__probe.n.motionStatus();
    return { near: window.__probe.n.nearTraffic(), lights: status.lights, lampTicks: status.lampTicks,
      lamps: status.lamps, on: status.on, counts: window.__probe.n.counts() };
  });
  // ① 车流：白昼也在场、也在走——现版那侧项 1 修的就是这一格，两边必须给同一个答案。
  const day = await read();
  expect(day.near, '新引擎没有近场').not.toBeNull();
  expect([day.near.cars, day.near.walkers, day.near.radius, day.near.walkerMinZoom],
    `近场的数与现版不是同一批：${JSON.stringify(day.near)}`).toEqual([1298, 1244, 1500, 16.5]);
  expect([day.near.visible, day.near.lamps, day.near.people], '白昼的近场该在场、不亮灯、不画人')
    .toEqual([true, false, false]);
  // ①b 江上的船：同一份中心线、同一个可见度半径、同一把时钟。现版那侧 `runTraffic` 多除了一次 1000，
  // 船就以千分之一速冻在江面上——所以这里不比"两边各有几条"，比的是同一次读数里车与船的时钟是不是同一个数。
  expect([day.near.boats, day.near.boatRadius, day.near.boatLights],
    `江上的船没按现版那批数接进新引擎：${JSON.stringify(day.near)}`).toEqual([18, 2200, false]);
  expect(day.near.boatClock, `船和车不在同一把秒数上：车 ${day.near.clock} s，船 ${day.near.boatClock} s`)
    .toBe(day.near.clock);
  const dayClock = await page.evaluate(async () => {
    const pick = () => {
      const status = window.__probe.n.motionStatus();
      return { lights: status.lights, lampTicks: status.lampTicks, lamps: status.lamps };
    };
    const before = pick();
    await new Promise((resolve) => setTimeout(resolve, 2400));
    return { before, after: pick() };
  });
  expect(dayClock.after.lights - dayClock.before.lights,
    `白昼的新引擎 2.4 s 只推进了 ${dayClock.after.lights - dayClock.before.lights} 拍`).toBeGreaterThanOrEqual(10);
  // 灯窗那一拍在白天必须不推进，且权重必须停在出厂那一对 1/1——现版 `map.js` 的 `atmosphereId === 'night'` 闸门
  // 就是这个形状。这条钉的是"切到夜景的第一秒两边画的是同一帧"：白天偷偷走的话，一按到夜景这边从半路开始淡，
  // 现版却从 1/1 起步。注入办法是把 `stepMotion` 里那句 `if (atmosphereId === 'night')` 拿掉，两个数当场报红。
  expect(dayClock.after.lampTicks - dayClock.before.lampTicks,
    `白昼的灯窗拍推进了 ${dayClock.after.lampTicks - dayClock.before.lampTicks} 次：现版那侧这一档是 0`).toBe(0);
  expect(dayClock.after.lamps, `白昼的权重被偷偷走过：${JSON.stringify(dayClock.after.lamps)}`).toEqual([1, 1]);
  // ② 夜景：灯亮了，两组权重开始走，而且互相错开——与现版那条"两组不同周期"的判据同一条。
  await page.locator('[data-atmosphere-option="night"]').click();
  await page.waitForTimeout(2500);
  expect((await read()).near.boatLights, '夜里船上的窗带没跟着亮').toBe(true);
  const drift = [];
  for (let i = 0; i < 10; i++) {
    drift.push((await read()).lamps.map((value) => Math.round(value * 100) / 100));
    await page.waitForTimeout(1400);
  }
  expect(drift.some(([a, b]) => Math.abs(a - b) > 0.2), `十次采样里两组从没错过步：${JSON.stringify(drift)}`).toBe(true);
  expect(drift.some(([a]) => a < 0.01) && drift.some(([a]) => a > 0.99),
    `组 0 没有走完一个来回：${JSON.stringify(drift)}`).toBe(true);
  // ③ 幅度：把动效停住、只钉权重，量的方法与现版那侧完全一样（钉权重不是样式改动，新引擎也没有重图集这一步）。
  await page.evaluate(() => window.__probe.n.setMotion(false));
  await page.waitForTimeout(800);
  expect((await read()).near.boatClock, '关掉动效之后船没回到第 0 秒').toBe(0);
  const shot = async (w0, w1) => {
    await page.evaluate(async ([a, b]) => {
      window.__probe.n.setLampWeights(a, b);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }, [w0, w1]);
    await page.waitForTimeout(700);
    return (await page.screenshot({ clip: CLIP })).toString('base64');
  };
  const grade = async (a, b) => page.evaluate(async ({ a, b }) => {
    const load = async (source) => {
      const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${source}`)).blob());
      const surface = new OffscreenCanvas(image.width, image.height);
      const context = surface.getContext('2d');
      context.drawImage(image, 0, 0);
      return { width: image.width, height: image.height, data: context.getImageData(0, 0, image.width, image.height).data };
    };
    const x = await load(a), y = await load(b);
    const changed = new Uint8Array(x.width * x.height);
    let moved = 0;
    for (let i = 0, p = 0; i < x.data.length; i += 4, p++) {
      changed[p] = Math.max(Math.abs(x.data[i] - y.data[i]), Math.abs(x.data[i + 1] - y.data[i + 1]), Math.abs(x.data[i + 2] - y.data[i + 2])) > 8 ? 1 : 0;
      if (changed[p]) moved++;
    }
    let cluster = 0, patches = 0;
    const box = 24;
    for (let top = 0; top + box < x.height; top += 6) {
      const column = new Int32Array(x.width);
      for (let py = top; py < top + box; py++) for (let px = 0; px < x.width; px++) column[px] += changed[py * x.width + px];
      for (let left = 0; left + box < x.width; left += 6) {
        let count = 0;
        for (let px = left; px < left + box; px++) count += column[px];
        cluster = Math.max(cluster, count);
        if (count >= 48) patches++;
      }
    }
    return { moved, cluster, patches };
  }, { a, b });
  const shipped = await shot(1, 1);
  const swapped = await shot(0, 1);
  // 分母：把灯火那八层藏起来再拍一张，与出厂那一帧的差就是"这两层在画面上到底值多少像素"。
  // 这一步在现版那侧是踩不得的（改样式会触发重图集，见 README 的 #114 一条），在新引擎这一侧是干净的：
  // 这里没有按上传历史重排的图集，藏与不藏只差那八发的绘制。
  await page.evaluate(() => {
    const hidden = [];
    window.__probe.n.scene.traverse((object) => {
      if (/^building-(lamps|glow)-/.test(object.name ?? '')) { hidden.push(object); object.visible = false; }
    });
    window.__probe.hidden = hidden;
  });
  await page.waitForTimeout(700);
  const without = (await page.screenshot({ clip: CLIP })).toString('base64');
  const worth = await grade(shipped, without);
  await page.evaluate(() => { for (const object of window.__probe.hidden) object.visible = true; });
  await page.waitForTimeout(700);
  expect(worth.moved, `灯火两层全部藏掉只改了 ${worth.moved} 颗：这两层根本没上屏，上面的幅度判据没有对象`)
    .toBeGreaterThan(CLIP.width * CLIP.height * 0.02);
  expect(await grade(shipped, await shot(1, 1)), '把灯火层放回来没有拿回出厂那一帧').toMatchObject({ moved: 0 });
  const firstSwap = await grade(shipped, swapped);
  // 三条判据各自钉一种缺陷，刻度来自 `scripts/probe-lamp-cluster.mjs` 在同一机位量出的三张表，并且每一条都
  // 按源码级注入复跑过一次（改哪一行、红在哪一条、数字对不对得上，三条全中）：
  //   出厂                                  moved 2,563 / cluster 265 / ≥48 的小窗 163 个
  //   `LAMP_ALT_COLUMN = 0`（两手册同一列）  1,077 / 258 / 128 → 红在 moved
  //   `lampCellOf` 的 breath 恒 0（只剩换格）  1,712 / 79 / 20  → 红在 cluster
  //   `lampCellOf` 的 breath 恒 1（全员呼吸）  7,901 / 326 / 809 → 红在 patches
  // cluster 的门槛沿用现版那条 144：现版同一机位是 290（tests/browser.spec.js 里量的），新引擎 265，
  // 两边同一档；"没有楼整栋灭"的 79 与现版那条格级换窗的 90 都在线下，所以这不是把两引擎的数硬拧成一样，
  // 是同一件事在两处各自量到了。
  expect(firstSwap.cluster, `新引擎的交叉淡最挤的 24×24 只有 ${firstSwap.cluster} 颗：整栋慢灭没有过来`)
    .toBeGreaterThanOrEqual(144);
  // moved 的门槛取在出厂（2,563）与"两手册同一列"（1,077）之间偏下：第二手没接上时画面只剩"整栋灭"那一小撮，
  // 800 那颗旧门槛正好放过它（上一版就是这么漏的），所以按量到的缺陷值抬到 1,500。
  expect(firstSwap.moved, `新引擎一次交叉淡只改了 ${firstSwap.moved} 颗：另一手没有真的上屏`).toBeGreaterThan(1500);
  expect(firstSwap.patches, `新引擎一次交叉淡有 ${firstSwap.patches} 个 24×24 小窗在动：这不是七分之一的楼在呼吸，是全城同闪`)
    .toBeLessThan(400);
  // ④ 停下来还帧：权重回到 1/1 必须是钉之前那张，逐字节。现版那侧这一条被 MapLibre 的重图集咬过，
  //    新引擎没有那一步，所以这条在引擎这一侧可以按逐字节钉——它同时也是"两手感一致"的反证。
  const back = await shot(1, 1);
  expect(back, '把权重放回 1/1 没有回到出厂那一帧').toBe(shipped);
  expect(errors).toEqual([]);
});

// 项 7：夜景那一层泛光。四件事各自要有一格读数，因为它们各自会坏，而且坏法互不遮掩：
// ① 门禁——只有夜景这一档走那条链，白昼与日落那份画面一个像素都不过合成器；
// ② 缓冲分辨率——半分辨率跑完整条链再贴回画布，整帧会糊（看不出错但一眼不清）；
// ③ 晕要看得见面：把原本不到 100 灰度的像素推过 100（灯芯外面那一圈）；
// ④ 底噪不能被抬起来：全幅中位只许动几个灰度，否则就是"蒙了一层灰"而不是泛光。
test('the new engine blooms its night lamps without veiling the frame', async ({ page }) => {
  test.setTimeout(300000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openEngine(page, 'three');
  await page.evaluate(async () => {
    const { neighborhood: n } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    window.__probe = { n };
  });
  expect((await page.evaluate(() => window.__probe.n.bloomState())).share, '白昼那一档就给了泛光档位').toBe(0);
  await page.locator('[data-atmosphere-option="night"]').click();
  await page.waitForTimeout(3000);
  const live = await page.evaluate(() => {
    const canvas = document.querySelector('.engine-canvas');
    return { bloom: window.__probe.n.bloomState(), buffer: [canvas.width, canvas.height] };
  });
  expect(live.bloom.share, '切到夜景没给泛光满档').toBe(1);
  expect(live.bloom.size, `泛光那条链的缓冲是 ${JSON.stringify(live.bloom.size)}，画布的 drawing buffer 是 ${JSON.stringify(live.buffer)}`)
    .toEqual(live.buffer);
  // 关掉动效再比：两档之间只许差在晕上，不许差在车流走了一格。
  await page.evaluate(() => window.__probe.n.setMotion(false));
  await page.waitForTimeout(1200);
  const clip = { x: 300, y: 120, width: 900, height: 700 };
  const shot = async (share) => {
    await page.evaluate(async (value) => {
      window.__probe.n.setBloom(value);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }, share);
    return (await page.screenshot({ clip })).toString('base64');
  };
  const off = await shot(0);
  const on = await shot(1);
  const back = await shot(0);
  // 逐像素比在页面里做：两份 180 万个数的数组来回传一次比这一项本身还慢。
  const diff = await page.evaluate(async ([a, b, c]) => {
    const luma = (base64) => new Promise((resolve) => {
      const image = new Image();
      image.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.drawImage(image, 0, 0);
        const { data } = context.getImageData(0, 0, image.width, image.height);
        const out = new Float32Array(image.width * image.height);
        for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
          out[p] = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
        }
        resolve(out);
      };
      image.src = `data:image/png;base64,${base64}`;
    });
    const [A, B, C] = await Promise.all([luma(a), luma(b), luma(c)]);
    const median = (values) => Float32Array.from(values).sort()[values.length >> 1];
    const count = (test2) => values => values.reduce((sum, value) => sum + (test2(value) ? 1 : 0), 0);
    let halo = 0; let lifted = 0;
    for (let i = 0; i < A.length; i += 1) {
      if (A[i] < 100 && B[i] >= 100) halo += 1;
      if (B[i] - A[i] > 2) lifted += 1;
    }
    return { halo, lifted, medianOff: +median(A).toFixed(1), medianOn: +median(B).toFixed(1),
      blown: count((value) => value >= 250)(B) - count((value) => value >= 250)(A),
      // 同一档连拍两次必须逐字相同：不是的话这一项量的就是抖动而不是泛光（引擎按需出帧，改完可见性要等一帧）。
      repeat: A.reduce((worst, value, index) => Math.max(worst, Math.abs(value - C[index])), 0).toFixed(2) };
  }, [off, on, back]);
  expect(Number(diff.repeat), `同一档连拍两次不一样（最大差 ${diff.repeat}）：这一项量的就不是泛光了`).toBe(0);
  expect(diff.halo, `泛光只把 ${diff.halo} 颗像素推到 100 灰度以上：晕看不见面（关掉那一档是 0）`).toBeGreaterThanOrEqual(250);
  expect(diff.lifted, `只有 ${diff.lifted} 颗像素被抬起来：这一档等于没开`).toBeGreaterThanOrEqual(20000);
  expect(diff.medianOn - diff.medianOff, `全幅中位从 ${diff.medianOff} 抬到 ${diff.medianOn}：这不是晕，是蒙灰`).toBeLessThanOrEqual(4);
  expect(diff.blown, `泛光多烧掉 ${diff.blown} 颗像素（≥250）：亮窗那档过曝了`).toBeLessThanOrEqual(40);
  // 切回白昼：档位归零，那条链整个不走（白昼那份画面与本轮之前逐字相同，由现版那 71 发判据共同守着）。
  await page.locator('[data-atmosphere-option="day"]').click();
  await page.waitForTimeout(2500);
  expect((await page.evaluate(() => window.__probe.n.bloomState())).share, '切回白昼泛光没归零').toBe(0);
  expect(errors).toEqual([]);
});
