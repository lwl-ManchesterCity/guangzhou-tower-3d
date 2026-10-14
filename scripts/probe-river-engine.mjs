// 一次性：新引擎那侧的江面波光（#189）到底画成了什么。
// 两边各做一次"开／关"自比（现版藏 `river-surface` 图层，引擎藏 `river-sheen-water` 网格），
// 比的是三件事：这一层带来的画面量级、它在屏幕上的周期（应当 8 像素一道、64 像素一圈），以及取景框是不是真落在水里。
import { chromium } from '@playwright/test';
const app = process.env.APP_URL || 'http://127.0.0.1:5174';
const VIEW = process.env.VIEW || '#map=15.5/23.1105/113.3205/-12/58';
const CLIP = { x: 0, y: 0, width: 1440, height: 960 };
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });

async function openPage(engine) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
  page.on('pageerror', (error) => console.log(`[${engine}] page error:`, error.message));
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[${engine}] console:`, m.text()); });
  await page.goto(`${app}/?scene=canton&motion=off${engine === 'three' ? '&engine=three' : ''}${VIEW}`);
  if (engine === 'three') {
    await page.waitForFunction(() => document.querySelector('.engine-stats')?.textContent?.includes('fps'), { timeout: 120000 });
  } else {
    await page.waitForSelector('#places-toggle:not([disabled])', { timeout: 180000 });
  }
  await page.waitForTimeout(2000);
  await page.evaluate(async () => {
    const { neighborhood: n } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    window.__probe = { n };
  });
  return page;
}

// 页面里算：解码 PNG → 亮度网格 → 逐行均值的自相关（去均值、归一化），峰位就是屏幕上的周期。
const ANALYSE = `
window.__analyse = async (b64) => {
  const bitmap = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob());
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width; canvas.height = bitmap.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0);
  const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
  const lum = new Float64Array(width * height);
  for (let i = 0; i < width * height; i++) lum[i] = 0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2];
  return { lum, width, height, rgb: [data[0], data[1], data[2]] };
};
window.__rowPeriod = async (b64) => {
  const { lum, width, height } = await window.__analyse(b64);
  const rows = [];
  for (let y = 0; y < height; y++) {
    let sum = 0;
    for (let x = 0; x < width; x++) sum += lum[y * width + x];
    rows.push(sum / width);
  }
  const mean = rows.reduce((a, b) => a + b, 0) / rows.length;
  const centred = rows.map((v) => v - mean);
  const at = (lag) => {
    let num = 0, den = 0;
    for (let y = 0; y + lag < centred.length; y++) { num += centred[y] * centred[y + lag]; den += centred[y] ** 2; }
    return num / (den || 1);
  };
  const curve = [];
  for (let lag = 2; lag <= 70; lag++) curve.push([lag, Math.round(at(lag) * 1000) / 1000]);
  const peaks = curve.filter(([lag, v], index) => v > 0.2 && (index === 0 || v >= curve[index - 1][1]) && (index === curve.length - 1 || v > curve[index + 1][1]));
  return { first: peaks.length ? peaks[0] : null, strongest: curve.slice().sort((a, b) => b[1] - a[1])[0], peaks: peaks.slice(0, 6) };
};
window.__mad = async (a, b) => {
  const x = await window.__analyse(a), y = await window.__analyse(b);
  let sum = 0, worst = 0;
  for (let i = 0; i < x.lum.length; i++) { const d = Math.abs(x.lum[i] - y.lum[i]); sum += d; if (d > worst) worst = d; }
  return { mean: Math.round(sum / x.lum.length * 100) / 100, worst: Math.round(worst),
    changed: [...x.lum].filter((v, i) => Math.abs(v - y.lum[i]) > 1).length };
};
// 差值图就是"这一层单独画了什么"：它的纵向周期与波纹走向都只由这一层决定，比在整幅画面里找周期干净得多。
window.__diffShape = async (a, b) => {
  const x = await window.__analyse(a), y = await window.__analyse(b);
  const { lum, width, height } = x;
  const d = new Float64Array(lum.length);
  let energy = 0;
  for (let i = 0; i < lum.length; i++) { d[i] = lum[i] - y.lum[i]; energy += d[i] * d[i]; }
  const rows = [];
  for (let row = 0; row < height; row++) {
    let sum = 0;
    for (let col = 0; col < width; col++) sum += d[row * width + col];
    rows.push(sum / width);
  }
  const mean = rows.reduce((p, q) => p + q, 0) / rows.length;
  const centred = rows.map((v) => v - mean);
  const self = centred.reduce((p, q) => p + q * q, 0) || 1;
  const curve = [];
  for (let lag = 2; lag <= 70; lag++) {
    let num = 0;
    for (let row = 0; row + lag < centred.length; row++) num += centred[row] * centred[row + lag];
    curve.push([lag, Math.round(num / self * 1000) / 1000]);
  }
  const peaks = curve.filter(([lag, v], i) => v > 0.25 && v >= (curve[i - 1]?.[1] ?? -9) && v > (curve[i + 1]?.[1] ?? -9));
  // 走向：在半径 8 像素的圆上找自相关最大的那个方向，那条线就是波纹的"平行方向"。
  const angle = (degrees) => {
    const rad = (degrees * Math.PI) / 180;
    const dx = Math.round(8 * Math.cos(rad)), dy = Math.round(8 * Math.sin(rad));
    let num = 0;
    for (let row = 0; row < height - Math.abs(dy); row++) {
      for (let col = 0; col < width - Math.abs(dx); col++) {
        const a = d[row * width + col];
        const b = d[(row + dy) * width + (col + dx)];
        num += a * b;
      }
    }
    return Math.round(num / (energy || 1) * 1000) / 1000;
  };
  const fan = [];
  for (let degrees = 0; degrees < 180; degrees += 5) fan.push([degrees, angle(degrees)]);
  const best = fan.slice().sort((p, q) => q[1] - p[1])[0];
  return { peaks: peaks.slice(0, 5), strongest: curve.slice().sort((p, q) => q[1] - p[1])[0], tilt: best, fan };
};
// 两张差值图（现版的波光层 vs 引擎的波光网格）在 ±64 像素里找最好的对齐偏移：尺度或转角不对，怎么挪都 correlation 不高；
// 尺度与转角对了，就会在某个偏移上出现一个尖峰（相位不同是允许的，因为两边锚点本来不同）。
// 只在一块"两边都确实是水面"的窗里比：整幅画面里波光只占约一成像素，其余是岸上的楼、路、绿地，
// 拿含污的窗做相关，得到的只是地物的相关性，不是这张格子的相关性。
window.__bestShift = async (onA, offA, onB, offB, side = 160) => {
  const x = await window.__analyse(onA), xOff = await window.__analyse(offA);
  const y = await window.__analyse(onB), yOff = await window.__analyse(offB);
  x.flat = xOff; y.flat = yOff;
  const W = x.width, H = x.height;
  const density = (image, ox, oy) => {
    let hits = 0;
    for (let row = 0; row < side; row++) {
      for (let col = 0; col < side; col++) {
        const r = oy + row, c = ox + col;
        if (r >= image.height || c >= image.width) continue;
        const i = r * image.width + c;
        if (Math.abs(image.lum[i] - image.flat.lum[i]) > 1) hits++;
      }
    }
    return hits / (side * side);
  };
  let patch = { at: [0, 0], share: 0 };
  for (let oy = 20; oy + side < H - 20; oy += 40) {
    for (let ox = 20; ox + side < W - 20; ox += 40) {
      const share = Math.min(density(x, ox, oy), density(y, ox, oy));
      if (share > patch.share) patch = { at: [ox, oy], share: Math.round(share * 100) / 100 };
    }
  }
  const [px0, py0] = patch.at;
  const value = (dx, dy) => {
    let num = 0, ea = 0, eb = 0;
    for (let row = 0; row < side; row++) {
      for (let col = 0; col < side; col++) {
        const i = (py0 + row) * W + (px0 + col);
        const j = (py0 + row + dy) * W + (px0 + col + dx);
        if (j < 0 || j >= x.lum.length || py0 + row + dy >= H || px0 + col + dx >= W) continue;
        const a = x.lum[i] - x.flat.lum[i], b = y.lum[j] - y.flat.lum[j];
        num += a * b; ea += a * a; eb += b * b;
      }
    }
    return Math.round(num / (Math.sqrt(ea * eb) || 1) * 1000) / 1000;
  };
  let best = { shift: [0, 0], value: -9 };
  for (let dy = -64; dy <= 64; dy += 4) {
    for (let dx = -64; dx <= 64; dx += 4) {
      const v = value(dx, dy);
      if (v > best.value) best = { shift: [dx, dy], value: v };
    }
  }
  const [bx, by] = best.shift;
  for (let dy = by - 3; dy <= by + 3; dy++) {
    for (let dx = bx - 3; dx <= bx + 3; dx++) {
      const v = value(dx, dy);
      if (v > best.value) best = { shift: [dx, dy], value: v };
    }
  }
  return { ...best, patch };
};
`;

const engine = await openPage('three');
await engine.evaluate(ANALYSE);
const riverState = await engine.evaluate(() => ({ river: window.__probe.n.counts().river,
  drawCalls: window.__probe.n.counts().drawCalls, panel: document.querySelector('.engine-stats').textContent }));
console.log('引擎台账：', JSON.stringify(riverState));

const setSheen = (visible) => engine.evaluate(({ visible }) => {
  const n = window.__probe.n;
  let mesh = null;
  n.scene.traverse((object) => { if (object.name === 'river-sheen-water') mesh = object; });
  if (!mesh) throw new Error('没有 river-sheen-water 这块网格');
  mesh.visible = visible;
  const shader = mesh.material.userData.shader;
  if (shader) shader.uniforms.riverScroll.value = 0;
  return { built: Boolean(shader), center: shader ? [shader.uniforms.riverCenter.value.x, shader.uniforms.riverCenter.value.y] : null,
    rotate: shader ? Math.round(shader.uniforms.riverRotate.value * 1000) / 1000 : null,
    tile: shader ? [shader.uniforms.riverTile.value.x, shader.uniforms.riverTile.value.y] : null };
}, { visible });

const frame = () => engine.evaluate(() => {
  const n = window.__probe.n;
  const view = n.view();
  n.setView({ ...view, zoom: view.zoom });
});

const onInfo = await setSheen(true);
await frame(); await engine.waitForTimeout(600);
const engineOn = (await engine.screenshot({ clip: CLIP })).toString('base64');
// 把转角钉成 0 再拍一张：两种锚法（跟地面转 / 跟画布转）哪一种是现版那侧的实际行为，由自相关方向说了算。
const noRotate = await engine.evaluate(() => {
  let mesh = null;
  window.__probe.n.scene.traverse((object) => { if (object.name === 'river-sheen-water') mesh = object; });
  mesh.material.userData.shader.uniforms.riverRotate.value = 0;
  const view = window.__probe.n.view();
  window.__probe.n.setView({ ...view, zoom: view.zoom });
  return true;
});
await engine.waitForTimeout(600);
const engineFlat = (await engine.screenshot({ clip: CLIP })).toString('base64');
await setSheen(false);
await frame(); await engine.waitForTimeout(600);
const engineOff = (await engine.screenshot({ clip: CLIP })).toString('base64');
console.log('引擎材质：', JSON.stringify(onInfo), 'noRotate 注入：', noRotate);

const legacy = await openPage('legacy');
await legacy.evaluate(ANALYSE);
const legacyShot = async (visibility) => {
  await legacy.evaluate((v) => window.__probe.n.map.setLayoutProperty('river-surface', 'visibility', v), visibility);
  await legacy.evaluate(async () => {
    const n = window.__probe.n;
    await new Promise((resolve) => { n.map.once('idle', resolve); n.map.triggerRepaint(); });
  });
  await legacy.waitForTimeout(500);
  return (await legacy.screenshot({ clip: CLIP })).toString('base64');
};
const legacyOn = await legacyShot('visible');
const legacyOff = await legacyShot('none');
await legacyShot('visible');

const centre = await engine.evaluate(async (b) => (await window.__analyse(b)).rgb, engineOn);
const legacyCentre = await legacy.evaluate(async (b) => (await window.__analyse(b)).rgb, legacyOn);
const result = await engine.evaluate(async ({ engineOn, engineFlat, engineOff, legacyOn, legacyOff }) => {
  // 两边各自的"开减关"差值图：把波光这一层单独摘出来比。
  const shape = (a, b) => window.__diffShape(a, b);
  const out = {
    engine: { delta: await window.__mad(engineOn, engineOff), shape: await shape(engineOn, engineOff) },
    legacy: { delta: await window.__mad(legacyOn, legacyOff), shape: await shape(legacyOn, legacyOff) },
    // 整幅画面里波光只占约一成像素（其余是岸上的楼、路、绿地），所以先找一块两边都密水的窗，再在那格里做相关。
    scales: {
      rotate: await window.__bestShift(engineOn, engineOff, legacyOn, legacyOff),
      norotate: await window.__bestShift(engineFlat, engineOff, legacyOn, legacyOff),
    },
  };
  const unusedNormalised = async (on, off) => {
    const x = await window.__analyse(on), y = await window.__analyse(off);
    const canvas = document.createElement('canvas');
    canvas.width = x.width; canvas.height = x.height;
    const context = canvas.getContext('2d');
    const image = context.createImageData(x.width, x.height);
    for (let i = 0; i < x.lum.length; i++) { const v = Math.min(255, Math.abs(x.lum[i] - y.lum[i]) * 4); image.data[i * 4] = v; image.data[i * 4 + 3] = 255; }
    context.putImageData(image, 0, 0);
    return canvas.toDataURL('image/png').split(',')[1];
  };
  void unusedNormalised;
  return out;
}, { engineOn, engineFlat, engineOff, legacyOn, legacyOff });
console.log('取景框中心像素：引擎', JSON.stringify(centre), '现版', JSON.stringify(legacyCentre));
console.log('对比：', JSON.stringify(result, null, 1));
await engine.context().close();
await legacy.context().close();
await browser.close();
