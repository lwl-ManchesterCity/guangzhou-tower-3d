// 交叉淡的"成簇"量尺为什么两引擎不一样：同一机位、同一对角，把 24×24 小窗的排名与两种缺陷注入并排量出来。
//   正确：呼吸的那 1/7 在另一手上换到"整栋不亮"那一行 → 一栋一起暗 → 小窗里挤。
//   注入①（aLampBits 的呼吸位全为 0）：没有楼会整栋灭，只剩换格 → 应当摊平。
//   注入②（lampAltColumn = 0）：两手册同一列，另一手没接上 → moved 应当塌。
// 现版那侧只出基准（它的两个数已在 tests/browser.spec.js 里钉死），新引擎那侧三种都跑。
import { chromium } from '@playwright/test';
const app = process.env.APP_URL || 'http://127.0.0.1:5174';
const camera = '#map=15.5/23.1095/113.31913/-25/62';
const CLIP = { x: 620, y: 300, width: 720, height: 460 };
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });

const GRADE = async ({ a, b, box = 24 }) => {
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
  const hits = [];
  let cluster = 0;
  for (let top = 0; top + box < x.height; top += 6) {
    const column = new Int32Array(x.width);
    for (let py = top; py < top + box; py++) for (let px = 0; px < x.width; px++) column[px] += changed[py * x.width + px];
    for (let left = 0; left + box < x.width; left += 6) {
      let count = 0;
      for (let px = left; px < left + box; px++) count += column[px];
      cluster = Math.max(cluster, count);
      if (count >= 48) hits.push([left, top, count]);
    }
  }
  hits.sort((m, n) => n[2] - m[2]);
  return { moved, cluster, patches: hits.length, top: hits.slice(0, 6) };
};

const open = async (three) => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const errors = [];
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(`${app}/?scene=canton&atmosphere=night${three ? '&engine=three' : ''}${camera}`);
  await page.waitForSelector('[data-atmosphere-option="night"]:not([disabled])', { timeout: 180000 });
  await page.locator('[data-atmosphere-option="night"]').click();
  await page.waitForTimeout(4000);
  await page.evaluate(async () => {
    const { neighborhood: n } = await import(document.querySelector('script[type="module"][src*="/src/main.js"]').src);
    window.__n = n;
  });
  const settle = async () => page.evaluate(() => new Promise((resolve) => {
    if (window.__n.map) { window.__n.map.triggerRepaint(); window.__n.map.once('idle', resolve); }
    else requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
  const stop = () => page.evaluate(async () => {
    if (window.__n.map) {
      if (document.body.dataset.motion !== 'off') document.querySelector('#motion-toggle').click();
      await new Promise((r) => setTimeout(r, 400));
    } else window.__n.setMotion(false);
  });
  const weights = async (w0, w1) => {
    await page.evaluate(([a, b]) => {
      if (window.__n.map) { window.__n.map.setGlobalStateProperty('lamp-0', a); window.__n.map.setGlobalStateProperty('lamp-1', b); }
      else window.__n.setLampWeights(a, b);
    }, [w0, w1]);
    await settle();
    await page.waitForTimeout(700);
    return (await page.screenshot({ clip: CLIP })).toString('base64');
  };
  // 注入只活在浏览器的一次运行里：改的是这份几何的属性与那个材质的 uniform，源码不动。
  // 一个类别的四张网（体块/窗纹/光晕/亮窗）共用同一份几何，所以先按属性对象去重，否则"还原"会把
  // 已经被前一次遍历清零后的副本写回去（实测：不去重时 version 一次加 4，还原后呼吸位仍是 0）。
  const inject = async (kind) => page.evaluate((mode) => {
    if (mode === 'bits' || mode === 'all') {
      const attributes = new Set();
      window.__n.scene.traverse((object) => {
        if (!/^building-(lamps|glow)-/.test(object.name ?? '')) return;
        const attribute = object.geometry?.getAttribute?.('aLampBits');
        if (attribute) attributes.add(attribute);
      });
      window.__saved = [...attributes].map((attribute) => {
        const copy = attribute.array.slice();
        for (let i = 1; i < attribute.array.length; i += 2) attribute.array[i] = mode === 'all' ? 1 : 0;
        attribute.needsUpdate = true;
        return { attribute, copy };
      });
    } else if (mode === 'column') {
      const uniforms = new Set();
      window.__n.scene.traverse((object) => {
        const uniform = object.material?.userData?.shader?.uniforms?.lampAltColumn;
        if (uniform) uniforms.add(uniform);
      });
      window.__cols = [...uniforms].map((uniform) => {
        if (uniform.base === undefined) uniform.base = uniform.value;
        uniform.value = 0;
        return uniform;
      });
    } else {
      for (const { attribute, copy } of window.__saved ?? []) { attribute.array.set(copy); attribute.needsUpdate = true; }
      for (const uniform of window.__cols ?? []) uniform.value = uniform.base;
      window.__saved = []; window.__cols = [];
    }
    const breath = (window.__saved ?? []).reduce((sum, { attribute }) =>
      sum + attribute.array.reduce((total, value, index) => total + (index % 2 ? value : 0), 0), 0);
    return `${(window.__saved ?? []).length} 份属性 / ${(window.__cols ?? []).length} 个 uniform，呼吸位合计 ${breath}`;
  }, kind);
  await stop();
  return { page, weights, inject, errors };
};

const report = async (label, run) => {
  const shipped = await run.weights(1, 1);
  const swapped = await run.weights(0, 1);
  const grade = await run.page.evaluate(GRADE, { a: shipped, b: swapped });
  console.log(`${label}: moved ${grade.moved} / cluster ${grade.cluster} / ≥48 的小窗 ${grade.patches} 个 / 前几 ${JSON.stringify(grade.top)}`);
  return grade;
};

const three = await open(true);
await report('新引擎 出厂        ', three);
const labels = { bits: '注入①无呼吸  ', column: '注入②列偏移0 ', all: '注入③全员呼吸  ', none: '还原          ' };
for (const kind of ['bits', 'none', 'column', 'none', 'all']) {
  console.log(`  注入 ${kind} → ${await three.inject(kind)}`);
  await report(`新引擎 ${labels[kind]}`, three);
}
const legacy = await open(false);
await report('现版   出厂(基准)   ', legacy);
console.log('报错', three.errors.length, three.errors.slice(0, 2), legacy.errors.length, legacy.errors.slice(0, 2));
await browser.close();
