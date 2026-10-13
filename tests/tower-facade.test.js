import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import {
  FACADE_PIXEL_METRES, FACADE_GLASS, FACADE_MULLION, FACADE_STRUCTURE, facadeAtlas, structureShare,
} from '../src/tower-facade.js';
import { BELT_TRUSSES, DIAGRID_STOREYS, FORM_NIGHT_BODY, FORM_NIGHT_LAMP, LANDMARK_FORMS, createLandmarkForms } from '../src/landmark-forms.js';
import { SCENE } from '../src/config.js';

const buildings = JSON.parse(readFileSync(new URL('../public/data/canton-buildings.geojson', import.meta.url), 'utf8'));
const bridge = JSON.parse(readFileSync(new URL('../public/data/haixin-bridge.geojson', import.meta.url), 'utf8'));
const features = [...buildings.features, ...bridge.features];

const byte = (atlas, column, row) => atlas.texture.image.data[((row * atlas.wide) + column) * 4];
const up = (atlas, row) => (row + 0.5) * FACADE_PIXEL_METRES;
const bright = (atlas, column, row) => byte(atlas, column, row) === Math.round(255 * FACADE_STRUCTURE);
const tube = (metres) => (metres / FACADE_PIXEL_METRES).toFixed(1);
/** 一根 45° 的管子横着绕环量出来的像素数：斜线在横向铺开要乘 √2。 */
const ribRun = (metres) => metres * Math.SQRT2 / FACADE_PIXEL_METRES;
/** 绕环一圈上连续的"结构构件"列段；接缝那一根要算成一整根，所以先把环剪在一个暗列上。 */
function structureRuns(atlas, row) {
  const flags = Array.from({ length: atlas.wide }, (_, column) => bright(atlas, column, row));
  if (!flags.some(Boolean)) return [];
  const cut = flags.lastIndexOf(false);
  const order = [...flags.slice(cut + 1), ...flags.slice(0, cut + 1)];
  const runs = [];
  let length = 0;
  for (const on of order) {
    if (on) length += 1;
    else if (length) { runs.push(length); length = 0; }
  }
  if (length) runs.push(length);
  return runs;
}

test('一张立面图的坐标是这栋塔自己的米数：一个像素一半米', () => {
  const atlas = facadeAtlas({ perimeter: 200, height: 440, storey: 4, bays: 4,
    lattice: { diamonds: 4, from: 1.8, to: 0.7 } });
  assert.equal(atlas.wide, 200 / FACADE_PIXEL_METRES);
  assert.equal(atlas.tall, 440 / FACADE_PIXEL_METRES);
  assert.equal(atlas.diamond, 50, '一颗菱形不是周长的整数分之一');
  assert.equal(atlas.bay, 50);
  // 壳的 uv 里 v 是标高米数，所以这张图必须自己报出"一整趟就是这根塔高"。
  assert.equal(atlas.texture.repeat.x, 1);
  assert.equal(atlas.texture.repeat.y, 1 / 440);
  assert.equal(atlas.texture.wrapS, THREE.RepeatWrapping);
  assert.equal(atlas.texture.wrapT, THREE.ClampToEdgeWrapping);
});

test('立面图是乘性的三层：玻璃最暗、竖框次之、结构构件最亮', () => {
  const atlas = facadeAtlas({ perimeter: 200, height: 40, storey: 4, bays: 4,
    lattice: { diamonds: 4, from: 1.8, to: 0.7 } });
  assert.equal(atlas.texture.colorSpace, THREE.NoColorSpace, '立面图是乘数，不是一种颜色');
  const seen = new Set();
  const { data } = atlas.texture.image;
  for (let i = 0; i < data.length; i += 4) {
    assert.equal(data[i], data[i + 1]);
    assert.equal(data[i + 1], data[i + 2], '灰度图的三个通道必须相同');
    seen.add(data[i]);
  }
  const want = [FACADE_GLASS, FACADE_MULLION, FACADE_STRUCTURE].map((value) => Math.round(255 * value)).sort((a, b) => a - b);
  assert.deepEqual([...seen].sort((a, b) => a - b), want, '立面图上出现了三层以外的亮度');
  const share = structureShare(atlas);
  assert.ok(share > 0.02 && share < 0.5, `结构构件占了这一张图的 ${(share * 100).toFixed(1)} %`);
});

test('菱形斜撑绕环整数颗，所以接缝上那根撑是完整的一根', () => {
  const atlas = facadeAtlas({ perimeter: 200, height: 40, storey: 4, bays: 4,
    lattice: { diamonds: 4, from: 1.8, to: 0.7 } });
  const period = atlas.diamond / FACADE_PIXEL_METRES;
  assert.equal(Number.isInteger(period), true, '一颗菱形没落在整数个像素上');
  for (let row = 0; row < atlas.tall; row += 1) {
    for (let column = 0; column < atlas.wide; column += 1) {
      assert.equal(byte(atlas, (column + period) % atlas.wide, row), byte(atlas, column, row),
        `第 ${row} 行在 ${column} 列和走完一颗菱形（${atlas.diamond} m）之后不一样`);
    }
  }
});

test('斜撑的管径从底部 1.8 m 渐变到顶部 0.7 m', () => {
  const atlas = facadeAtlas({ perimeter: 200, height: 400, storey: 4, bays: 4,
    lattice: { diamonds: 4, from: 1.8, to: 0.7 } });
  // 两组 45° 线每半颗菱形交汇一次（`diamond/2` = 25 m），交汇那一行的横宽是两根撑叠起来的，量不出管径。
  // 所以要量在两次交汇的正中间。
  const row = (metres) => Math.round(metres / FACADE_PIXEL_METRES - 0.5);
  const between = (metres) => [...new Set(structureRuns(atlas, row(metres)))];
  // 那一行上图纸该画多宽：先按标高插值出管径，再换算成横着量的像素数。允许一个像素的取样误差。
  const expected = (metres) => ribRun(1.8 + (0.7 - 1.8) * metres / 400);
  const foot = between(12.5);
  const crown = between(400 - 12.5);
  assert.deepEqual(foot.length, 1, `底部那一行的撑宽不止一种（${foot}）`);
  assert.deepEqual(crown.length, 1, `顶部那一行的撑宽不止一种（${crown}）`);
  assert.ok(foot[0] > crown[0], `底部一根撑占 ${foot} px、顶部占 ${crown} px，没有渐变`);
  assert.ok(Math.abs(foot[0] - expected(12.5)) <= 1,
    `底部 ${foot[0]} px，1.8 m 起步的撑横着量该占 ${expected(12.5).toFixed(1)} px`);
  assert.ok(Math.abs(crown[0] - expected(387.5)) <= 1,
    `顶部 ${crown[0]} px，收到 0.7 m 的撑横着量该占 ${expected(387.5).toFixed(1)} px`);
});

test('环形桁架只出现在点名的标高上，一道一整圈', () => {
  const bands = [100, 200, 300];
  const atlas = facadeAtlas({ perimeter: 200, height: 400, storey: 4, bays: 4, bands, bandHeight: 8 });
  const full = [];
  for (let row = 0; row < atlas.tall; row += 1) {
    if (Array.from({ length: atlas.wide }, (_, column) => bright(atlas, column, row)).every(Boolean)) full.push(row);
  }
  assert.equal(full.length, bands.length * (8 / FACADE_PIXEL_METRES),
    `整圈结构行 ${full.length} 行，${bands.length} 道 × 8 m 该是 ${bands.length * 16} 行`);
  const groups = [];
  for (const row of full) {
    if (groups.length && row === groups.at(-1).at(-1) + 1) groups.at(-1).push(row);
    else groups.push([row]);
  }
  assert.equal(groups.length, bands.length, `${bands.length} 道桁架并成了 ${groups.length} 道`);
  groups.forEach((group, index) => {
    const centre = (group[0] + group.at(-1)) / 2;
    assert.ok(Math.abs(up(atlas, centre) - bands[index]) <= FACADE_PIXEL_METRES,
      `第 ${index + 1} 道画在 ${up(atlas, centre).toFixed(2)} m，不在点名的 ${bands[index]} m 上`);
  });
});

test('竖梃站在这栋楼自己标出的硬角上，接缝那根不缺半宽', () => {
  const piers = [0, 0.25, 0.5, 0.75];
  const atlas = facadeAtlas({ perimeter: 200, height: 40, storey: 4, bays: 8, piers, pierWidth: 2.4 });
  const runs = structureRuns(atlas, Math.floor(atlas.tall / 2));
  assert.equal(runs.length, piers.length, `绕环只有 ${runs.length} 根柱子，该是 ${piers.length} 根`);
  assert.equal(new Set(runs).size, 1, `四根柱子的宽度不一样（${runs}），接缝上那根被切开了`);
  assert.ok(Math.abs(runs[0] - 2.4 / FACADE_PIXEL_METRES) <= 1, `一根柱子占 ${runs[0]} px，2.4 m 该占 ${tube(2.4)} px`);
});

test('两栋塔的立面图各按各的结构数字画', () => {
  const forms = createLandmarkForms({ features, origin: SCENE.center });
  const west = forms.forms.find((form) => form.osmId === 184738716);
  const east = forms.forms.find((form) => form.osmId === 511404889);
  assert.ok(west.facade && east.facade, '两栋塔都该有一张自己的立面图');
  // 西塔：12 层一颗菱形，绕环整数颗；它的图上不该有东塔的柱子和桁架。
  assert.equal(west.facade.lattice.storeys, DIAGRID_STOREYS);
  assert.equal(west.facade.diamonds, Math.round(west.facade.perimeter / west.cell));
  assert.equal(west.facade.piers.length, 0);
  assert.equal(west.facade.bands, 0);
  // 东塔：8 根巨型钢柱站在这条 OSM 轮廓自己标出的 8 个硬角上，6 道环形桁架等分那根直筒。
  assert.equal(east.facade.piers.length, 8, `东塔画了 ${east.facade.piers.length} 根柱子，硬角是 8 个`);
  assert.equal(east.facade.bands, BELT_TRUSSES);
  assert.equal(east.facade.lattice, null);
  assert.equal(LANDMARK_FORMS[511404889].facade.piers, 'corners', '东塔的柱子位该从轮廓的硬角量出来，不是手摆');
  // 一张图覆盖整根塔，所以塔冠读的是同一条标高轴上的顶端切片，不是从头再来一遍。
  for (const form of [west, east]) {
    assert.equal(form.facade.height, form.height);
    assert.equal(form.facade.tall, Math.round(form.height / FACADE_PIXEL_METRES));
  }
  const museum = forms.forms.find((form) => form.osmId === 240896442);
  // 省博也发了自己那张图，但上面没有竖梃、没有斜撑、没有桁架——只有被掏空的石屏（凹孔）。
  assert.ok(museum.facade, '省博也该有一张按自己米数画的图');
  assert.equal(museum.facade.lattice, null, '省博没有斜撑');
  assert.equal(museum.facade.piers.length, 0, '省博没有角部巨柱');
  assert.equal(museum.facade.bands, 0, '省博没有环形桁架');
  assert.equal(forms.forms.find((form) => form.kind === 'deck').facade, null, '桥面没有窗格，也就不该有立面图');
});

test('裙房不穿塔身那张立面图：斜撑是塔的结构，不是底座的结构', () => {
  const forms = createLandmarkForms({ features, origin: SCENE.center });
  for (const form of forms.forms) {
    if (!form.podium) continue;
    const tower = forms.group.children.find((child) => child.name === String(form.osmId));
    const podium = forms.group.children.find((child) => child.name === `${form.osmId}:podium`);
    assert.notEqual(podium.material[0].map, tower.material[0].map,
      `${form.osmId} 的裙房和塔身穿的是同一张图，底座上就会出现塔的斜撑和桁架`);
    assert.equal(podium.material[0].map.wrapT, THREE.RepeatWrapping,
      `${form.osmId} 的裙房拿了一张不重复的图`);
  }
});

// 浏览器那条"塔身平均发光 < 0.05"量的是 `材质系数 × 图的平均分量`，而这个积的一半是这张图自己给的。
// 所以平均值要在生成时就报出来，并且必须随密度单调——不然那条上限量的就是一个不会动的数。
test('灯图报出自己的平均分量，且它随密度单调上涨', () => {
  const build = (density) => facadeAtlas({ perimeter: 200, height: 40, storey: 4, bays: 4,
    paneXShare: 0.62, paneYShare: 0.82,
    lamps: { seed: 584204634, density, fins: { metres: 34, duty: 0.4, floor: 0.6 },
      wall: FORM_NIGHT_BODY / FORM_NIGHT_LAMP } }).lamp;
  const mean = (texture) => texture.userData.mean;
  assert.ok(Number.isFinite(mean(build(0.14))) && mean(build(0.14)) > 0, '平均分量没写在图上');
  assert.equal(mean(build(0.14)), mean(build(0.14)), '同一栋两次生成必须同一个数');
  assert.ok(mean(build(0.02)) < mean(build(0.14)), '密度减半平均分量不降，那条上限量的就不是窗');
  assert.ok(mean(build(0.14)) < mean(build(1)), '把每格都点亮，平均分量必须涨');
  // 出厂那一档要在 Node 里也过得了浏览器那条上限，两侧是同一个数。
  assert.ok(FORM_NIGHT_LAMP * mean(build(0.14)) < 0.05,
    `出厂密度的塔身平均发光是 ${FORM_NIGHT_LAMP * mean(build(0.14))}`);
  assert.ok(FORM_NIGHT_LAMP * mean(build(1)) > 0.05,
    '每格都亮那一版必须越过上限，否则上限是永真的');
  const peak = build(0.14).image.data;
  let hot = 0;
  for (let i = 0; i < peak.length; i += 4) if (peak[i] === 255) hot += 1;
  assert.ok(hot > 0, '这张图上一格亮窗都没有，浏览器那条就是在量底带');
});
