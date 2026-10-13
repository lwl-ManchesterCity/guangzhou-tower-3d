import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { DEFAULT_CENTER } from '../src/config.js';
import { plane } from '../src/geo.js';
import { GROUND_LAYERS } from '../src/engine/ground.js';
import {
  BASE_BAND_LIFT_METRES, BASE_BAND_MAX_METRES, BASE_BAND_MIN_ZOOM, BASE_BAND_WIDTH_METRES, PAD_LIFT_METRES,
  WET_BAND_MAX_METRES, WET_BAND_MIN_WIDTH_SHARE, WET_BAND_MIN_ZOOM, WET_BAND_WIDTH_METRES,
  baseBandGeometry, bandTexture, createBaseBands, createPads, createShoreBand, padGeometry, padTexture, wetBandGeometry,
} from '../src/shadow-pads.js';
import { faceBlocker } from '../src/vegetation.js';

const buildings = JSON.parse(readFileSync(new URL('../public/data/canton-buildings.geojson', import.meta.url), 'utf8')).features;

/**
 * 一个米制点写回经纬度。用解的而不是公式反算：`plane` 是墨卡托的，反算出来的点回投会差几厘米，
 * 而这一发的判据正是"外沿是不是精确的 `width` 米"。
 */
function pointAt(east, north) {
  const solve = (measure, target) => {
    let low = -0.06;
    let high = 0.06;
    for (let i = 0; i < 60; i++) {
      const mid = (low + high) / 2;
      if (measure(mid) < target) low = mid; else high = mid;
    }
    return (low + high) / 2;
  };
  return [
    DEFAULT_CENTER.lng + solve((delta) => plane(DEFAULT_CENTER, { lng: DEFAULT_CENTER.lng + delta, lat: DEFAULT_CENTER.lat }).dx, east),
    DEFAULT_CENTER.lat + solve((delta) => plane(DEFAULT_CENTER, { lng: DEFAULT_CENTER.lng, lat: DEFAULT_CENTER.lat + delta }).dy, north),
  ];
}

/** 一个中心在 (`cx`,`cy`) 米、半边长 `half` 的正方形楼，绕序可以指定（GeoJSON 没规定绕序，所以两种都要对）。 */
function square({ osmId = 1, cx = 200, cy = 0, half = 20, clockwise = false, holes = [] }) {
  const ring = (points) => {
    const list = clockwise ? points.slice().reverse() : points;
    return list.map(([x, y]) => pointAt(x, y));
  };
  const corners = [[cx - half, cy - half], [cx + half, cy - half], [cx + half, cy + half], [cx - half, cy + half]];
  const closed = (points) => [...points, points[0]];
  return {
    type: 'Feature', properties: { osmId },
    geometry: { type: 'Polygon', coordinates: [closed(ring(corners)), ...holes.map((hole) => closed(ring(hole)))] },
  };
}

const read = (mesh, index) => {
  const matrix = new THREE.Matrix4();
  mesh.getMatrixAt(index, matrix);
  const shift = new THREE.Vector3();
  const turn = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  matrix.decompose(shift, turn, scale);
  return { shift, turn, scale, nose: new THREE.Vector3(1, 0, 0).applyQuaternion(turn) };
};
// 实例矩阵与几何存的是 Float32，比数要用存储自己的容差（与 `traffic-life.test.js` 里 `within` 同一个口径）。
const within = (actual, expected, label = '', epsilon = 1e-5) => {
  assert.ok(Math.abs(actual - expected) < epsilon, `${label}：${actual} 与 ${expected} 差过 ${epsilon}`);
};

test('贴片那张图中心最实、边上没有，而且不是 DOM 造出来的', () => {
  const map = padTexture();
  assert.equal(map.image.width, map.image.height, '径向那张图必须是方的');
  const at = (x, y) => map.image.data[(y * map.image.width + x) * 4 + 3];
  const centre = Math.floor(map.image.width / 2);
  assert.equal(at(centre, centre), 255, '贴片中心该是全实');
  assert.equal(at(0, 0), 0, '贴片的角上不该还有东西（那是个方的影）');
  assert.ok(at(centre, centre) > at(centre, centre + 6) && at(centre, centre + 6) > at(centre, centre + 12), '往外不是单调变淡');
  // 这一模块被两条渲染路径共用，测试那侧没有 DOM：贴图必须由数据直接生成。
  assert.equal(map.colorSpace, THREE.NoColorSpace);
  assert.equal(map.isDataTexture, true);
  map.dispose();
});

test('楼根那条带从墙根往外淡到没有', () => {
  const map = bandTexture();
  const at = (x) => map.image.data[x * 4 + 3];
  assert.equal(at(0), 255, '贴墙那一头该是全实');
  assert.equal(at(map.image.width - 1), 0, '外沿该淡到没有，不然是一条描边');
  for (let x = 1; x < map.image.width; x += 1) assert.ok(at(x) <= at(x - 1), `第 ${x} 格比上一格还深`);
  map.dispose();
});

test('贴片站在自己的抬升高度上，而且高于两条路径的最高那块地面', () => {
  const pads = createPads({ name: 'pads', count: 2 });
  pads.place({ x: 10, y: 20, radiusX: 2, radiusY: 1 });
  pads.place({ x: 30, y: 40, deck: 15.5, yaw: Math.PI / 2, radiusX: 2, radiusY: 1 });
  pads.finish();
  assert.equal(pads.mesh.count, 2);
  const first = read(pads.mesh, 0);
  const second = read(pads.mesh, 1);
  assert.equal(pads.mesh.count, 2, 'finish 之后计数要留住');
  within(first.shift.y, PAD_LIFT_METRES, '地面那片影的高度');
  within(second.shift.y, PAD_LIFT_METRES + 15.5, '桥上的车那片影要跟着桥面抬');
  within(first.shift.x, 10, '贴片没摆在 x 上');
  within(first.shift.z, -20, '贴片没摆在 z 上（+y 北要翻成 −z）');
  // 贴片几何是 1×1 的方形：scale 就是长短半轴的两倍，`yaw` 只转不缩。
  within(first.scale.x, 4, '长半轴没写成两倍尺度');
  within(first.scale.z, 2, '短半轴没写成两倍尺度');
  const nose = (item) => new THREE.Vector3(1, 0, 0).applyQuaternion(item.turn);
  assert.ok(Math.abs(nose(first).x - 1) < 1e-6, '没给 yaw 时贴片不该自己转');
  assert.ok(Math.abs(nose(second).z + 1) < 1e-6, 'yaw=π/2 没把贴片的长轴转到 −z 上');
  // 这一条是两条渲染路径共用地面高度的唯一交集：引擎那侧最高的地面是路带，贴片低于它就会被自己的路挡住。
  const highest = Math.max(...Object.values(GROUND_LAYERS));
  assert.ok(PAD_LIFT_METRES > highest, `贴片抬 ${PAD_LIFT_METRES} m，可引擎最高的地面是 ${highest} m`);
  assert.ok(BASE_BAND_LIFT_METRES > highest, `楼根带抬 ${BASE_BAND_LIFT_METRES} m，同样要高于 ${highest} m`);
  assert.ok(BASE_BAND_LIFT_METRES < PAD_LIFT_METRES, '楼根带要比车影低一点，两者叠着的时候车影在上面');
  pads.dispose();
});

test('一片影都没有的那一侧也要装得出来（count 0 不炸）', () => {
  const pads = createPads({ name: 'pads', count: 0 });
  pads.finish();
  assert.equal(pads.mesh.count, 0);
  assert.equal(pads.mesh.geometry.getAttribute('position').count, 4, '贴片是一块躺平的方形');
  const box = new THREE.Box3().setFromBufferAttribute(pads.mesh.geometry.getAttribute('position'));
  assert.ok(Math.abs((box.max.y - box.min.y)) < 1e-6, '方形没躺平，y 有厚度');
  pads.dispose();
});

test('楼根那条带是往外偏的，两种绕序都对，洞不参与', () => {
  const width = BASE_BAND_WIDTH_METRES;
  const half = 20;
  for (const clockwise of [false, true]) {
    const built = baseBandGeometry({ features: [square({ cx: 300, cy: 0, half, clockwise })], origin: DEFAULT_CENTER });
    assert.equal(built.faces, 1, '一块楼该出一条带');
    // 每条边两个三角形 = 6 个顶点，四条边 24 个。
    assert.equal(built.vertices, 24, `顶点数不是 24（拿到 ${built.vertices}），说明带子的三角形数变了`);
    const positions = built.geometry.getAttribute('position');
    let min = Infinity;
    let max = -Infinity;
    let onWall = 0;
    let outside = 0;
    for (let index = 0; index < positions.count; index += 1) {
      // 90° 角上的斜接正好是 (w, w)，所以每个顶点要么在墙上（两个轴都是 half），要么在外沿（两个轴都是 half + w）。
      const x = Math.abs(positions.getX(index) - 300);
      const z = Math.abs(-positions.getZ(index));
      // 容差是 2 mm 而不是 0.1 mm：`plane` 的经度尺度取的是"原点与这一点中间"那纬的余弦，
      // 所以一块偏北 20 m 的方形楼，它的东西边长本来就不是精确的 40 m（量到 0.4 mm 一级）。
      if (Math.abs(x - half) < 2e-3 && Math.abs(z - half) < 2e-3) onWall += 1;
      else if (Math.abs(x - (half + width)) < 2e-3 && Math.abs(z - (half + width)) < 2e-3) outside += 1;
      min = Math.min(min, x, z);
      max = Math.max(max, x, z);
    }
    assert.equal(onWall + outside, positions.count, '有的顶点既不在墙上也不在外沿：偏移算错了');
    assert.ok(Math.abs(max - (half + width)) < 2e-3, `${clockwise ? '顺' : '逆'}时针的带外沿到了 ${max.toFixed(2)} m，应是 ${(half + width).toFixed(2)}`);
    assert.ok(Math.abs(min - half) < 2e-3, `${clockwise ? '顺' : '逆'}时针的带内沿不在墙上（${min.toFixed(2)} m）`);
    assert.equal(onWall, positions.count / 2, '墙上与外沿的顶点数该一样多，否则带子不是一条等宽的带');
    within(positions.getY(0), BASE_BAND_LIFT_METRES, '带子没贴在同一高度上', 1e-6);
    // 正面朝上：`padMaterial` 是 FrontSide，三角形翻面就等于这层根本不画（与下面湿线那一条同一个坑）。
    const normals = built.geometry.getAttribute('normal');
    let down = 0;
    for (let index = 0; index < normals.count; index += 1) if (normals.getY(index) < 0.9) down += 1;
    assert.equal(down, 0, `有 ${down} 颗法线不朝上，那一面 FrontSide 材质根本不画`);
    const uvs = built.geometry.getAttribute('uv');
    const seen = new Set(Array.from({ length: uvs.count }, (_, index) => uvs.getX(index)));
    assert.deepEqual([...seen].sort(), [0, 1], 'uv 的横向没铺到 0~1，那张衰减图就没地方采样');
    built.geometry.dispose();
  }
  // 洞不参与：一栋带中庭的楼，只按外环画。
  const withHole = baseBandGeometry({
    features: [square({ cx: 300, cy: 0, half, holes: [[[295, -5], [305, -5], [305, 5], [295, 5]]] })],
    origin: DEFAULT_CENTER,
  });
  assert.equal(withHole.vertices, 24, '洞边上也被画了带子（中庭里会出现一片没来由的影）');
  withHole.geometry.dispose();
});

test('远处那圈楼不给带子，近处的全给：闸门是"任一回字落进半径"', () => {
  const near = square({ osmId: 2, cx: BASE_BAND_MAX_METRES - 100, cy: 0, half: 20 });
  const far = square({ osmId: 3, cx: BASE_BAND_MAX_METRES + 100, cy: 0, half: 20 });
  const built = baseBandGeometry({ features: [near, far], origin: DEFAULT_CENTER });
  assert.equal(built.faces, 1, '距离闸门没生效');
  const skipped = baseBandGeometry({ features: [far], origin: DEFAULT_CENTER });
  assert.equal(skipped.faces, 0, '超出半径的楼还是画了');
  assert.equal(skipped.vertices, 0, '空的还要留顶点');
  built.geometry.dispose();
  skipped.geometry.dispose();
});

test('楼根那一层出厂就在场，镜头退到门控以下就整块没', () => {
  const bases = createBaseBands({ features: [square({ cx: 300, cy: 0 })], origin: DEFAULT_CENTER });
  assert.equal(bases.group.name, 'building-bases-group');
  assert.equal(bases.group.children.length, 1);
  assert.equal(bases.mesh.name, 'building-bases');
  assert.equal(bases.report.faces, 1);
  assert.deepEqual([bases.visible(), bases.group.visible], [true, true], '没读镜头之前该画');
  assert.equal(bases.setZoom(BASE_BAND_MIN_ZOOM - 0.1), true);
  assert.equal(bases.visible(), false, '那一档以下这块地还是样式那块色');
  assert.equal(bases.setZoom(BASE_BAND_MIN_ZOOM), true);
  assert.equal(bases.visible(), true);
  assert.equal(bases.setZoom(BASE_BAND_MIN_ZOOM + 0.01), false, '阈值以上再推一点不该重复写');
  assert.equal(bases.setZoom(18), true, '换了档位要写');
  assert.equal(bases.setShown(false), true, '透视镜的开关没接上');
  assert.equal(bases.visible(), false);
  assert.equal(bases.setShown(false), false);
  bases.setShown(true);
  bases.dispose();
  assert.equal(bases.group.children.length, 0, 'dispose 没把网格摘下来');
});

test('出厂快照这一层的规模是量出来的：面数、顶点数与一个 draw call', () => {
  const bases = createBaseBands({ features: buildings, origin: DEFAULT_CENTER });
  // 2026-10-10 量的：任一回字落进 1,200 m 的楼是 286 面 / 2,047 个环顶点。
  // 门槛钉"数量级 + 不为 0"，不钉死精确值：快照重抽之后这一圈会变，而"合并几何没接上"才是它要防的。
  assert.ok(bases.report.faces > 200 && bases.report.faces < 400, `闸门内的楼是 ${bases.report.faces} 面，与量到的 286 不是一个量级`);
  assert.ok(bases.report.vertices > 10000 && bases.report.vertices < 20000, `合并几何 ${bases.report.vertices} 个顶点，与量到的 12,282 不是一个量级`);
  assert.ok(Number.isFinite(bases.mesh.geometry.getAttribute('position').getX(0)), '几何里第一个顶点就成了 NaN');
  const box = new THREE.Box3().setFromBufferAttribute(bases.mesh.geometry.getAttribute('position'));
  assert.ok(box.min.y >= BASE_BAND_LIFT_METRES - 1e-6 && box.max.y <= BASE_BAND_LIFT_METRES + 1e-6, '带子没在同一高度上，会有半截埋进地面');
  // 闸门是"任一回字落进半径"，所以一块横跨 1,200 m 那条线的楼会整条画出来，带子可以伸到线外一栋楼的跨度那么远。
  // 这一句钉的是它不许跑到场景之外：量到的最远一片在 1,788 m（3 km 场景内）。
  assert.ok(Math.hypot(box.max.x, box.max.z) < 3000, `带子铺到了 ${Math.round(Math.hypot(box.max.x, box.max.z))} m 外，出了场景`);
  assert.ok(Math.hypot(box.max.x, box.max.z) > BASE_BAND_MAX_METRES, '带子全挤在闸门之内，说明闸门那条"任一回字"根本没生效');
  bases.dispose();
});

// 近岸那一圈湿线（2026-10-10 页面内第 5 项）：与楼根带共用 `ringBand`，所以判据要钉的正是**两差别处**——
// 往哪一边偏、以及"水面不够宽就不画"。
test('近岸那条带朝水里偏：外环朝环内、江心洲朝环外，窄水面整块拒掉', () => {
  const width = WET_BAND_WIDTH_METRES;
  const half = 200;
  const islet = 20;
  // 每条边中间再放一个点：四角方形没有"直段"，斜接一夹就量不到 `width` 那个数（只能量到 width/√2）。
  const box8 = (edge) => {
    const corners = [[-edge, -edge], [edge, -edge], [edge, edge], [-edge, edge]];
    const points = [];
    for (let index = 0; index < 4; index += 1) {
      const a = corners[index];
      const b = corners[(index + 1) % 4];
      points.push(a, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
    }
    return points;
  };
  const water = ({ edge = half, holes = [], clockwise = false }) => {
    const ring = (points) => (clockwise ? points.slice().reverse() : points).map(([x, y]) => pointAt(x, y));
    const closed = (points) => [...points, points[0]];
    return {
      type: 'Feature', properties: { osmId: 7 },
      geometry: { type: 'Polygon', coordinates: [closed(ring(box8(edge))), ...holes.map((hole) => closed(ring(hole)))] },
    };
  };
  const island = box8(islet);
  for (const clockwise of [false, true]) {
    const label = `${clockwise ? '顺' : '逆'}时针`;
    const built = wetBandGeometry({ features: [water({ holes: [island], clockwise })], origin: DEFAULT_CENTER });
    assert.equal(built.faces, 2, `${label}：一块带洲的水面该出两条带（外岸线 + 洲的岸线）`);
    assert.equal(built.skipped, 0, `${label}：400 m 见方的水面被宽度闸门拒掉了`);
    const positions = built.geometry.getAttribute('position');
    assert.equal(positions.count, 96, `${label}：两条带各 8 条边 × 6 个顶点，拿到 ${positions.count}`);
    // 每颗顶点到它那条岸线的"进深"：0 是岸线上那一头，直段上的内沿正好 `width`，角上因为斜接夹成 1 倍
    // （`mitre: 1`）所以是 width/√2。方形用 `max(|x|,|z|)` 量进深正好把这两档都算对；两条带按"离中心不到半幅"分家。
    const depth = (x, z) => (Math.max(Math.abs(x), Math.abs(z)) < half / 2
      ? Math.max(Math.abs(x), Math.abs(z)) - islet
      : half - Math.max(Math.abs(x), Math.abs(z)));
    let onShore = 0;
    let inward = 0;
    let stray = 0;
    let deepest = 0;
    let corner = 0;
    let straight = 0;
    const uvs = built.geometry.getAttribute('uv');
    for (let index = 0; index < positions.count; index += 1) {
      const x = positions.getX(index);
      const z = -positions.getZ(index);
      within(positions.getY(index), PAD_LIFT_METRES, `${label}：带子没贴在近场那一片的高度上`, 1e-6);
      const at = depth(x, z);
      if (Math.abs(at) < 2e-3) onShore += 1;
      else if (at > width / 2 - 2e-3 && at <= width + 2e-3) inward += 1;
      else stray += 1;
      deepest = Math.max(deepest, at);
      // 斜接夹在 1 倍：角上那一颗的进深是 width/√2，直段上的是 width。两档各 8 颗——写成 2 倍角上就顶到 width，
      // 这一句当场分家（也顺便钉住"凹角不甩到岸上"那笔账）。
      if (Math.abs(at - width / Math.SQRT2) < 2e-3) corner += 1;
      if (Math.abs(at - width) < 2e-3) straight += 1;
      // 衰减方向：u=0 那一头必须正压在岸线上，u=1 那一头必须在水里。写反了就是"水里最深、岸边淡出"。
      if (uvs.getX(index) < 0.5) assert.ok(Math.abs(at) < 2e-3, `${label}：第 ${index} 颗 u=0 的顶点不在岸线上（进深 ${at.toFixed(2)} m）`);
      else assert.ok(at > width / 2, `${label}：第 ${index} 颗 u=1 的顶点没往水里偏（进深 ${at.toFixed(2)} m）`);
    }
    assert.equal(corner, 24, `${label}：斜接不是夹在 1 倍（角上量到 ${corner} 颗，该是 8 个角点 × 每点在三角形里出现 3 次）`);
    assert.equal(straight, 24, `${label}：直段上的内沿不是点名的带宽（量到 ${straight} 颗）`);
    assert.equal(stray, 0, `${label}：有 ${stray} 颗顶点的进深不在 0 或 ~${width} m 这两头上，偏移算错了`);
    // 朝左偏出来的那条带三角形顺序会翻面，而 `padMaterial` 是 FrontSide——不翻回来的话它"在场景里、在画面外"
    // （逐像素 A/B 量到 0 个像素变化）。所以这里直接钉法线朝上。
    const normals = built.geometry.getAttribute('normal');
    let down = 0;
    for (let index = 0; index < normals.count; index += 1) if (normals.getY(index) < 0.9) down += 1;
    assert.equal(down, 0, `${label}：有 ${down} 颗法线不朝上，那一面 FrontSide 材质根本不画`);
    assert.equal(onShore, positions.count / 2, `${label}：岸线上与内沿的顶点数不一样多，那不是一条等宽的带`);
    assert.equal(inward, positions.count / 2, `${label}：内沿那一半没数齐`);
    within(deepest, width, `${label}：直段上的进深不是点名的带宽`, 2e-3);
    // 方向单独再钉一遍：外环一颗都不许越过岸线（越过就是画在堤岸上），而洲那一条不许伸进洲里。
    const box = new THREE.Box3().setFromBufferAttribute(positions);
    assert.ok(box.max.x <= half + 2e-3 && box.max.z <= half + 2e-3,
      `${label}：带子越过了岸线（x 到 ${box.max.x.toFixed(1)} m），那是画在堤岸上不是画在水上`);
    assert.ok(Math.abs(box.min.x) >= islet - 2e-3 && Math.abs(box.min.z) >= islet - 2e-3,
      `${label}：洲那一圈伸进洲里了（x 到 ${box.min.x.toFixed(1)} m），那是把岛涂黑了一条`);
    built.geometry.dispose();
  }
  // 宽度闸门：一条 16 m 宽的水面不该有"近岸"，画上去是把整个水塘涂黑。
  const pond = wetBandGeometry({ features: [square({ cx: 0, cy: 0, half: 8 })], origin: DEFAULT_CENTER });
  assert.deepEqual([pond.faces, pond.skipped], [0, 1], '窄水面还是画了湿线');
  assert.equal(pond.vertices, 0, '拒掉的圈还留着顶点');
  // 闸门按 `2 × 面积 / 周长` 估：长带算出来就是带宽，方形算出来是边长的一半（偏保守，正是这一格要的方向）。
  // 所以一块 50 m 见方的水面（估出 25 m）过闸，一块 16 m 见方的不过。
  const justWide = wetBandGeometry({ features: [square({ cx: 0, cy: 0, half: 25 })], origin: DEFAULT_CENTER });
  assert.equal(justWide.faces, 1, '刚到闸门的水面被拒了，那条倍数写反了');
  assert.equal(WET_BAND_MIN_WIDTH_SHARE, 3, '闸门不再是"三条带宽"，上面那两句反例的边界要一起挪');
  justWide.geometry.dispose();
  // 距离闸门与楼根带同一条口径："任一回字落进半径"。
  const far = wetBandGeometry({ features: [square({ cx: WET_BAND_MAX_METRES + 1200, cy: 0, half })], origin: DEFAULT_CENTER });
  assert.equal(far.faces, 0, '闸门之外的水面还是画了');
  far.geometry.dispose();
});

test('湿线那一层：镜头门控与总开关各管一头，谁也不许把对方顶掉', () => {
  const wet = createShoreBand({ features: [square({ cx: 0, cy: 0, half: 200 })], origin: DEFAULT_CENTER });
  assert.equal(wet.group.name, 'shore-wet');
  assert.deepEqual(wet.group.children.map((child) => child.name), ['shore-wet-line']);
  assert.equal(wet.report.faces, 1);
  assert.deepEqual([wet.visible(), wet.group.visible], [true, true], '没读镜头之前该画');
  assert.equal(wet.setZoom(WET_BAND_MIN_ZOOM - 0.1), true);
  assert.equal(wet.visible(), false, '那一档以下这条线交回样式那块水面');
  assert.equal(wet.setZoom(WET_BAND_MIN_ZOOM), true);
  assert.equal(wet.visible(), true);
  assert.equal(wet.setZoom(WET_BAND_MIN_ZOOM + 0.01), false, '阈值以上再推一点不该重复写');
  // 透视镜收走之后镜头还在动：这一笔若写回 `group.visible = zoom >= min`，湿线会在下一帧自己回来。
  assert.equal(wet.setShown(false), true, '近场的总开关没接到湿线');
  assert.equal(wet.visible(), false);
  assert.equal(wet.setZoom(18), true);
  assert.equal(wet.visible(), false, '透视镜收走之后，镜头一动湿线又自己回来了');
  assert.equal(wet.setShown(false), false, '同一个开关按两次不该写第二遍');
  assert.equal(wet.setShown(true), true);
  assert.equal(wet.visible(), true);
  assert.ok(wet.mesh.material.transparent && wet.mesh.material.opacity > 0 && wet.mesh.material.opacity <= 0.5, '一条湿线要么没画，要么黑成一条沟');
  assert.equal(wet.mesh.material.depthWrite, false, '贴水面的一层不能写深度，否则会挡住它自己的船与灯');
  wet.dispose();
  assert.equal(wet.group.children.length, 0, 'dispose 没把网格摘下来');
});

test('出厂快照的这一圈：每一颗内沿顶点都还泡在水里', () => {
  const water = JSON.parse(readFileSync(new URL('../public/data/canton-water.geojson', import.meta.url), 'utf8')).features;
  const built = wetBandGeometry({ features: water, origin: DEFAULT_CENTER });
  // 2026-10-10 量的：落进 1,200 m 的水环 11 条，其中 5 条被宽度闸门拒掉（不到 21 m 宽的小水塘），画出来 6 圈。
  assert.ok(built.faces >= 4 && built.faces <= 12, `量到 ${built.faces} 圈，与量到的 6 圈不是一个量级`);
  assert.ok(built.skipped >= 3, `${built.skipped} 圈被宽度闸门拒掉，那条规则没有对象`);
  assert.ok(built.vertices > 1000 && built.vertices < 8000, `合并几何 ${built.vertices} 个顶点，与量到的 3,486 不是一个量级`);
  // 最强的一句：内沿（u=1 那一头）一颗都不许在岸上。绕序写反时这一句会当场报几百颗。
  // 范围取整个场景（3 km）：量到的唯一例外是那一条江在 7,716 m 处流出快照的一个尖角，3 颗顶点、最多甩出 0.72 m，
  // 画面够不到那里，所以不在门槛里——但它不是"方向对了就永远不出界"的证据，方向一错这里就是几百颗。
  const inWater = faceBlocker(water, DEFAULT_CENTER);
  const positions = built.geometry.getAttribute('position');
  const uvs = built.geometry.getAttribute('uv');
  let inner = 0;
  let ashore = 0;
  let farInner = 0;
  for (let index = 0; index < positions.count; index += 1) {
    if (uvs.getX(index) < 0.5) continue;
    const x = positions.getX(index);
    const y = -positions.getZ(index);
    const distance = Math.hypot(x, y);
    if (distance > 3000) continue;
    inner += 1;
    if (distance > 1500) farInner += 1;
    if (!inWater(x, y)) ashore += 1;
  }
  assert.ok(inner > 600, `场景内只量到 ${inner} 颗内沿顶点，这一发没读到东西`);
  assert.equal(ashore, 0, `${ashore} 颗湿线的内沿爬到了岸上（那是把堤岸涂黑了一条）`);
  const box = new THREE.Box3().setFromBufferAttribute(positions);
  assert.ok(box.min.y >= PAD_LIFT_METRES - 1e-6 && box.max.y <= PAD_LIFT_METRES + 1e-6, '带子没在同一高度上，会有半截埋进水里');
  // 闸门挑的是"哪几条水环"，不是这条环上的哪一段：一条从塔边流过去的江，湿线跟着它一路流到快照外。
  // 中途断在 1,200 m 那条线上反而是一道切痕，所以不断——代价是这一圈会伸到画面够不到的地方（量到的最远一片在 7,788 m，
  // 是珠江自己流出快照的方向），而上面那句"每一颗内沿都在水里"对整圈都成立。
  assert.ok(Math.hypot(box.max.x, box.max.z) > 1500, '整条带子全挤在闸门之内，那句"任一回字"没生效');
  assert.ok(farInner > 100, `闸门外的水环一段都没画（${farInner} 颗内沿顶点），那句"跟着江走"是空的`);
  built.geometry.dispose();
});
