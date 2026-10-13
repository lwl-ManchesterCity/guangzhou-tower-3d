import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { DEFAULT_CENTER } from '../src/config.js';
import { agentPosition } from '../src/traffic-life.js';
import { plane } from '../src/geo.js';
import {
  BOAT_GAP_METRES, BOAT_LIFE_RADIUS, BOAT_MIN_METRES, BOAT_SPEED_METRES_PER_SECOND, BOAT_WANDER_METRES,
  HULL_LENGTH_METRES, HULL_WIDTH_METRES, boatGeometry, boatRoutes, createWaterLife, shoreMask,
} from '../src/waterlife.js';

const river = JSON.parse(readFileSync(new URL('../public/data/canton-river.geojson', import.meta.url), 'utf8')).features;
const lineOf = (boat) => boat.line.at(boat.at);

test('船沿珠江中心线走，航线是量出来的不是手放的', () => {
  const { boats } = boatRoutes(river, DEFAULT_CENTER);
  assert.ok(boats.length >= 4, `3 km 圈内的珠江上只有 ${boats.length} 条船，这条判据就没有对象`);
  // 每一条都必须在一段够长的航道上：短分汊上一闪而过的船读起来是噪声。
  for (const boat of boats) {
    assert.ok(boat.line.length >= BOAT_MIN_METRES, `${boat.osmId} 那段航道只有 ${Math.round(boat.line.length)} m`);
    const where = lineOf(boat);
    assert.ok(Math.hypot(where.x, where.y) <= BOAT_LIFE_RADIUS + 1,
      `船一出生就在 ${Math.round(Math.hypot(where.x, where.y))} m 外，超出 ${BOAT_LIFE_RADIUS} m 的圈`);
    assert.ok(Math.abs(boat.offset) <= BOAT_WANDER_METRES, `横向游移 ${boat.offset.toFixed(1)} m 比允许的还大，船会擦到岸边`);
    assert.ok(boat.speed > 0 && boat.speed < BOAT_SPEED_METRES_PER_SECOND * 2, `航速 ${boat.speed} m/s 不像珠江上的船`);
  }
  // 确定性：同一个 osmId 的同一批船，两次抽取必须逐字相同（现版与新引擎要能各跑一次对得上）。
  const again = boatRoutes(river, DEFAULT_CENTER).boats;
  assert.equal(again.length, boats.length);
  assert.deepEqual(again.map((boat) => [boat.osmId, Math.round(boat.at), boat.speed.toFixed(3), boat.offset.toFixed(3), boat.sign]),
    boats.map((boat) => [boat.osmId, Math.round(boat.at), boat.speed.toFixed(3), boat.offset.toFixed(3), boat.sign]));
  // 双向：一列火车式的同向船队是最容易露馅的画法。
  assert.ok(new Set(boats.map((boat) => boat.sign)).size === 2, '所有船都朝同一个方向走');
  // 横向偏移不能被行进方向吃掉（`agentPosition` 里那一次乘法是给车的车道用的）：跟着车那套乘，这一带的散列
  // 按步数奇偶翻符号，同一条航道上会连着出现一排横向几乎相同的船——实测第 5~9 号船的有效横向全落在
  // +23.8~+35.0 m（11 m 带宽里的连续 5 条），屏幕上就是一条直线。所以判据写成"任意一条航道上，落在
  // 15 m 横向带宽里的连续船不许超过三条"。
  const lateralOf = (boat) => boat.sign * boat.offset;
  for (const osmId of new Set(boats.map((boat) => boat.osmId))) {
    const lane = boats.filter((boat) => boat.osmId === osmId).map(lateralOf);
    if (lane.length < 5) continue;
    let longest = 0;
    for (let start = 0; start < lane.length; start += 1) {
      let end = start;
      while (end + 1 < lane.length
        && Math.max(...lane.slice(start, end + 2)) - Math.min(...lane.slice(start, end + 2)) <= 15) end += 1;
      longest = Math.max(longest, end - start + 1);
    }
    assert.ok(longest <= 3, `way ${osmId} 上有 ${longest} 条连着的船挤在 15 m 横向带宽里，江面读成一条直线：${lane.map((value) => value.toFixed(1)).join()}`);
  }
  const spread = Math.max(...boats.map(lateralOf)) - Math.min(...boats.map(lateralOf));
  assert.ok(spread > 40, `有效横向只铺开 ${Math.round(spread)} m，江面会读成一条直线`);
});

test('走满一圈也不会开出江面或圈外', () => {
  const { boats } = boatRoutes(river, DEFAULT_CENTER);
  for (const boat of boats) {
    for (let second = 0; second <= boat.line.length / boat.speed + 1; second += 37) {
      const where = boat.line.at(((boat.at + boat.speed * second * boat.sign) % boat.line.length + boat.line.length) % boat.line.length);
      const offset = boat.sign * boat.offset;
      const x = where.x + where.side.x * offset;
      const y = where.y + where.side.y * offset;
      assert.ok(Number.isFinite(x) && Number.isFinite(y), `第 ${second} 秒位置成了 NaN：${x}, ${y}`);
      assert.ok(Math.hypot(x, y) <= BOAT_LIFE_RADIUS + BOAT_WANDER_METRES,
        `走了 ${Math.round(second)} s 之后船到了 ${Math.round(Math.hypot(x, y))} m 外`);
    }
  }
});

test('只认河与运河：溪流那种一两米宽的不得放船', () => {
  const stream = { type: 'Feature', properties: { osmId: 1, waterway: 'stream' }, geometry: { type: 'LineString', coordinates: [] } };
  assert.equal(boatRoutes([stream], DEFAULT_CENTER).boats.length, 0, '溪流也被当成航道');
  const noGeometry = [{ properties: { osmId: 2, waterway: 'river' }, geometry: { type: 'Point', coordinates: [0, 0] } }];
  assert.equal(boatRoutes(noGeometry, DEFAULT_CENTER).boats.length, 0, '不是线状的要素不该产出船');
});

test('船的几何是量出来的米数，船身压在水面以下一点', () => {
  const { hull, strip } = boatGeometry();
  const box = new THREE.Box3().setFromBufferAttribute(hull.getAttribute('position'));
  assert.ok(box.min.y < 0, `船体最低点 ${box.min.y.toFixed(2)} m 在水面之上，船会像浮在贴图上的盒子`);
  assert.ok(box.max.y > 6 && box.max.y < 20, `桅顶标高 ${box.max.y.toFixed(1)} m 不像一条 46 m 的游船`);
  assert.ok(Math.abs(box.max.x - box.min.x) < 12, `船宽 ${Math.abs(box.max.x - box.min.x).toFixed(1)} m 超出那条尺度`);
  assert.ok(hull.getAttribute('color'), '船身没有顶点色，白天会是一整块材质色');
  const stripBox = new THREE.Box3().setFromBufferAttribute(strip.getAttribute('position'));
  assert.ok(stripBox.min.y > 0, '窗带沉到水里了');
  hull.dispose();
  strip.dispose();
});

test('江面那一组挂得上、停得下、关得掉灯', () => {
  const life = createWaterLife({ features: river, origin: DEFAULT_CENTER });
  const names = life.group.children.map((mesh) => mesh.name);
  assert.deepEqual(names, ['water-boats', 'water-lights'], '江面这一组该有的两张网不对');
  assert.equal(life.counts.boats, life.group.children[0].count, '报的船数与真正提交的实例数不是一个');
  assert.equal(life.parts().lights.visible, false, '白天不该亮着窗带');
  const matrixOf = (index) => {
    const matrix = new THREE.Matrix4();
    life.group.children[0].getMatrixAt(index, matrix);
    return matrix;
  };
  const before = matrixOf(0);
  life.advance(120);
  const after = matrixOf(0);
  const moved = new THREE.Vector3().setFromMatrixPosition(after).sub(new THREE.Vector3().setFromMatrixPosition(before)).length();
  assert.ok(moved > 1, `走了 120 s，船只挪了 ${moved.toFixed(2)} m`);
  assert.ok(moved <= 120 * BOAT_SPEED_METRES_PER_SECOND * 1.6 + 1,
    `120 s 走了 ${moved.toFixed(1)} m，比最高允许航速还快`);
  // 两条渲染路径递进来的是 `motion.life / 1000` 这一把绝对读数，所以同一秒数重放两次必须还站在 120 s。
  // 把它当增量累加的话，每帧都再乘一次时长：船在江上乱跳，而且关动效也回不到出厂帧。
  const at120 = [...matrixOf(0).elements];
  life.advance(120);
  assert.deepEqual(matrixOf(0).elements.map((value) => value.toFixed(6)), at120.map((value) => value.toFixed(6)),
    '同一个秒数重放一次船就又多走了一段：绝对时长被当成增量累加了');
  life.advance(0);
  assert.deepEqual(matrixOf(0).elements.map((value) => value.toFixed(6)), [...before.elements].map((value) => value.toFixed(6)),
    '递回 0 秒就是出厂帧，船必须站在原位');
  life.setLit(true);
  assert.equal(life.parts().lights.visible, true, '夜景里窗带没亮');
  assert.equal(life.parts().lights.opacity, 1);
  life.setLit(false);
  assert.equal(life.parts().lights.visible, false, '关掉夜景之后窗带还亮着');
  assert.ok(life.reach() > 0 && life.reach() <= BOAT_LIFE_RADIUS, `reach 报的是 ${life.reach()}`);
  life.dispose();
});

test('间隔与游移确实来自散列，不是等距的珠子', () => {
  const { boats } = boatRoutes(river, DEFAULT_CENTER);
  assert.ok(new Set(boats.map((boat) => boat.offset.toFixed(2))).size > 2,
    `所有船的横向偏移都是同一个数：${[...new Set(boats.map((boat) => boat.offset))].join()}`);
  assert.ok(new Set(boats.map((boat) => boat.speed.toFixed(3))).size > 2,
    '所有船同一个航速，说明散列没接上');
  assert.ok(BOAT_GAP_METRES > 200, '间隔小到会让一条航道上排满船');
});

// 现版与新引擎读的是同一份中心线：这里钉住"那条线确实在快照里、且量出来是米制平面"。
test('珠江中心线在快照里就是可跑的航道，不是两个点的示意', () => {
  const long = river.filter((feature) => feature.geometry?.type === 'LineString' && feature.geometry.coordinates.length >= 6);
  assert.ok(long.length >= 1, `中心线里没有一条顶点够多的：最长的是 ${Math.max(...river.map((f) => f.geometry.coordinates.length))} 个点`);
  const { boats } = boatRoutes(long, DEFAULT_CENTER);
  assert.ok(boats.length >= 3, '只给真航道也放不出三条船');
  for (const point of boats[0].line.points) {
    assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y), `航道点不是米制平面：${JSON.stringify(point)}`);
    assert.ok(Math.abs(point.x) < 5000 && Math.abs(point.y) < 5000, `${JSON.stringify(point)} 不在 3 km 圈内的米制里`);
  }
});

// 船不许上岸：把 `canton-water.geojson` 那 41 片水面投进塔那套米制系，每条船走满一圈逐个采样点都必须还泡在
// 某一片水里。这一条钉的是横向游移那一档：±12 m 时 18 条船在 16.2 级排成一条直线（截图量到的），上限放宽到
// ±55 m 之后二沙岛北支那条窄汊会擦岸，所以每条船实际拿到的数由岸线夹出来。判据用的是测试自己投影的水面，
// 不是 `shoreMask`——两处同一份实现的话，岸线读错了两边一起错。
test('船始终在水里：横向游移的上限由岸线夹，不是由注释定', () => {
  const water = JSON.parse(readFileSync(new URL('../public/data/canton-water.geojson', import.meta.url), 'utf8')).features;
  const inside = (ring, x, y) => {
    let hit = false;
    for (let index = 0, prev = ring.length - 1; index < ring.length; prev = index++) {
      const [ax, ay] = ring[index];
      const [bx, by] = ring[prev];
      if ((ay > y) !== (by > y) && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) hit = !hit;
    }
    return hit;
  };
  const polygons = water
    .filter((feature) => feature.geometry?.type === 'Polygon')
    .map((feature) => feature.geometry.coordinates.map((ring) => ring.map(([lng, lat]) => {
      const { dx, dy } = plane(DEFAULT_CENTER, { lng, lat });
      return [dx, dy];
    })));
  assert.ok(polygons.length >= 20, `水面只有 ${polygons.length} 片，这条判据没有对象`);
  const inWater = (x, y) => polygons.some((poly) => inside(poly[0], x, y) && !poly.slice(1).some((hole) => inside(hole, x, y)));

  // 界面真正用的那一份判定（`shoreMask`）必须与这里独立算出来的逐点一致，否则上面那条判据量的是测试自己的实现。
  // 按 100 m 的格子扫整个圈，并且数出其中落在"洞里"（江心的岛：41 片水面里 7 片带洞，二沙岛与海心沙都在其中）
  // 的格子——没有这一句，把洞那一半实现删掉也不会红，而船开到岛上正是这一格要防的事。
  const mask = shoreMask(water, DEFAULT_CENTER);
  assert.equal(mask(0, 0), false, '广州塔脚那一点是地面，判成水里说明岸线反了');
  assert.equal(mask(0, 316), true, '塔前面那条主航道判成了岸上');
  let islands = 0;
  for (let x = -2200; x <= 2200; x += 100) {
    for (let y = -2200; y <= 2200; y += 100) {
      assert.equal(mask(x, y), inWater(x, y), `(${x}, ${y}) m 两处判定不一致`);
      if (polygons.some((poly) => inside(poly[0], x, y) && poly.slice(1).some((hole) => inside(hole, x, y)))) islands += 1;
    }
  }
  assert.ok(islands > 0, '格子里一个江心岛都没扫到，上面那句一致性没量到洞那一半');

  const { boats } = boatRoutes(river, DEFAULT_CENTER, BOAT_LIFE_RADIUS, inWater);
  let samples = 0;
  let strays = 0;
  let worst = null;
  for (const boat of boats) {
    for (let second = 0; second < boat.line.length / boat.speed; second += 7) {
      const where = agentPosition(boat, second);
      samples += 1;
      if (!inWater(where.x, where.y)) {
        strays += 1;
        if (!worst) worst = { osmId: boat.osmId, second: Math.round(second), x: Math.round(where.x), y: Math.round(where.y), offset: boat.offset.toFixed(1) };
      }
    }
  }
  assert.ok(samples > 3000, `只采了 ${samples} 个点，这条判据没有对象`);
  assert.equal(strays, 0, `${strays} / ${samples} 个采样点不在任何一片水面里，第一个是 ${JSON.stringify(worst)}`);
  // 夹岸真的动过手，而且没把所有人夹回一条线上：窄汊要有船被夹小，宽航道要有船仍然拿到 >20 m。
  assert.ok(boats.some((boat) => Math.abs(boat.offset) < BOAT_WANDER_METRES - 1), '没有一条船被岸线夹过，fitShore 没接上');
  assert.ok(Math.max(...boats.map((boat) => Math.abs(boat.offset))) > 20,
    `所有船的横向游移都被夹成 ${Math.max(...boats.map((boat) => Math.abs(boat.offset))).toFixed(1)} m 以下，江面会重新排成一条直线`);
});

// 船头必须朝着它开走的方向（用户 2026-10-09：「游轮的移动方向错了，怎么横着移动」）。
// 这条判据存在的理由就是它当时为 0：长轴在几何里走 z，而 `atan2(dir.y, dir.x)` 那套旋转是给"车头朝 +x"的
// 车用的，直接抄过来船就横在航道上——量到的点积正好 0.000。
test('船头朝着航道的走法，长轴不许横在江面上', () => {
  const life = createWaterLife({ features: river, origin: DEFAULT_CENTER });
  const hulls = life.group.children.find((mesh) => mesh.name === 'water-boats');
  const { boats } = boatRoutes(river, DEFAULT_CENTER);
  assert.equal(hulls.count, boats.length, '一条船一个实例，先对上数');
  const matrix = new THREE.Matrix4();
  const shift = new THREE.Vector3();
  const spin = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  boats.forEach((boat, index) => {
    hulls.getMatrixAt(index, matrix);
    matrix.decompose(shift, spin, scale);
    const bow = new THREE.Vector3(0, 0, 1).applyQuaternion(spin);
    const where = agentPosition(boat, 0);
    const forward = new THREE.Vector3(where.dir.x, 0, -where.dir.y).normalize();
    const dot = bow.dot(forward);
    // `dir` 本身就是"这一步要走去的方向"（含上行/下行的符号），所以点积接近 1 同时证了两件事：
    // 长轴没有横在航道上，船头也没有倒着开。
    assert.ok(dot > 0.999, `#${index}（way ${boat.osmId}，${boat.sign > 0 ? '上行' : '下行'}）的船头与前进方向差 ${Math.round(Math.acos(Math.min(1, dot)) * 180 / Math.PI)}°`);
  });
  // 再走 60 s 重排一次，仍然要对得上：这条查的是"每次 `place()` 都用了同一个朝向"，不是一次装配的巧合。
  life.advance(60);
  boats.forEach((boat, index) => {
    hulls.getMatrixAt(index, matrix);
    matrix.decompose(shift, spin, scale);
    const bow = new THREE.Vector3(0, 0, 1).applyQuaternion(spin);
    const where = agentPosition(boat, 60);
    const dot = bow.dot(new THREE.Vector3(where.dir.x, 0, -where.dir.y).normalize());
    assert.ok(dot > 0.999, `走了 60 s 之后 #${index} 的船头歪了 ${Math.round(Math.acos(Math.min(1, dot)) * 180 / Math.PI)}°`);
  });
  // 船头是切出来的：整体仍然是 46 m，而最前面那一截要比船身窄——40 px 里能分出头尾，人才读得出它在往前走。
  const { hull } = boatGeometry();
  const position = hull.getAttribute('position');
  const box = new THREE.Box3().setFromBufferAttribute(position);
  assert.ok(Math.abs((box.max.z - box.min.z) - HULL_LENGTH_METRES) < 0.5,
    `整船长 ${(box.max.z - box.min.z).toFixed(1)} m，不是表的 ${HULL_LENGTH_METRES} m`);
  const beamAt = (z) => {
    const across = Array.from({ length: position.count }, (_, i) => i)
      .filter((i) => position.getZ(i) > z).map((i) => Math.abs(position.getX(i)));
    return across.length ? Math.max(...across) * 2 : 0;
  };
  const midships = beamAt(0);
  assert.ok(Math.abs(midships - HULL_WIDTH_METRES) < 0.5, `船身中段 ${midships.toFixed(1)} m，不是 ${HULL_WIDTH_METRES} m 宽`);
  // 船头得真的收成一个尖：最前 30 cm 里不能有半根船宽的顶点。方盒子（没船头）在这里是 9 m，直接红
  // （注入过：把五边形的尖端改成平头，当场报 `最前面 30 cm 还有 9.0 m 宽`）。
  assert.ok(beamAt(box.max.z - 0.3) < 0.5, `最前面 30 cm 还有 ${beamAt(box.max.z - 0.3).toFixed(1)} m 宽，那是个方盒子不是船头`);
  assert.ok(Math.abs(box.min.z + HULL_LENGTH_METRES / 2) < 0.5, '船尾被船头那一端顶没了，整条船会往前挪半截');
  hull.dispose();
  life.dispose();
});
