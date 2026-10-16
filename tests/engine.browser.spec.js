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

test('the three.js engine mounts behind the switch, draws the ground and all 3,987 blocks, and keeps the old path', async ({ page }) => {
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
  // 3,990 → **3,987**：壳体站在那三块地上（西塔／东塔／省博），盒子必须让位，否则一栋塔两套皮
  // （#190；现版那侧同一件事是样式里的 `formFilter`）。让位的名单由 `壳体 4 片` 那一格与地标那一项共同钉住。
  expect(scene.panel, 'the FPS panel does not say what it is grading').toContain('3987 栋');
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
    // 地标那一层先按名字找出来存好：下面量塔脚那片基底时要把它摘掉（找不到就当场报，别让它静默地不摘）。
    neighborhood.scene.traverse((object) => { if (object.name === 'landmarks') window.__landmarks = object; });
    if (!window.__landmarks) throw new Error('地标那一层没挂在引擎的场景上：塔脚那一格摘不出来');
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
  // 塔脚那一点上现在站着塔自己的底座（`createTowerModel` 那圈半径 42~46 m 的 `pale`，实测把那一格压到
  // 163,175,171），所以量地面之前先把地标那一层摘掉：这一格说的是"地面那层把塔脚那片基底画成 background 色"，
  // 不是"塔脚那一点看上去一定是 background 色"。摘掉再量，量的还是原来那一格。
  await page.evaluate(() => { window.__landmarks.visible = false; });
  const foot = await rgbAt(spots.foot, '塔脚');
  await page.evaluate(() => { window.__landmarks.visible = true; });
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
  // 所以这里同时钉"桶数没有偷偷回到一栋一个"：全量 3,987 面若是一栋一个 Mesh，这一发就是四千个 draw call。
  expect(spots.calls.drawCalls, `合并之后还有 ${spots.calls.drawCalls} 个 draw call`).toBeLessThan(100);
  expect(spots.calls.buildings, `面板说画了 ${spots.calls.buildings} 栋`).toBe(3987);
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
  // 现版那侧的取景带着 `setPadding`（{top:200,left:280,right:0,bottom:60}），那套排版把投影中心从画布中心挪走 140×70 px。
  // #191 之前这一侧没有那一维，对照只能先把现版的留白抹掉——那是把没对齐的一维从对照里拿走。现在两边读同一张表
  // （`src/padding.js`，新引擎侧 `panelOpen` 恒为 false 因为这一侧还没有街区清单面板），所以**带着留白比**：
  // 这一条量的是"同一串 hash 在两边框出同一张画面"，抹掉留白反而会把 #191 整格判据让掉。
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
  // 名牌是在渲染帧里重新摆的，读早了拿到的是上一秒的盒子；连续两读一致才算落定。
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
    // 最挤的那一格（同一高度档 + 同色温 + 同距离环）占多少顶点：3,987 栋摊到 63 格，实测最大 6~10 %。
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
  // 这块 900×700 的框跟着同一张留白表走（#191）：现版把地理中心放在抠掉留白那块窗口的正中，画面因此整体偏出
  // (140, 70)，框若还钉在旧位置就量到的是塔南那排楼而不是原来那批灯。四个门槛（250／20,000／4／40）是量出来的
  // 数，一个都不改——改的是框，量的还是那一块城市。
  const shift = await page.evaluate(async () => {
    const { paddingShift, viewportPadding } = await import('/src/padding.js');
    return paddingShift(viewportPadding(false));
  });
  const clip = { x: Math.round(300 + shift.x), y: Math.round(120 + shift.y), width: 900, height: 700 };
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
  // 地标那一层不吃这条链（#190）：塔冠关着泛光就有 248/255（线性 ~0.94），比任何还能让灯芯起晕的门槛都亮，
  // 留在链里就是塔把整条链的能量摊到全幅——这块 900×700 的中位抬 5.7、多烧掉 575 颗，塔腰的格子糊成一团白
  // （16 格扫参在 `scripts/probe-bloom-rescan.mjs`，两头的门槛都对不上，所以这一格没有参数解）。
  // 现版那侧的塔本来就没有这条链，所以"地标不进泛光的源"是两边同一张画面，不是新引擎少给一份效果。
  // 这一格读两样：链自己报"谁被挡在外面"，再看这一层画过的那些像素在开/关之间动不动。
  const bare = await (async () => {
    await page.evaluate(async () => {
      window.__probe.n.setBloom(1);
      let node = null;
      window.__probe.n.scene.traverse((object) => { if (object.name === 'landmarks') node = object; });
      node.visible = false;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    const frame = (await page.screenshot({ clip })).toString('base64');
    await page.evaluate(async () => {
      let node = null;
      window.__probe.n.scene.traverse((object) => { if (object.name === 'landmarks') node = object; });
      node.visible = true;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    return frame;
  })();
  expect((await page.evaluate(() => window.__probe.n.bloomState())).excluded,
    '泛光那条链没把地标那一层挡在源外面').toEqual(['landmarks']);
  // 逐像素比在页面里做：两份 180 万个数的数组来回传一次比这一项本身还慢。
  const diff = await page.evaluate(async ([a, b, c, d]) => {
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
    const [A, B, C, D] = await Promise.all([luma(a), luma(b), luma(c), luma(d)]);
    const median = (values) => Float32Array.from(values).sort()[values.length >> 1];
    const count = (test2) => values => values.reduce((sum, value) => sum + (test2(value) ? 1 : 0), 0);
    let halo = 0; let lifted = 0;
    for (let i = 0; i < A.length; i += 1) {
      if (A[i] < 100 && B[i] >= 100) halo += 1;
      if (B[i] - A[i] > 2) lifted += 1;
    }
    // 同一档泛光下"有这一层 vs 没这一层"比出来的那一批像素，就是这一层自己画的；
    // 再看这一批像素在开/关之间被抬了多少——地标不吃链的话，这一半像素该原地不动。
    const marks = [];
    for (let i = 0; i < B.length; i += 1) if (Math.abs(B[i] - D[i]) > 2) marks.push(i);
    const lift = marks.map((i) => B[i] - A[i]);
    return { halo, lifted, medianOff: +median(A).toFixed(1), medianOn: +median(B).toFixed(1),
      blown: count((value) => value >= 250)(B) - count((value) => value >= 250)(A),
      footprint: marks.length, insideMedian: +median(lift).toFixed(2),
      // 最坏那一格只报正方向：泛光只会往上抬，往下走的是那三条透明落水带（底下那批像素本来就归灯管）。
      insideWorst: +lift.reduce((top, value) => (value > top ? value : top), 0).toFixed(1),
      // 同一档连拍两次必须逐字相同：不是的话这一项量的就是抖动而不是泛光（引擎按需出帧，改完可见性要等一帧）。
      repeat: A.reduce((worst, value, index) => Math.max(worst, Math.abs(value - C[index])), 0).toFixed(2) };
  }, [off, on, back, bare]);
  console.log(`泛光那一块 ${clip.width}×${clip.height}（框跟着留白表偏出 ${shift.x},${shift.y}）：halo ${diff.halo}／lifted ${diff.lifted}／blown ${diff.blown}／中位 ${diff.medianOff}→${diff.medianOn}／地标那 ${diff.footprint} 颗被抬中位 ${diff.insideMedian}`);
  expect(Number(diff.repeat), `同一档连拍两次不一样（最大差 ${diff.repeat}）：这一项量的就不是泛光了`).toBe(0);
  expect(diff.halo, `泛光只把 ${diff.halo} 颗像素推到 100 灰度以上：晕看不见面（关掉那一档是 0）`).toBeGreaterThanOrEqual(250);
  expect(diff.lifted, `只有 ${diff.lifted} 颗像素被抬起来：这一档等于没开`).toBeGreaterThanOrEqual(20000);
  expect(diff.medianOn - diff.medianOff, `全幅中位从 ${diff.medianOff} 抬到 ${diff.medianOn}：这不是晕，是蒙灰`).toBeLessThanOrEqual(4);
  expect(diff.blown, `泛光多烧掉 ${diff.blown} 颗像素（≥250）：亮窗那档过曝了`).toBeLessThanOrEqual(40);
  // 2026-10-14 实测：这一层自己画了 23,607 颗像素（这块 900×700 里），其中位被泛光抬 0、最坏那 17.9 颗
  // 全在透明落水带上（它们本来就压在会起晕的江面上）。把 `exclude` 那一格删掉，中位当场涨到 5 以上。
  expect(diff.footprint, `地标那一层只画了 ${diff.footprint} 颗像素：这一格量不到东西`).toBeGreaterThanOrEqual(20000);
  expect(diff.insideMedian, `泛光把地标自己画的那 ${diff.footprint} 颗像素中位抬了 ${diff.insideMedian}：这一层又进链了`)
    .toBeLessThanOrEqual(1);
  // 切回白昼：档位归零，那条链整个不走（白昼那份画面与本轮之前逐字相同，由现版那 71 发判据共同守着）。
  await page.locator('[data-atmosphere-option="day"]').click();
  await page.waitForTimeout(2500);
  expect((await page.evaluate(() => window.__probe.n.bloomState())).share, '切回白昼泛光没归零').toBe(0);
  expect(errors).toEqual([]);
});

// 页面外项 10：这一侧缺什么要写在界面上，灰着的按钮要各带一句理由，缩放要有按钮。
// 原来 `?engine=three` 只点亮六个控件，其余灰着且页面不说为什么（用户 2026-10-10 点名的那一格）；
// 而"放大/缩小"那对按钮是 MapLibre 自带的控件，这一侧根本没有 MapLibre，所以不是灰着，是不存在。
test('the new engine says what it cannot do, and still has a zoom button', async ({ page }) => {
  test.setTimeout(180000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const { VIEW_LIMITS } = await import('../src/config.js');
  await openEngine(page, 'three');
  const ui = await page.evaluate(() => ({
    zoomers: [...document.querySelectorAll('#view-controls .zoom-step')].map((button) => ({
      label: button.getAttribute('aria-label'), disabled: button.disabled,
    })),
    note: document.querySelector('.engine-note')?.textContent ?? '',
    hint: document.getElementById('gesture-hint').textContent.replace(/\s+/g, ' '),
    greyed: [...document.querySelectorAll('#view-controls button[disabled], #places-toggle, #search-toggle, #tour-start, .scene-key button')]
      .map((button) => ({ id: button.id || button.className, title: button.title })),
  }));
  expect(ui.zoomers.map((button) => button.label), '缩放按钮没补齐或标签不对').toEqual(['放大一级', '缩小一级']);
  expect(ui.zoomers.every((button) => !button.disabled), '缩放按钮在引擎这一侧还是灰的').toBe(true);
  expect(ui.greyed.length, `该灰着的控件数变了：${JSON.stringify(ui.greyed.map((row) => row.id))}`).toBeGreaterThanOrEqual(5);
  const mute = ui.greyed.filter((row) => !row.title);
  expect(mute, `这些控件灰着但页面不给理由：${JSON.stringify(mute)}`).toEqual([]);
  // 手势那一行不许承诺这一侧做不到的事（"点击楼块查看"在新引擎里是不成立的）。
  expect(ui.hint, `手势提示还在说这一侧做不到的事：${ui.hint}`).not.toContain('点击楼块');
  // 边界那一行不许说谎：已经进这一侧的东西不能被写成"还缺"，还缺的整块能力必须点名。
  // （注入办法：把 `main.js` 那行改回"塔身、桥……还没过来"，第一格当场红——这一格量的就是"迁完了有没有把话改过来"。）
  expect(ui.note, '边界那一行没有"已接／还缺"这两段：').toMatch(/已接.*还缺/);
  const missing = /还缺(.*)$/.exec(ui.note)[1];
  expect(missing, `壳体与桥已经进这一侧了，边界那行还把它们算成缺的：${missing}`).not.toMatch(/壳体|塔身|桥/);
  // #192-A：广场那四层地面（含米数铺装贴花）已经在这侧画出来了，"还缺"里再写它就是说谎。
  expect(missing, `广场地面已经进这一侧了，边界那行还把它算成缺的：${missing}`).not.toMatch(/广场/);
  expect(missing, `边界那一行没点名还缺检索：${missing}`).toMatch(/检索/);
  expect(missing, `边界那一行没点名还缺导览：${missing}`).toMatch(/导览/);
  // 一次点击 = 一级，并且受限幅夹住（夹在相机里，不在按钮上）。
  const zoomOf = () => page.evaluate(() => Number(location.hash.split('/')[0].replace('#map=', '')));
  const start = await zoomOf();
  await page.locator('.zoom-step', { hasText: '＋' }).click();
  await page.waitForTimeout(1600);
  expect(Math.abs((await zoomOf()) - start - 1), `点一次 ＋ 只走了 ${(await zoomOf()) - start} 级`).toBeLessThan(0.05);
  for (let i = 0; i < 14; i++) await page.locator('.zoom-step', { hasText: '＋' }).click();
  await page.waitForTimeout(2600);
  expect(await zoomOf(), `连点 14 次 ＋ 冲到了 ${await zoomOf()} 级，限幅没夹住`).toBeLessThanOrEqual(VIEW_LIMITS.maxZoom + 1e-6);
  // 窄屏：那一行边界说明不许把页面横向撑开，也不许压住控制条（控制条在 25% 死区里本来会淡出，所以量的是它）。
  for (const width of [720, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(900);
    const box = await page.evaluate(() => {
      const note = document.querySelector('.engine-note')?.getBoundingClientRect();
      const bar = document.querySelector('#view-controls')?.getBoundingClientRect();
      return { hscroll: document.documentElement.scrollWidth > innerWidth,
        noteBottom: note ? Math.round(note.bottom) : null, barTop: bar ? Math.round(bar.top) : null,
        noteLeft: note ? Math.round(note.left) : null, noteRight: note ? Math.round(note.right) : null, innerWidth };
    });
    expect(box.hscroll, `${width} px 上页面被横向撑开了`).toBe(false);
    expect(box.noteLeft, `${width} px 上那一行超出左边`).toBeGreaterThanOrEqual(0);
    expect(box.noteRight, `${width} px 上那一行超出右边`).toBeLessThanOrEqual(box.innerWidth);
    expect(box.noteBottom - box.barTop, `${width} px 上那一行与控制条重叠（${box.noteBottom} vs ${box.barTop}）`).toBeGreaterThan(0);
  }
  expect(errors).toEqual([]);
});

test('the new engine gives back every geometry, material and texture it made', async ({ page }) => {
  test.setTimeout(200000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await openEngine(page, 'three');
  await page.evaluate(async () => {
    const { neighborhood: n } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    window.__probe = { n };
  });
  // 先证明这一页真的有近场：没有车、没有船的话，下面那份台账就只是在一堆空数组上永真。
  const live = await page.evaluate(() => window.__probe.n.nearTraffic());
  expect([live.cars, live.walkers, live.boats], `近场没装配，这条判据量的是空场景：${JSON.stringify(live)}`)
    .toEqual([1298, 1244, 18]);
  // 台账按"最近的有名祖先"归类，所以报红时直接点名漏的是哪一组（59 几何 + 62 材质 + 29 贴图 = 150 样，
  // 2026-10-16 实测：广场那一层进来之前是 55/58/28 = 141 样，地标那一层进来之前是 29/31/11 = 71 样）。
  const census = await page.evaluate(() => {
    const rows = [];
    const seen = new Set();
    const owner = (object) => { for (let node = object; node; node = node.parent) if (node.name) return node.name; return '(unnamed)'; };
    const add = (item, kind, object) => {
      if (!item || seen.has(item)) return;
      seen.add(item);
      const ordinal = rows.length;
      rows.push({ kind, owner: owner(object), fired: false });
      item.addEventListener('dispose', () => { rows[ordinal].fired = true; });
    };
    window.__probe.n.scene.traverse((object) => {
      add(object.geometry, 'geometry', object);
      for (const material of [].concat(object.material ?? [])) {
        add(material, 'material', object);
        for (const value of Object.values(material)) if (value && value.isTexture) add(value, 'texture', object);
        // 片元注入那几份材质把贴图握在 `shader.uniforms` 里（江面波光那张就是），翻材质属性看不见它，
        // 所以台账还要走一遍 uniform——否则这一层换氛围留下的那张贴图没人查。
        // 例外：`DFG_LUT` 是 three.js 渲染器自己那颗全局查找表，它挂在每份 shader 的 uniform 里，
        // 归属不在本场景（2026-10-14 实测：走 uniform 之后台账多出的那一条没还的就是它，挂在第一个被遍历到的材质名下）。
        for (const uniform of Object.values(material.userData?.shader?.uniforms ?? {})) {
          if (uniform?.value?.isTexture && uniform.value.name !== 'DFG_LUT') add(uniform.value, 'texture', object);
        }
      }
    });
    window.__ledger = rows;
    const named = {};
    window.__probe.n.scene.traverse((object) => { if (object.name && object.isObject3D && !named[object.name]) named[object.name] = object; });
    window.__groups = Object.fromEntries(['traffic-life', 'water-life', 'shore-wet', 'building-bases-group', 'river-sheen',
      'landmarks', 'plaza-ground'].map((name) => [name, named[name] ?? null]));
    return { total: rows.length, byKind: rows.reduce((a, r) => { a[r.kind] = (a[r.kind] ?? 0) + 1; return a; }, {}),
      owners: [...new Set(rows.map((r) => r.owner))].sort(),
      missingGroups: Object.entries(window.__groups).filter(([, node]) => !node).map(([name]) => name) };
  });
  expect(census.byKind, `三样一样都不能缺（几何/材质/贴图）：${JSON.stringify(census.byKind)}`)
    .toEqual({ geometry: 59, material: 62, texture: 29 });
  expect(census.missingGroups, `这些组没挂进引擎的场景，"摘干净"那一半就量不到：${JSON.stringify(census.missingGroups)}`)
    .toEqual([]);
  // 漏了 #177 的那几组名字必须出现在台账里，否则这条判据量到的可能只是引擎自己那五块。
  for (const group of ['traffic-cars', 'traffic-lamps', 'traffic-walkers', 'water-boats', 'signal-poles', 'shore-wet-line', 'building-bases']) {
    expect(census.owners, `台账里没有 ${group}，近场那几组没挂进场景`).toContain(group);
  }
  // 地标那一层同理：一块壳体、一座桥、塔身网格、光柱与三条带各自都要在台账里点名——
  // 少一块就是有人搬了画面没搬 teardown（台账总数从 71 样涨到 141 样，多出来的这一半就是这些名字）。
  // 名单取的是"资源自己那一格最近的有名祖先"，所以 `landmarks` 与 `landmark-forms` 这两层壳不会出现在里面。
  for (const group of ['184738716', '240896442', '511404889', '1313608038', '1313608038:rib', '1313608038:abutment',
    '184738716:crown', '511404889:crown', '184738716:podium', 'tower-model', 'beam', 'river-glow',
    '184738716:spill', '511404889:spill']) {
    expect(census.owners, `台账里没有 ${group}，地标那一层没整块挂进场景`).toContain(group);
  }
  // 广场那一层同理：三块板与那张乘性网格（连带它背后那张贴图）都要在台账里点名——
  // 少一块就是有人搬了画面没搬 teardown（台账总数从 141 样涨到 150 样，多出来的九样就是这些名字与那张图）。
  for (const group of ['plaza-lawn', 'plaza-stone', 'plaza-walk', 'canton-plaza-surface']) {
    expect(census.owners, `台账里没有 ${group}，广场那一层没整块挂进场景`).toContain(group);
  }
  const after = await page.evaluate(() => {
    window.__probe.n.dispose();
    const rows = window.__ledger;
    const tally = {};
    for (const row of rows) {
      const cell = (tally[row.owner] ??= { total: 0, missed: 0 });
      cell.total += 1;
      if (!row.fired) cell.missed += 1;
    }
    return { total: rows.length, fired: rows.filter((r) => r.fired).length,
      missed: rows.map((r, i) => r.fired ? null : `${r.kind}:${r.owner}`).filter(Boolean),
      leaky: Object.fromEntries(Object.entries(tally).filter(([, cell]) => cell.missed > 0)),
      panel: document.querySelector('.engine-stats') !== null,
      left: Object.fromEntries(Object.entries(window.__groups).map(([name, node]) => [name, node.children.length])) };
  });
  expect(after.leaky, `场景里还挂着 ${after.total} 样，其中 ${after.total - after.fired} 样没还：${JSON.stringify(after.leaky)}`)
    .toEqual({});
  expect(after.missed, `dispose 没还掉：${JSON.stringify(after.missed)}`).toEqual([]);
  // 还了资源不等于摘了节点：`group.clear()` 那一半单独钉，与 Node 侧那条 `[0, 0, 0]` 同一个口径。
  expect(after.left, `dispose 之后这些组里还留着节点：${JSON.stringify(after.left)}`)
    .toEqual({ 'traffic-life': 0, 'water-life': 0, 'shore-wet': 0, 'building-bases-group': 0, 'river-sheen': 0,
      landmarks: 0, 'plaza-ground': 0 });
  expect(after.panel, 'dispose 之后读数面板还留在页面上').toBe(false);
  // 贴图归造它的那一方还（`boot.js` 那颗光晕、`scene.js` 那两张图集），这里只要求"有人还了"。
  expect(errors, `拆场景的过程中报了错：${JSON.stringify(errors)}`).toEqual([]);
});


// 项 5 剩下的那一格（#189）：江面那层波光进新引擎。
// 现版那侧是"水色一层 fill ＋ 波光一层 fill-pattern"，这里沿用同一个形状：与水面包同几何的覆盖网格、
// 不受光的半透明材质，像素仍然出自同一份 `waterTexture`（Node 那侧逐字节比过）。要钉的四件事全部是量出来的：
// ① 名单同源；② 屏幕上正好 64 个 CSS 像素一圈、不随缩放胀大；③ 这一圈跟着镜头转；
// ④ 平移时格子跟着江面走（这一格是最先做错的：那一版整张格子钉在视口上，现版那侧不是，见 `river.js` 顶上那段）。
// 跨引擎不对像素：这一层的四件事全是"这一侧自己量出来的"（屏幕 64 CSS 像素一圈、跟着镜头转、平移时跟着江面走），
// 两边同帧对像素那条路已经由 #191 收口，归 padding 那条判据管（见本文件"同一串 hash 框出同一张画面"那项）。
test('the new engine lays the river sheen on the same water with a screen-sized tile that rides the ground', async ({ page }) => {
  test.setTimeout(540000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
  const CLIP = { x: 0, y: 0, width: 1440, height: 960 };
  await openEngine(page, 'three');
  await page.evaluate(async () => {
    const { neighborhood: n } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    window.__probe = { n };
    // 动效必须按住：车、人、船与波光自己那一拍都在走，两帧的差里混着它们，这一层的像素账就不干净。
    n.setMotion(false);
    window.__mesh = () => {
      let mesh = null;
      n.scene.traverse((object) => { if (object.name === 'river-sheen-water') mesh = object; });
      return mesh;
    };
    // 运算全留在页面里：一帧 1440×960 的亮度数组不打算搬过 CDP。
    window.__lum = async (b64) => {
      const bitmap = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob());
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width; canvas.height = bitmap.height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(bitmap, 0, 0);
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
      const lum = new Float32Array(bitmap.width * bitmap.height);
      for (let i = 0; i < lum.length; i++) lum[i] = 0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2];
      return { lum, width: bitmap.width, height: bitmap.height };
    };
    window.__diff = async (a, b) => {
      const x = await window.__lum(a), y = await window.__lum(b);
      let sum = 0, changed = 0, worst = 0;
      for (let i = 0; i < x.lum.length; i++) {
        const d = Math.abs(x.lum[i] - y.lum[i]);
        sum += d;
        if (d > worst) worst = d;
        if (d > 1) changed++;
      }
      return { changed, mean: Math.round(sum / x.lum.length * 100) / 100, worst: Math.round(worst), pixels: x.lum.length };
    };
    // "开减关"的差值图就是这一层单独画了什么；掩膜取 |差值|>2，楼体、绿地与网格边那些抗锯齿像素不进这个账。
    window.__field = async (a, b) => {
      const x = await window.__lum(a), y = await window.__lum(b);
      const d = new Float32Array(x.lum.length);
      const m = new Uint8Array(x.lum.length);
      let changed = 0;
      for (let i = 0; i < x.lum.length; i++) {
        d[i] = x.lum[i] - y.lum[i];
        if (Math.abs(d[i]) > 2) { m[i] = 1; changed++; }
      }
      return { d, m, changed, width: x.width, height: x.height };
    };
    // 自比（同一张差值图挪 dx,dy）：钉"屏幕上正好 64 像素一圈"与"这一圈跟着镜头转"。
    window.__periodic = async (a, b, offsets) => {
      const { d, m, width, height } = await window.__field(a, b);
      const out = {};
      for (const [dx, dy] of offsets) {
        let num = 0, den = 0, pairs = 0;
        for (let row = Math.max(0, -dy); row + dy < height; row++) {
          for (let col = Math.max(0, -dx); col + dx < width; col++) {
            const i = row * width + col, j = (row + dy) * width + (col + dx);
            if (!m[i] || !m[j]) continue;
            num += d[i] * d[j]; den += d[i] * d[i]; pairs++;
          }
        }
        out[`${dx},${dy}`] = [Math.round(num / (den || 1) * 100) / 100, pairs];
      }
      return out;
    };
    // 互比（两张差值图挪 dx,dy）：平移锚定那一格用。幅度会随镜头漂（雾、入射角），所以用归一化相关而不是逐像素差。
    window.__align = async (first, second, offsets) => {
      const A = await window.__field(first.a, first.b);
      const B = await window.__field(second.a, second.b);
      const rows = [];
      for (const [dx, dy] of offsets) {
        let num = 0, denA = 0, denB = 0, pairs = 0;
        for (let row = Math.max(0, -dy); row + dy < A.height; row++) {
          for (let col = Math.max(0, -dx); col + dx < A.width; col++) {
            const i = row * A.width + col, j = (row + dy) * A.width + (col + dx);
            if (!A.m[i] || !B.m[j]) continue;
            num += A.d[i] * B.d[j]; denA += A.d[i] * A.d[i]; denB += B.d[j] * B.d[j]; pairs++;
          }
        }
        rows.push([[dx, dy], Math.round(num / (Math.sqrt(denA * denB) || 1) * 100) / 100, pairs]);
      }
      return rows;
    };
  });
  const read = () => page.evaluate(() => {
    const counts = window.__probe.n.counts();
    return { river: counts.river, drawCalls: counts.drawCalls, triangles: counts.triangles,
      panel: document.querySelector('.engine-stats').textContent };
  });
  const setView = async (patch) => {
    await page.evaluate((patch) => window.__probe.n.setView({ ...window.__probe.n.view(), ...patch }), patch);
    await page.waitForTimeout(700);
  };
  // 这一层的开关：藏网格＝关掉这一层。两张都把手上的偏移钉回第 0 行，差值图里剩下的就只有"这一层画了什么"。
  const setSheen = (visible) => page.evaluate((visible) => {
    const mesh = window.__mesh();
    mesh.visible = visible;
    mesh.material.userData.shader.uniforms.riverScroll.value = 0;
  }, visible);
  const pair = async () => {
    await page.evaluate(() => { document.querySelector('.engine-stats').style.visibility = 'hidden'; });
    await setSheen(true);
    await page.waitForTimeout(600);
    const a = (await page.screenshot({ clip: CLIP })).toString('base64');
    const on = await read();
    await setSheen(false);
    await page.waitForTimeout(600);
    const b = (await page.screenshot({ clip: CLIP })).toString('base64');
    const off = await read();
    await setSheen(true);
    await page.evaluate(() => { document.querySelector('.engine-stats').style.visibility = ''; });
    return { a, b, on, off };
  };

  // ① 名单与读数：这一层坐在与水面同一批面上，片元编译过了，镜头把格子、画布与地面相位都交了进来。
  await setView({ zoom: 15.5, pitch: 58, bearing: -25, center: { lat: 23.1105, lng: 113.3205 } });
  const ledger = await read();
  expect([ledger.river.faces, ledger.river.plates, ledger.river.failed.length, ledger.river.tile, ledger.river.vertices],
    `波光这一层的读数不对：${JSON.stringify(ledger.river)}`).toEqual([41, 41, 0, 64, 8397]);
  expect(ledger.river.built, '波光的片元没编译，那一层画不出格子').toBe(true);
  expect([ledger.river.scale, ledger.river.center], `画布与设备倍率没交给这一层：${JSON.stringify(ledger.river.center)}`)
    .toEqual([1, [720, 480]]);
  expect(ledger.river.offset.every((value) => value >= 0 && value < 64),
    `地面相位没按整格取余：${JSON.stringify(ledger.river.offset)}`).toBe(true);
  expect(ledger.panel, `面板没把这一层报出来：${ledger.panel}`).toContain('波光 1 层');
  // 名单同源：面板报的"水 41"与这一层的 faces 必须是同一个数，否则一边有河、一边有晕。
  expect(Number((ledger.panel.match(/水 (\d+)/) ?? [])[1]),
    `面板的水面名单与这一层不是一批：${ledger.panel}`).toBe(ledger.river.faces);

  // ② 发数与画面量级：关掉这一层正好少一发、少 2,799 个三角形（8,397 个顶点 / 3）。
  // 白昼那一份逐像素平均只有 0.12 个灰阶（贴图半透明、底色又接近水色），所以判据读"变了多少像素"，不读均值。
  const day = await pair();
  expect([day.on.drawCalls - day.off.drawCalls, day.on.triangles - day.off.triangles],
    `关掉这一层应当正好少一发与它自己那批三角形：${JSON.stringify([day.on, day.off])}`).toEqual([1, 2799]);
  const painted = await page.evaluate(async ({ a, b }) => window.__diff(a, b), day);
  expect(painted.changed, `这一层只画了 ${painted.changed} 个像素，白昼的波光没上去`).toBeGreaterThanOrEqual(20000);
  expect(painted.worst, `最亮那道波光只差 ${painted.worst} 个灰阶`).toBeGreaterThanOrEqual(12);

  // ③ 屏幕上正好 64 个 CSS 像素一圈：把差值图挪一整格自比，竖直与水平都该落回同一批纹素。
  // 米制那一种假说在 17 级上一格占 256 像素，这里就会掉到 0；倍率那一格由 Node 的 `riverScale` 判据钉住。
  // 氛围给夜景：这一层在深色江面上振幅最大（白昼那份最亮才 23 个灰阶，掩膜太薄）。
  await page.evaluate(() => document.querySelector('[data-atmosphere-option="night"]').click());
  await page.waitForTimeout(1000);
  const nightAt = { zoom: 15.5, bearing: 0 };
  const nights = {};
  for (const zoom of [15.5, 17, 18]) {
    await setView({ zoom, pitch: 58, bearing: 0 });
    const shot = await pair();
    const lattice = await page.evaluate(async ({ a, b, offsets }) => window.__periodic(a, b, offsets),
      { a: shot.a, b: shot.b, offsets: [[0, 64], [64, 0]] });
    if (zoom === 15.5) nights.reference = shot;
    nights[`z${zoom}`] = lattice;
    expect(lattice['0,64'][0], `${zoom} 级上竖直挪一整格的相关只有 ${lattice['0,64'][0]}，这一格随缩放胀大了`)
      .toBeGreaterThanOrEqual(0.9);
    expect(lattice['0,64'][1], `${zoom} 级上竖直那一格只有 ${lattice['0,64'][1]} 对像素，这条判据在量噪声`)
      .toBeGreaterThanOrEqual(3000);
    expect(lattice['64,0'][0], `${zoom} 级上水平挪一整格的相关只有 ${lattice['64,0'][0]}`).toBeGreaterThanOrEqual(0.9);
    expect(lattice['64,0'][1], `${zoom} 级上水平那一格只有 ${lattice['64,0'][1]} 对像素`).toBeGreaterThanOrEqual(3000);
  }

  // ④ 这一圈跟着镜头转：读数是 -转角·π/180，画面上要转过的整格才对得上，轴对齐那一格反而对不上。
  for (const bearing of [0, -25, -40]) {
    await setView({ zoom: 15.5, pitch: 58, bearing });
    const shot = await pair();
    const rad = (bearing * Math.PI) / 180;
    const turned = [Math.round(64 * Math.sin(rad)), Math.round(64 * Math.cos(rad))];
    expect(shot.on.river.rotate, `${bearing}° 上报出的转角是 ${shot.on.river.rotate}`).toBeCloseTo(-(bearing * Math.PI) / 180, 3);
    const uniform = await page.evaluate(() => window.__mesh().material.userData.shader.uniforms.riverRotate.value);
    expect(uniform, `${bearing}° 上写进材质的转角是 ${uniform}`).toBeCloseTo(-(bearing * Math.PI) / 180, 3);
    const lattice = await page.evaluate(async ({ a, b, offsets }) => window.__periodic(a, b, offsets),
      { a: shot.a, b: shot.b, offsets: [[0, 64], turned] });
    const key = `${turned[0]},${turned[1]}`;
    expect(lattice[key][0], `${bearing}° 上转过的整格 ${key} 相关只有 ${lattice[key][0]}，格子没跟着镜头转`)
      .toBeGreaterThanOrEqual(0.9);
    expect(lattice[key][1], `${bearing}° 上转过的整格只有 ${lattice[key][1]} 对像素`).toBeGreaterThanOrEqual(3000);
    if (Math.abs(bearing) >= 20) {
      expect(lattice['0,64'][0], `${bearing}° 上轴对齐那一格还有 ${lattice['0,64'][0]}，说明转角没进画面`)
        .toBeLessThan(0.9);
    }
  }

  // ⑤ 滚动的环：一拍一个屏幕像素、走完一整圈回到出厂那一行；停动效回到第 0 行并且画面逐像素不再变。
  // 采样一拍一次从 Node 这侧发：整段循环放进页面里跑 8 秒，实测会把那个 execution context 弄丢。
  await setView(nightAt);
  await page.evaluate(() => window.__probe.n.setMotion(true));
  const phases = [];
  for (let step = 0; step < 12; step++) {
    await page.waitForTimeout(700);
    phases.push(await page.evaluate(() => {
      const status = window.__probe.n.motionStatus();
      return [status.phase, status.steps, window.__probe.n.counts().river.scroll];
    }));
  }
  const ring = [];
  for (let i = 1; i < phases.length; i++) {
    const delta = phases[i][0] - phases[i - 1][0];
    ring.push(delta >= 0 ? delta : delta + 64);
  }
  expect(ring.every((delta) => delta >= 3 && delta <= 9), `每 700 ms 推进的像素数不在 3~9 之间：${JSON.stringify(ring)}`)
    .toBe(true);
  expect(phases.every(([phase, , scroll]) => phase === scroll && phase >= 0 && phase < 64),
    `面板的相位与这一层的相位不是同一个数，或者绕不出那一圈：${JSON.stringify(phases)}`).toBe(true);
  expect(phases.some(([, , scroll], i) => i > 0 && scroll < phases[i - 1][2]),
    `十二次采样没绕回过一次出厂那一行：${JSON.stringify(phases.map(([, , scroll]) => scroll))}`).toBe(true);
  expect(phases[11][1] > phases[0][1], `拍数计数器没走：${JSON.stringify(phases)}`).toBe(true);
  const settled = await page.evaluate(async () => {
    const n = window.__probe.n;
    n.setMotion(false);
    await new Promise((resolve) => setTimeout(resolve, 400));
    return { phase: n.motionStatus().phase, scroll: n.counts().river.scroll };
  });
  expect([settled.phase, settled.scroll], `停动效之后没回到出厂那一行：${JSON.stringify(settled)}`).toEqual([0, 0]);
  // 面板那几行数字每一帧都在变（FPS），藏掉之后再比这两帧，剩下的才是场景自己动不动。
  await page.evaluate(() => { document.querySelector('.engine-stats').style.visibility = 'hidden'; });
  const still1 = (await page.screenshot({ clip: CLIP })).toString('base64');
  await page.waitForTimeout(1500);
  const still2 = (await page.screenshot({ clip: CLIP })).toString('base64');
  await page.evaluate(() => { document.querySelector('.engine-stats').style.visibility = ''; });
  const still = await page.evaluate(async ({ a, b }) => window.__diff(a, b), { a: still1, b: still2 });
  expect(still.changed, `停住之后画面还在动（${still.changed} 个像素变了）`).toBe(0);

  // ⑥ 换氛围＝换一张真不一样的图，并把格子放回出厂那一行。
  const switched = await page.evaluate(async () => {
    const n = window.__probe.n;
    n.setMotion(true);
    await new Promise((resolve) => setTimeout(resolve, 900));
    const before = n.counts().river;
    document.querySelector('[data-atmosphere-option="sunset"]').click();
    await new Promise((resolve) => setTimeout(resolve, 120));
    const after = n.counts().river;
    n.setMotion(false);
    return { before: { scroll: before.scroll }, after: { atmosphere: after.atmosphere, scroll: after.scroll } };
  });
  expect(switched.before.scroll, `换氛围之前相位就是 0，这条判据没东西可复位：${JSON.stringify(switched)}`)
    .toBeGreaterThan(2);
  // 等待那一百二十毫秒里时钟还会走一拍，所以这里钉的是"回到出厂附近"，不是字面的 0：
  // 注入办法是把 `setAtmosphere` 里那句 `state.scroll = 0` 拿掉，档位换了但相位停在 7 以上，当场报红。
  expect(switched.after.atmosphere, `氛围没切过去：${JSON.stringify(switched)}`).toBe('sunset');
  expect(switched.after.scroll, `换了氛围还留着上一档的偏移：${JSON.stringify(switched)}`)
    .toBeLessThan(switched.before.scroll);
  await setView({ zoom: 15.5, pitch: 58, bearing: 0 });
  const sunset = await pair();
  const sunsetLattice = await page.evaluate(async ({ a, b, offsets }) => window.__periodic(a, b, offsets),
    { a: sunset.a, b: sunset.b, offsets: [[0, 64]] });
  expect(sunsetLattice['0,64'][0], '日落档的贴图换过来就不周期了').toBeGreaterThanOrEqual(0.9);
  // 三档各一张图：日落与夜景那两张差值图在同一个屏幕位置上必须不是同一份像素。
  const disagree = await page.evaluate(async ({ night, sunset }) => {
    const a = await window.__field(night.a, night.b);
    const b = await window.__field(sunset.a, sunset.b);
    let painted = 0, far = 0;
    for (let i = 0; i < a.d.length; i++) {
      if (!(a.m[i] || b.m[i])) continue;
      painted++;
      if (Math.abs(a.d[i] - b.d[i]) > 2) far++;
    }
    return { painted, far };
  }, { night: nights.reference, sunset });
  expect(disagree.painted, `两档的差值图里几乎没有画到的地方：${JSON.stringify(disagree)}`).toBeGreaterThan(5000);
  expect(disagree.far, `日落与夜景画的是同一张图（只有 ${disagree.far} 个像素不同）`).toBeGreaterThan(3000);

  // ⑦ 透明度读现版那条斜坡。
  await page.evaluate(() => document.querySelector('[data-atmosphere-option="day"]').click());
  await page.waitForTimeout(800);
  const ramp = await page.evaluate(async () => {
    const n = window.__probe.n;
    const rows = [];
    for (const zoom of [10, 12, 13, 14, 15.5, 18.5, 20, 22]) {
      n.setView({ ...n.view(), zoom });
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      rows.push(n.counts().river.opacity);
    }
    return rows;
  });
  expect(ramp, `透明度斜坡与现版那条档表对不上：${JSON.stringify(ramp)}`)
    .toEqual([0.4, 0.4, 0.56, 0.72, 0.72, 0.72, 0.72, 0.72]);

  // ⑧ 平移锚定：镜头挪约 119 个屏幕像素，格子该跟着江面走——挪同样的 119 像素去比要对得上，原地比要对不上。
  // 钉在视口的那一版正好反过来（原地比 1.0、挪平移量比 0.6）。现版那侧同一次测量是 0.94 对 0.81，
  // 也就是两边都"跟着地面走"（`scripts/probe-river-pan.mjs`）；这里只在自己引擎里比，不跨引擎对像素。
  await page.evaluate(() => document.querySelector('[data-atmosphere-option="night"]').click());
  await page.waitForTimeout(900);
  await setView({ zoom: 16, pitch: 0, bearing: 0, center: { lat: 23.1105, lng: 113.3205 } });
  const anchor = await pair();
  const home = await page.evaluate(() => {
    const n = window.__probe.n;
    const centre = n.view().center;
    const point = n.screen(centre);
    return { centre, pixel: [Math.round(point.x), Math.round(point.y)] };
  });
  let target = { ...home.centre };
  for (let attempt = 0; attempt < 6; attempt++) {
    await page.evaluate(async (c) => {
      const n = window.__probe.n;
      n.setView({ ...n.view(), center: c });
      await new Promise((resolve) => setTimeout(resolve, 400));
    }, target);
    const now = await page.evaluate((home) => {
      const here = window.__probe.n.screen(home.centre);
      return [Math.round(here.x) - home.pixel[0], Math.round(here.y) - home.pixel[1]];
    }, home);
    if (Math.abs(now[0] - 119) <= 2 && Math.abs(now[1] - 119) <= 2) break;
    target = { lat: target.lat + (119 - now[1]) / 110540,
      lng: target.lng - (119 - now[0]) / (111320 * Math.cos(target.lat * Math.PI / 180)) };
  }
  const moved = await page.evaluate((home) => {
    const here = window.__probe.n.screen(home.centre);
    return [Math.round(here.x) - home.pixel[0], Math.round(here.y) - home.pixel[1]];
  }, home);
  // 对准要钉在 2 像素以内：这张格子的周期只有 64 像素，平移量差 8 像素对齐度就从 0.93 掉到 0.72（`scripts/probe-river-pan.mjs`）。
  expect(Math.abs(moved[0] - 119) <= 2 && Math.abs(moved[1] - 119) <= 2,
    `这次平移没对准 119 个屏幕像素：${JSON.stringify(moved)}`).toBe(true);
  const panned = await pair();
  expect(panned.on.river.offset, `平移之后地面相位没动：${JSON.stringify([anchor.on.river.offset, panned.on.river.offset])}`)
    .not.toEqual(anchor.on.river.offset);
  const aligned = await page.evaluate(async ({ anchor, panned, moved }) => window.__align(anchor, panned,
    [[0, 0], moved, [moved[0] + 32, moved[1] + 32]]), { anchor, panned, moved });
  console.log('⑧ 对齐面：', JSON.stringify(aligned));
  const [atZero, atPan, atHalf] = aligned;
  expect(atPan[2], `平移对齐只有 ${atPan[2]} 对像素，这条判据在量噪声：${JSON.stringify(aligned)}`).toBeGreaterThanOrEqual(3000);
  expect(atHalf[2], `错开半格只有 ${atHalf[2]} 对像素，这个对照量的是噪声：${JSON.stringify(aligned)}`).toBeGreaterThanOrEqual(3000);
  expect(atPan[1], `格子没跟着江面走：挪 ${JSON.stringify(moved)} 像素去比对齐度只有 ${atPan[1]}（同屏比 ${atZero[1]}）`)
    .toBeGreaterThanOrEqual(0.85);
  expect(atPan[1], `同屏位置比反而更对齐（${atZero[1]} 对 ${atPan[1]}），格子又钉回视口了`)
    .toBeGreaterThan(atZero[1] + 0.05);
  // 对照为什么不取"反着挪"：那一次两边只剩 17 对像素（实测），相干度 0.9 是 17 个点凑出来的，不能当对照。
  // 取"沿同一个方向再多错半格"这一头：像素对有上万个，峰如果真是格子周期给的，这里就该掉下来。
  expect(atPan[1], `错开半格也对齐到 ${atHalf[1]}，这个峰不是格子的周期带来的`)
    .toBeGreaterThan(atHalf[1] + 0.05);

  expect(errors, `江面波光这一层跑出了页面错误：${JSON.stringify(errors)}`).toEqual([]);
});


// 项 5 剩下的最后一格（#190，随 #170 一起收口）：地标那一整批资产进新引擎。
// 现版那侧它们站在**另一套 `THREE.Scene`** 里借 MapLibre 的画布补画（`src/tower.js:507`），几何与材质全是纯工厂，
// 所以搬进来的不是像素也不是算法，只有"谁把镜头交给它们"这一格——米制原点两边是同一个（`createProjection`
// 复用的就是 `geo.plane`），网格因此一字未改。要钉的七件事全部是量出来的：
// ① 名单同源、三栋盒子让位、面板报片数；② 摘掉这一层的自差（发数／三角形／像素，包围盒要落在塔那一片）；
// ③ 夜景闸门：光柱与三条落水带只跟着夜景权重出画，白昼一颗不发；④ 夜里再摘一次，多出来的那 8 发就是它们；
// ⑤ 色相那一格真的进了材质，停动效逐字交回出厂那一帧；⑥ 这一层的雾化在它自己手里（每张材质 `fog === false`，
//    引擎的 `scene.fog` 再打一遍就是双重雾化）；⑦ 墙色跟着镜头走那条距离斜坡。
test('the new engine stands the three landmark shells with their beam and spill bands', async ({ page }) => {
  test.setTimeout(420000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
  const { FORM_OSM_IDS } = await import('../src/landmark-forms.js');
  const CLIP = { x: 0, y: 0, width: 1440, height: 960 };
  const BANDS = ['river-glow', '184738716:spill', '511404889:spill'];
  await openEngine(page, 'three');
  await page.evaluate(async (bands) => {
    const { neighborhood: n } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    window.__probe = { n };
    // 动效必须按住：色相、皇冠呼吸、车流与换窗都在走，两帧的差里混着它们，这一层的账就不干净。
    n.setMotion(false);
    window.__node = (name) => {
      let found = null;
      n.scene.traverse((object) => { if (object.name === name) found = object; });
      return found;
    };
    window.__layer = (visible) => { window.__node('landmarks').visible = visible; };
    // 这一层每张材质的当前颜色：色相那一格、两顶皇冠的呼吸、墙那条斜坡，最后都落到这一串字符串上。
    window.__paint = (name) => {
      const seen = new Set();
      const rows = [];
      for (const object of (window.__node(name) ? [window.__node(name)] : [])) {
        object.traverse((node) => {
          for (const material of [].concat(node.material ?? [])) {
            if (!material || seen.has(material)) continue;
            seen.add(material);
            rows.push([material.name ?? '', material.color ? material.color.getHexString() : '',
              material.emissive ? material.emissive.getHexString() : '',
              +(material.emissiveIntensity ?? 1).toFixed(4)].join('|'));
          }
        });
      }
      return rows.sort();
    };
    window.__state = () => {
      const rows = bands.map((name) => {
        const mesh = window.__node(name);
        return [mesh.visible, Math.round(mesh.material.opacity * 100) / 100];
      });
      return { bands: rows, beam: window.__node('beam').visible };
    };
    window.__lum = async (b64) => {
      const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width; canvas.height = bitmap.height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(bitmap, 0, 0);
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
      const lum = new Float32Array(bitmap.width * bitmap.height);
      for (let i = 0; i < lum.length; i++) lum[i] = 0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2];
      return { lum, width: bitmap.width };
    };
    window.__diff = async (a, b) => {
      const x = await window.__lum(a), y = await window.__lum(b);
      let changed = 0, sum = 0, worst = 0, box = null;
      for (let i = 0; i < x.lum.length; i++) {
        const d = Math.abs(x.lum[i] - y.lum[i]);
        sum += d;
        if (d > worst) worst = d;
        if (d > 2) {
          changed += 1;
          const row = Math.floor(i / x.width), col = i % x.width;
          box = box ? { x0: Math.min(box.x0, col), x1: Math.max(box.x1, col), y0: Math.min(box.y0, row), y1: Math.max(box.y1, row) }
            : { x0: col, x1: col, y0: row, y1: row };
        }
      }
      return { changed, mean: +(sum / x.lum.length).toFixed(2), worst: Math.round(worst), box };
    };
  }, BANDS);
  const read = () => page.evaluate(() => {
    const counts = window.__probe.n.counts();
    return { landmarks: counts.landmarks, drawCalls: counts.drawCalls, triangles: counts.triangles,
      buildings: counts.buildings, panel: document.querySelector('.engine-stats').textContent };
  });
  const pair = async () => {
    await page.evaluate(() => { document.querySelector('.engine-stats').style.visibility = 'hidden'; });
    await page.evaluate(() => window.__layer(true));
    await page.waitForTimeout(900);
    const on = (await page.screenshot({ clip: CLIP })).toString('base64');
    const onCounts = await read();
    await page.evaluate(() => window.__layer(false));
    await page.waitForTimeout(900);
    const off = (await page.screenshot({ clip: CLIP })).toString('base64');
    const offCounts = await read();
    await page.evaluate(() => {
      window.__layer(true);
      document.querySelector('.engine-stats').style.visibility = '';
    });
    return { on, off, onCounts, offCounts };
  };

  // ① 名单同源：壳体就是 `LANDMARK_FORMS` 那四张身份，一条不多一条不少；三栋有盒子的塔必须让位。
  const opened = await read();
  expect(opened.landmarks.ids, `壳体名单与 FORM_OSM_IDS 不同源：${JSON.stringify(opened.landmarks.ids)}`)
    .toEqual([...FORM_OSM_IDS]);
  expect([opened.landmarks.shells, opened.landmarks.bands, opened.landmarks.beam, opened.landmarks.night,
    opened.landmarks.hue, opened.landmarks.visible],
    `白昼开屏这一层的账不对：${JSON.stringify(opened.landmarks)}`)
    .toEqual([4, BANDS, false, 0, 0, true]);
  expect(opened.landmarks.vertices, `这一层只有 ${opened.landmarks.vertices} 颗顶点：几何没搬全`)
    .toBe(100552);
  expect(opened.buildings, `壳体底下的盒子没让位（一栋塔两套皮）：楼块还是 ${opened.buildings} 栋`).toBe(3987);
  expect(opened.panel, `面板没把壳体报出来：${opened.panel}`).toContain('壳体 4 片');

  // ② 摘掉这一层的自差：正好少 30 发与 121,803 个三角形，画面差 22,724 颗像素，而且那一片就是塔与壳站的地方。
  const day = await pair();
  expect([day.onCounts.drawCalls - day.offCounts.drawCalls, day.onCounts.triangles - day.offCounts.triangles],
    `白昼摘掉这一层应当正好少它自己那批发数与三角形：${JSON.stringify([day.onCounts, day.offCounts])}`)
    .toEqual([30, 121803]);
  const dayPaint = await page.evaluate(async ({ on, off }) => window.__diff(on, off), day);
  expect(dayPaint.changed, `这一层白昼只画了 ${dayPaint.changed} 颗像素：壳体没上屏`).toBeGreaterThanOrEqual(20000);
  expect(dayPaint.worst, `这一层最亮那道边只差 ${dayPaint.worst} 个灰阶`).toBeGreaterThanOrEqual(100);
  // 包围盒要装得下塔冠那一点（600 m 的塔在 15.5 级上顶到画面顶上），又不许铺满全幅——
  // 铺满就是这一层在改整幅的底色，不是在立四栋地标。
  const crown = await page.evaluate(() => {
    const point = window.__probe.n.screen({ lng: 113.31913, lat: 23.109, altitude: 460 });
    return [Math.round(point.x), Math.round(point.y)];
  });
  const box = dayPaint.box;
  expect(crown[0] >= box.x0 && crown[0] <= box.x1 && crown[1] >= box.y0 && crown[1] <= box.y1,
    `塔冠那一点 ${JSON.stringify(crown)} 不在这一层画到的范围 ${JSON.stringify(box)} 里：塔没立在它自己的位置上`).toBe(true);
  expect((box.x1 - box.x0) * (box.y1 - box.y0),
    `这一层画到的范围占了 ${(((box.x1 - box.x0) * (box.y1 - box.y0)) / (1440 * 960) * 100).toFixed(0)}% 的画幅：不像四栋楼`)
    .toBeLessThan(1440 * 960 * 0.45);

  // ③ 夜景闸门：光柱与三条落水带只跟着夜景权重出画。白昼那三颗是"有 mesh、不发光"，不是"没造出来"。
  expect(await page.evaluate(() => window.__state()),
    '白昼的光柱或落水带亮着').toEqual({ bands: [[false, 0], [false, 0], [false, 0]], beam: false });
  await page.locator('[data-atmosphere-option="night"]').click();
  await page.waitForTimeout(3000);
  expect(await page.evaluate(() => window.__state()),
    '夜景没给满档：光柱与三条落水带该各自报自己的透明度')
    .toEqual({ bands: [[true, 0.55], [true, 0.24], [true, 0.24]], beam: true });
  expect((await read()).landmarks.night, '这一层自己报的夜景权重不是满档').toBe(1);

  // ④ 夜里再摘一次：多出来的那 8 发与 172 个三角形就是光柱与三条带（白昼它们一发不发）。
  const night = await pair();
  expect([night.onCounts.drawCalls - night.offCounts.drawCalls, night.onCounts.triangles - night.offCounts.triangles],
    `夜景摘掉这一层的差与白昼对不上，光柱与落水带就没进账：${JSON.stringify([night.onCounts, night.offCounts])}`)
    .toEqual([38, 121975]);
  const nightPaint = await page.evaluate(async ({ on, off }) => window.__diff(on, off), night);
  expect(nightPaint.changed, `夜景这一层只画了 ${nightPaint.changed} 颗像素：灯没上去`).toBeGreaterThanOrEqual(20000);

  // ⑤ 色相那一格真的进了材质（默认档 `single`：整根 shaft 一个色相、40 秒一圈），停动效逐字交回出厂那一帧。
  // 走色相那一格只读塔身自己那批材质：整层的颜色串里还混着两顶皇冠的呼吸，把 `advance` 里的 `paintTower()` 删掉
  // 时皇冠照样在变，整层比就抓不到（第一版就是这么漏的一条注入）。
  const still = await page.evaluate(() => window.__paint('tower-model'));
  const stillAll = await page.evaluate(() => window.__paint('landmarks'));
  await page.evaluate(() => window.__probe.n.setMotion(true));
  await page.waitForTimeout(3500);
  const walked = await page.evaluate(() => ({ paint: window.__paint('tower-model'), hue: window.__probe.n.counts().landmarks.hue }));
  await page.evaluate(() => window.__probe.n.setMotion(false));
  await page.waitForTimeout(900);
  const stopped = await page.evaluate(() => ({ paint: window.__paint('landmarks'), hue: window.__probe.n.counts().landmarks.hue }));
  expect(walked.hue, `3.5 秒只走到 ${walked.hue}：40 秒一圈那条环没在走`).toBeGreaterThan(0.05);
  expect(walked.hue, `3.5 秒走到 ${walked.hue}，比一圈的十分之一还多`).toBeLessThan(0.15);
  expect(walked.paint.join('\n'), '色相走到了读数里却没进塔身的材质：这一格只是个数').not.toEqual(still.join('\n'));
  expect(stopped.paint.join('\n'), '停动效没交回出厂那一帧：这一层的材质与开屏那一份不一样').toEqual(stillAll.join('\n'));
  expect(stopped.hue, '停动效之后色相没归零').toBe(0);

  // ⑥ 这一层的雾化在它自己手里：引擎的 `scene.fog` 再打一遍就是双重雾化（现版那座场景里本来就没有雾）。
  const fogged = await page.evaluate(() => {
    const seen = new Set();
    const bad = [];
    window.__node('landmarks').traverse((object) => {
      for (const material of [].concat(object.material ?? [])) {
        if (!material || seen.has(material)) continue;
        seen.add(material);
        if (material.fog !== false) bad.push(material.name || object.name);
      }
    });
    return { count: seen.size, bad, sceneFog: Boolean(window.__probe.n.scene.fog) };
  });
  expect(fogged.sceneFog, '引擎这一侧没有雾，这一格量不到东西').toBe(true);
  expect(fogged.bad, `这些材质还在吃引擎的雾：${JSON.stringify(fogged.bad)}`).toEqual([]);
  expect(fogged.count, `这一层数出 ${fogged.count} 张材质，与它自己报的数对不上`).toBe((await read()).landmarks.materials);

  // ⑦ 墙色跟着镜头走那条距离斜坡：同一档两次读数逐字相同，跨两档必须变（`landmarks?.update(view.zoom)` 那一行）。
  await page.locator('[data-atmosphere-option="day"]').click();
  await page.waitForTimeout(2500);
  const shells = async (zoom) => {
    await page.evaluate((value) => window.__probe.n.setView({ ...window.__probe.n.view(), zoom: value }), zoom);
    await page.waitForTimeout(900);
    return page.evaluate(() => window.__paint('landmark-forms').join('\n'));
  };
  const near = await shells(15.5);
  const far = await shells(13);
  expect(far, '镜头拉低两档半，壳体的墙色一格没变：那条距离斜坡没跟着镜头走').not.toEqual(near);
  expect(await shells(15.5), '回到同一档，墙色没交回原来那一份：斜坡是个随机量').toEqual(near);

  expect(errors, `地标这一层跑出了页面错误：${JSON.stringify(errors)}`).toEqual([]);
});

test('the new engine lays the plaza’s measured faces under its metric joints and reads them differently at each stage', async ({ page }) => {
  test.setTimeout(260000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
  await openEngine(page, 'three');
  const setup = await page.evaluate(async () => {
    const { neighborhood: n } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    window.__probe = { n };
    // 动效必须按住：广场内外都站着会动的东西，两帧的差里混着它们，这一层的账就不干净。
    n.setMotion(false);
    const { carvePlaza } = await import('/src/plaza.js');
    const { PLAZA_LAYERS } = await import('/src/engine/plaza.js');
    const read = async (file) => (await (await fetch(`/data/${file}.geojson`)).json()).features;
    const [water, greens, blocks, streets] = await Promise.all(
      ['canton-water', 'canton-greens', 'canton-blocks', 'canton-streets'].map(read));
    const plaza = carvePlaza({ greens, water, blocks, streets });
    // 取样点不手摆：取最大那块硬质面的环心，与贴图里那一格石材是同一块 OSM 面。
    const stone = plaza.features.filter((feature) => feature.properties.kind === 'stone')
      .sort((a, b) => (b.properties.area ?? 0) - (a.properties.area ?? 0))[0];
    const ring = stone.geometry.coordinates[0];
    const centre = [ring.reduce((sum, point) => sum + point[0], 0) / ring.length,
      ring.reduce((sum, point) => sum + point[1], 0) / ring.length];
    await n.setView({ zoom: 17, pitch: 0, bearing: 0, center: { lng: centre[0], lat: centre[1] } });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    document.querySelectorAll('.landmark').forEach((node) => { node.style.visibility = 'hidden'; });
    document.querySelector('.engine-stats').style.visibility = 'hidden';
    const named = (name) => { let found = null; n.scene.traverse((object) => { if (object.name === name) found = object; }); return found; };
    window.__plaza = { group: named('plaza-ground'), decal: named('canton-plaza-surface') };
    const spot = n.screen({ lng: centre[0], lat: centre[1], altitude: PLAZA_LAYERS.stone });
    return { area: stone.properties.area, spot, layers: { ...PLAZA_LAYERS },
      counts: n.counts().plaza, hasGroup: Boolean(window.__plaza.group), hasDecal: Boolean(window.__plaza.decal) };
  });
  expect(setup.hasGroup, '引擎的场景里没有 `plaza-ground` 那一组').toBe(true);
  expect(setup.hasDecal, '引擎的场景里没有那张乘性网格').toBe(true);
  expect(setup.spot.onScreen, `广场那块硬质面的中心没在画面里：${JSON.stringify(setup.spot)}`).toBe(true);
  expect(setup.counts.classes, `四类面的账与出厂快照对不上：${JSON.stringify(setup.counts.classes)}`)
    .toEqual({ lawn: 20, pool: 1, stone: 4, walk: 17, missing: false });
  expect(setup.counts.surface, `镜头已经在 17 级，读数却说那张网格没在画：${JSON.stringify(setup.counts)}`).toBe(true);
  // 取样点是快照里那块最大的硬质面（way/1332423226，2,390 m²），不是手挑的一个像素。
  expect(setup.area, `取样那块面的面积不再是 2,390 m²：${setup.area}`).toBe(2390);

  const clip = { x: Math.round(setup.spot.x) - 30, y: Math.round(setup.spot.y) - 30, width: 60, height: 60 };
  const show = (part, visible) => page.evaluate(({ part, visible }) => { window.__plaza[part].visible = visible; }, { part, visible });
  // 摘掉那张网格不能翻 `visible`：每帧那句 `plaza.setZoom(view.zoom)` 会当场把它翻回来。
  // 把它搬到 plates 底下（0.31~0.33 那三块板都写着深度），深度测试就把它整块丢掉，等于这一层没画。
  const neutralise = (on) => page.evaluate(({ on, y }) => {
    window.__plaza.decal.visible = true;
    window.__plaza.decal.position.y = on ? y : 0;
  }, { on, y: setup.layers.surface });
  const shot = async () => {
    await page.waitForTimeout(260);
    const source = (await page.screenshot({ clip })).toString('base64');
    return { source, ...(await page.evaluate(async ({ source }) => {
      const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${source}`)).blob());
      const surface = new OffscreenCanvas(image.width, image.height);
      const context = surface.getContext('2d');
      context.drawImage(image, 0, 0);
      const { data } = context.getImageData(0, 0, image.width, image.height);
      const rgb = [0, 0, 0];
      let sum = 0;
      for (let i = 0; i < data.length; i += 4) {
        sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
        for (let channel = 0; channel < 3; channel++) rgb[channel] += data[i + channel];
      }
      const pixels = data.length / 4;
      return { mean: +(sum / pixels).toFixed(2), rgb: rgb.map((value) => Math.round(value / pixels)), pixels };
    }, { source })) };
  };
  // 三发：整组摘掉（引擎原来的画法）、留着三块板但把网格压到板底下（平色面）、两块都在（乘上缝与收边）。
  await show('group', false);
  const bare = await shot();
  await show('group', true);
  await neutralise(false);
  const plates = await shot();
  await neutralise(true);
  const on = await shot();

  // ① 那三块板真的盖住了公园面：同一台镜头、同一个 60×60 的框，只翻这一组的可见度。
  //    摘掉那一格是 `ground-park` 的绿（绿压红），留着那一格是石材（红压蓝）。
  expect(bare.rgb[1] - bare.rgb[0], `摘掉广场那一层之后那一格还是绿的（${bare.rgb.join(',')}）——那三块板没盖住 park 面`).toBeGreaterThan(10);
  expect(plates.rgb[0] - plates.rgb[2], `留着那一层那一格还是绿的（${plates.rgb.join(',')}），石材面没画上`).toBeGreaterThan(10);
  // ② 乘性贴图只会压暗：整张图加进来之后平均亮度必须降、必须有一批像素真的降了、且一个像素都不许变亮。
  expect(on.mean, `贴上那张乘性网格之后平均亮度只降了 ${(plates.mean - on.mean).toFixed(2)}（${plates.mean} → ${on.mean}）`)
    .toBeLessThanOrEqual(plates.mean - 3);
  const pair = await page.evaluate(async ({ a, b }) => {
    const load = async (source) => {
      const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${source}`)).blob());
      const surface = new OffscreenCanvas(image.width, image.height);
      const context = surface.getContext('2d');
      context.drawImage(image, 0, 0);
      return context.getImageData(0, 0, image.width, image.height).data;
    };
    const x = await load(a), y = await load(b);
    const luma = (data, i) => 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    let changed = 0, brighter = 0;
    for (let i = 0; i < x.length; i += 4) {
      const d = luma(y, i) - luma(x, i);
      if (Math.abs(d) > 2) changed += 1;
      if (d > 2) brighter += 1;
    }
    return { changed, brighter };
  }, { a: plates.source, b: on.source });
  expect(pair.changed, `那张网格只动了 ${pair.changed} 个像素（60×60 的框里），等于没画`).toBeGreaterThanOrEqual(400);
  expect(pair.brighter, `乘性贴图把 ${pair.brighter} 个像素画亮了，那张图不再是乘数`).toBe(0);
  // ③ 门控在页面上也认这一帧的镜头：退到 15.5 那一档，读数必须报"没在画"。
  const gate = await page.evaluate(async () => {
    const n = window.__probe.n;
    await n.setView({ ...n.view(), zoom: 15.5 });
    await new Promise((resolve) => setTimeout(resolve, 900));
    const low = n.counts().plaza.surface;
    await n.setView({ ...n.view(), zoom: 17 });
    await new Promise((resolve) => setTimeout(resolve, 900));
    return { low, high: n.counts().plaza.surface };
  });
  expect([gate.low, gate.high], `16.5 那道门在页面上没起作用（15.5 报 ${gate.low}、17 报 ${gate.high}）`).toEqual([false, true]);
  expect(errors, `广场这一层跑出了页面错误：${JSON.stringify(errors)}`).toEqual([]);
});

test('the same hash lands on the same framed picture on both engines, because both read one padding table', async ({ page }) => {
  test.setTimeout(600000);
  // #191 之前这一格差 140×70 CSS 像素：现版把地理中心放在抠掉留白之后那块窗口的正中，新引擎放在画布正中。
  // 两边的读数各自来自自己那个投影器（`map.project` 与 `neighborhood.screen`），不互比像素。
  const POINTS = { center: [113.31913, 23.1095], north: [113.31913, 23.1122], east: [113.3223, 23.1095] };
  const legacy = await page.context().newPage();
  const read = async (target, engine, size) => {
    await target.setViewportSize(size);
    await openEngine(target, engine);
    return target.evaluate(async ({ points, three }) => {
      const { neighborhood: n } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
      const map = three ? null : n.map;
      const box = document.querySelector('#map canvas').getBoundingClientRect();
      const at = ([lng, lat]) => {
        const p = three ? n.screen({ lng, lat, altitude: 0 }) : map.project({ lng, lat });
        return [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10];
      };
      return { canvas: [Math.round(box.width), Math.round(box.height)], padding: map ? map.getPadding() : null,
        points: Object.fromEntries(points.map(([key, value]) => [key, at(value)])) };
    }, { points: Object.entries(POINTS), three: engine === 'three' });
  };
  for (const size of [{ width: 1440, height: 960 }, { width: 390, height: 844 }]) {
    const theirs = await read(legacy, 'maplibre', size);
    const mine = await read(page, 'three', size);
    const shift = { x: (theirs.padding.left - theirs.padding.right) / 2, y: (theirs.padding.top - theirs.padding.bottom) / 2 };
    const off = (sample) => ({ center: sample.points.center.map((value, index) => value - (sample.canvas[index] / 2 + (index ? shift.y : shift.x))) });
    // ① 每一边自己那一侧：地理中心确实偏出了这一档留白该偏的像素（现版侧读 `getPadding()`，新引擎侧读它自己的 `screen()`）。
    const legacyOff = off(theirs).center;
    expect([Math.round(legacyOff[0]), Math.round(legacyOff[1])],
      `${size.width}×${size.height} 上现版那侧的地理中心没落在抠掉留白那块窗口的正中：${JSON.stringify({ ...theirs, shift })}`)
      .toEqual([0, 0]);
    // ② 两边并排：同一个点偏出的像素必须一样——差值就是账上那 140×70，收口之后必须小于 2 px。
    for (const key of Object.keys(POINTS)) {
      const delta = POINTS[key].map((_, index) => Math.abs(mine.points[key][index] - theirs.points[key][index]));
      expect(delta[0], `${size.width}×${size.height} 上 ${key} 那一点横向差 ${delta[0]} px（现版 ${theirs.points[key]}，新引擎 ${mine.points[key]}）`)
        .toBeLessThan(2);
      expect(delta[1], `${size.width}×${size.height} 上 ${key} 那一点纵向差 ${delta[1]} px（现版 ${theirs.points[key]}，新引擎 ${mine.points[key]}）`)
        .toBeLessThan(2);
    }
    console.log(`${size.width}×${size.height} 现版 ${JSON.stringify(theirs.points)} | 新引擎 ${JSON.stringify(mine.points)} | 留白 ${JSON.stringify(theirs.padding)} → 偏出 (${shift.x}, ${shift.y})`);
  }
  await legacy.close();
});

test('the new engine stands the deck’s walkers on the surface it actually drew, and nobody else off the ground', async ({ page }) => {
  test.setTimeout(200000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
  const { DECK_TOP_METRES } = await import('../src/landmark-forms.js');
  await openEngine(page, 'three');
  const read = await page.evaluate(async () => {
    const { neighborhood: n } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    const node = (name) => { let found = null; n.scene.traverse((object) => { if (object.name === name) found = object; }); return found; };
    // 两份读数各自来自这一侧：桥面顶面取壳体几何的真 bbox，站着的人取实例矩阵的第 13 个分量——都不碰 THREE 的全局。
    const deck = node('1313608038');
    if (!deck) return { missing: '壳体里没有海心桥' };
    deck.geometry.computeBoundingBox();
    const world = deck.matrixWorld.elements;
    const at = (name) => {
      const mesh = node(name);
      const array = mesh.instanceMatrix.array;
      const heights = new Map();
      for (let index = 0; index < mesh.count; index++) {
        const y = array[index * 16 + 13];
        heights.set(y, (heights.get(y) ?? 0) + 1);
      }
      return { count: mesh.count, rows: [...heights].sort((a, b) => b[1] - a[1]) };
    };
    return {
      deck: { top: deck.geometry.boundingBox.max.y, minY: deck.geometry.boundingBox.min.y,
        y: world[13], yScale: world[5] },
      walkers: at('traffic-walkers'), cars: at('traffic-cars'),
      near: n.nearTraffic(),
    };
  });
  expect(read.missing, read.missing ?? '').toBeUndefined();
  expect([read.deck.y, read.deck.yScale], `桥体那层被整体扯移了，bbox 不再等于世界顶面：${JSON.stringify(read.deck)}`)
    .toEqual([0, 1]);
  // ① 画出来的那一层：顶面就是 `base + thickness`。
  expect(Math.round(read.deck.top * 1000) / 1000, `桥面顶面实测 ${read.deck.top} m，与 DECK_TOP_METRES 分家`)
    .toBe(DECK_TOP_METRES);
  expect(Math.round(read.deck.minY * 1000) / 1000, '桥面底面不在净空那一米上').toBe(12);
  // ② 站着的那一批：只有海心桥那 24 个行人离地，而且逐字站在①那个顶面上；其余 1,220 个还在地面。
  expect(read.walkers.rows.map(([y, count]) => [Math.round(y * 1000) / 1000, count]),
    `行人的离地高度汇总不对（按台数从多到少）：${JSON.stringify(read.walkers.rows)}`)
    .toEqual([[0, 1220], [DECK_TOP_METRES, 24]]);
  // ③ 引擎只把这一座桥画成了体，其余桥路的车离地就是浮桥。
  expect(read.cars.rows.some(([y]) => y > 1), `引擎把车抬到了没画出来的桥面上：${JSON.stringify(read.cars.rows)}`)
    .toBe(false);
  // ④ 这一页确实有近场与桥：没有的话上面三条全在空数组上永真。
  expect([read.near.cars, read.near.walkers], `近场没装配：${JSON.stringify(read.near)}`).toEqual([1298, 1244]);
  expect(errors, `桥面标高这一块跑出了页面错误：${JSON.stringify(errors)}`).toEqual([]);
});
