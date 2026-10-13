import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import {
  AVENUES, CANOPY_COLOURS, CANOPY_RADIUS_METRES, GREEN_DENSITY, SPECIES, SPECIES_INTERPLANT, SPECIES_LABEL, SPECIES_MIX,
  SPECIES_SHAPE, TREE_GAP_METRES, TREE_MIN_SEPARATION_METRES,
  TREE_MIN_ZOOM, TREE_OFFSET_METRES, TREE_PAD_SHARE, TREE_SCALE_FROM, TREE_SCALE_TO, TRUNK_METRES,
  VEGETATION_RADIUS, avenueTrees, canopyTrees,
  createVegetation, crownGeometry, faceBlocker, insidePolygonRing, thinCloseTrees, treePlaces, speciesOf, trunkGeometry,
} from '../src/vegetation.js';
import { PAD_LIFT_METRES } from '../src/shadow-pads.js';
import { SCENE } from '../src/config.js';
import { carvePlaza, stoneRings } from '../src/plaza.js';
import { plane } from '../src/geo.js';

const streets = JSON.parse(readFileSync(new URL('../public/data/canton-streets.geojson', import.meta.url), 'utf8')).features;
const greens = JSON.parse(readFileSync(new URL('../public/data/canton-greens.geojson', import.meta.url), 'utf8')).features;
const water = JSON.parse(readFileSync(new URL('../public/data/canton-water.geojson', import.meta.url), 'utf8')).features;
const buildings = JSON.parse(readFileSync(new URL('../public/data/canton-buildings.geojson', import.meta.url), 'utf8')).features;
const origin = SCENE.center;
const METRES_X = Math.cos(origin.lat * Math.PI / 180) * 111320;

// 实例矩阵存的是 Float32，所以比坐标要用存储自己的容差（与 `traffic-life.test.js` 里 `within` 同一个口径）。
const within = (actual, expected, label, epsilon = 1e-5) => {
  assert.ok(Math.abs(actual - expected) < epsilon, `${label}：${actual} 与 ${expected} 差过 ${epsilon}`);
};

/** 场景中心的米制坐标（+x 东、+y 北）写回一个 GeoJSON 点。 */
const at = (x, y) => [origin.lng + x / METRES_X, origin.lat + y / 110570];

/** 一个以 `origin` 为中心、边长 `metres` 的正方形绿地，可带若干正方形洞。 */
const square = (osmId, kind, metres, holes = []) => {
  const ring = (half, sign) => [[-half, -half], [half, -half], [half, half], [-half, half], [-half, -half]]
    .map(([x, y]) => at(sign * x, sign * y));
  return {
    type: 'Feature',
    properties: { osmId, kind, area: metres * metres },
    geometry: {
      type: 'Polygon',
      coordinates: [ring(metres / 2, 1), ...holes.map(([x, y, half]) => {
        const centre = at(x, y);
        return [[centre[0] - half / METRES_X, centre[1] - half / 110570], [centre[0] + half / METRES_X, centre[1] - half / 110570],
          [centre[0] + half / METRES_X, centre[1] + half / 110570], [centre[0] - half / METRES_X, centre[1] + half / 110570],
          [centre[0] - half / METRES_X, centre[1] - half / 110570]];
      })],
    },
  };
};

/** 一条沿经线方向、从 `fromY` 到 `toY`（米）的路。 */
const road = (osmId, kind, fromY, toY, x = 0) => ({
  type: 'Feature',
  properties: { osmId, class: kind, carriageway: true, brunnel: null },
  geometry: { type: 'LineString', coordinates: [at(x, fromY), at(x, toY)] },
});

test('一个环在不在里面是射线法，洞不算里面', () => {
  const ring = [[-10, -10], [10, -10], [10, 10], [-10, 10]];
  assert.ok(insidePolygonRing(ring, 0, 0), '中心点被判成环外');
  assert.ok(!insidePolygonRing(ring, 11, 0), '环外 1 m 被判成环内');
  assert.ok(!insidePolygonRing(ring, -11, 0), '另一侧环外也被判成环内');
});

test('行道树只走点名的那两级路，两侧各一排，间距是那个常量', () => {
  const features = [
    road(1, AVENUES[1], 0, 900),
    road(2, 'service', 0, 900),
    { ...road(3, AVENUES[0], 0, 900), properties: { osmId: 3, class: AVENUES[0], carriageway: true, brunnel: 'tunnel' } },
  ];
  const trees = avenueTrees(features, origin, 1000);
  assert.ok(trees.length > 40, `一条 900 m 的大路只放出 ${trees.length} 株`);
  assert.ok(trees.every((tree) => tree.kind === 'roadside'), '行道树该有自己的种类名');
  // 两侧各一排：同一株的位置关于中线对称，所以偏移量的绝对值恒等于那个常量。
  for (const tree of trees) {
    const across = Math.abs(tree.x);
    assert.ok(Math.abs(across - TREE_OFFSET_METRES) < 0.01,
      `一株树离中线 ${across.toFixed(2)} m，不是 ${TREE_OFFSET_METRES} m`);
  }
  // 只看一侧：两侧是同一串步距的镜像，混在一起量会把成对的位置当成"零步距"。
  const side = trees.filter((tree) => tree.x > 0).map((tree) => tree.y).sort((a, b) => a - b);
  const steps = side.slice(1).map((y, index) => y - side[index]);
  assert.ok(steps.length > 20, `这条路的单侧只有 ${steps.length + 1} 株，量不出间距`);
  // 抖动 ±40%，所以一步落在 0.6~1.4 倍之间；步数几乎全是整数间距，就是抖动没接上。
  const varied = steps.filter((step) => Math.abs(step - TREE_GAP_METRES) > 0.01).length;
  assert.ok(varied > steps.length * 0.8, `${steps.length} 步里只有 ${varied} 步不是整数间距，抖动没生效`);
  for (const step of steps) {
    assert.ok(step > TREE_GAP_METRES * 0.55 && step < TREE_GAP_METRES * 1.45, `一步 ${step.toFixed(2)} m，跳出抖动范围了`);
  }
});

test('行道树不出那一公里，也不从隧道里长出来', () => {
  const far = avenueTrees([road(9, AVENUES[0], 1200, 2400)], origin, VEGETATION_RADIUS);
  assert.equal(far.length, 0, '圆外的大路不该有树');
  const ring = avenueTrees([road(8, AVENUES[0], 940, 995)], origin, VEGETATION_RADIUS);
  assert.ok(ring.length > 0, '贴着圆内侧的一段该有树，否则裁得太狠');
  assert.ok(ring.every((tree) => Math.hypot(tree.x, tree.y) <= VEGETATION_RADIUS),
    '中线被裁过，树线却探到了圆外');
});

test('树冠按面积出株数，洞与圆外都不站树，且同一份快照重跑一株都不挪', () => {
  const park = square(11, 'park', 400);
  const once = canopyTrees([park], origin, VEGETATION_RADIUS);
  const twice = canopyTrees([park], origin, VEGETATION_RADIUS);
  // 面积是从环上算的（米↔度折回来有零点几的差），所以按 1% 容差比，而不是逐株相等。
  assert.ok(Math.abs(once.length - 400 * 400 / GREEN_DENSITY.park) <= 400 * 400 / GREEN_DENSITY.park * 0.01 + 1,
    `株数 ${once.length} 不等于面积除以密度（该在 ${400 * 400 / GREEN_DENSITY.park} 附近）`);
  assert.deepEqual(twice, once, '同一份输入两次结果不一样，那是随机而不是可复现');
  assert.ok(once.every((tree) => Math.abs(tree.x) < 200 && Math.abs(tree.y) < 200), '一株跑到了面外');
  const lake = canopyTrees([square(12, 'park', 400, [[0, 0, 60]])], origin, VEGETATION_RADIUS);
  assert.ok(lake.length > once.length * 0.5, `挖了个洞就只放出 ${lake.length} 株，配额被洞吃掉了`);
  assert.ok(lake.every((tree) => Math.abs(tree.x) > 60 || Math.abs(tree.y) > 60), '湖中间长了树');
  assert.equal(canopyTrees([square(13, 'pitch', 400)], origin, VEGETATION_RADIUS).length, 0, '足球场不该有树冠');
  const edge = canopyTrees([square(14, 'wood', 300)], at(0, -2200).reverse() && { lng: at(0, -2200)[0], lat: at(0, -2200)[1] }, VEGETATION_RADIUS);
  assert.ok(edge.every((tree) => Math.hypot(tree.x, tree.y) <= VEGETATION_RADIUS), '圆外的绿地探进来了');
});

test('真实快照的这一公里里，两类树都站得住，且一个位置不重复', () => {
  const places = treePlaces({ streets, greens, origin });
  assert.ok(places.roadside.length > 500, `行道树只有 ${places.roadside.length} 株，路网没接上`);
  assert.ok(places.canopy.length > 500, `树冠只有 ${places.canopy.length} 株，绿地没接上`);
  const all = [...places.roadside, ...places.canopy];
  assert.ok(all.every((tree) => Math.hypot(tree.x, tree.y) <= VEGETATION_RADIUS + 1e-6), '有树站在那一公里之外');
  assert.equal(new Set(all.map((tree) => `${tree.x.toFixed(3)},${tree.y.toFixed(3)}`)).size, all.length, '两株树站在同一个点上');
  const kinds = new Set(places.canopy.map((tree) => tree.kind));
  assert.deepEqual([...kinds].sort(), [...kinds].sort().filter((kind) => kind in GREEN_DENSITY), '冒出了没在密度表里的绿地');
});

// 用户 2026-10-09 拿截图说「植被树那些有点太多太乱，不符合实际」。最扎眼的一条就是桥两侧在江里各排了一行树：
// 路被桥带着跨江，行道树按"路中线两侧 8.6 m"放，就跟着放到了水面上。桥上根本没有树池。
test('桥上与高架上的路不放行道树，地面同一条路照放', () => {
  const bridge = { ...road(4, AVENUES[0], -300, 300), properties: { osmId: 4, class: AVENUES[0], brunnel: 'bridge', layer: 1 } };
  const ramp = { ...road(5, AVENUES[0], -300, 300), properties: { osmId: 5, class: AVENUES[0], brunnel: null, layer: 2 } };
  assert.equal(avenueTrees([bridge], origin, 1000).length, 0, '跨江的桥上排了行道树');
  assert.equal(avenueTrees([ramp], origin, 1000).length, 0, 'layer=2 的高架也排了行道树');
  // 反例必须同时成立，否则上面两句只是"根本没放树"。
  assert.ok(avenueTrees([road(6, AVENUES[0], -300, 300)], origin, 1000).length > 20, '地面同一条路也没树了，那前两句是空的');
});

// 水面与楼块是第二道让位：绿地面自己不会盖到江里，但一块 `leisure=park` 可以贴着河岸把树送进水里。
test('树不站在水里也不站在楼里，挤在一起的只留一棵', () => {
  const blocker = faceBlocker([square(21, 'water', 400)], origin, 1000);
  assert.equal(blocker(0, 0), true, '一块 400 m 见方的水面，正中判成了岸上');
  assert.equal(blocker(400, 0), false, '水面之外 100 m 判成了水里');
  const masked = canopyTrees([square(22, 'park', 400)], origin, 1000, GREEN_DENSITY, [], blocker);
  assert.equal(masked.length, 0, '整块绿地都在水面里，株数却没被让位掉');
  assert.ok(canopyTrees([square(22, 'park', 400)], origin, 1000).length > 100, '反例：不给让位名单时这块绿地该出树');

  // 出厂数据这一侧的账：不传水面与楼块就会量到"水里的树"，传进去一株都不剩。
  const inFaces = (faces, tree) => faces.some((feature) => {
    const polygons = feature.geometry?.type === 'Polygon' ? [feature.geometry.coordinates]
      : feature.geometry?.type === 'MultiPolygon' ? feature.geometry.coordinates : [];
    return polygons.some((polygon) => {
      const rings = polygon.map((ring) => ring.map(([lng, lat]) => {
        const { dx, dy } = plane(origin, { lng, lat });
        return [dx, dy];
      }));
      return insidePolygonRing(rings[0], tree.x, tree.y)
        && !rings.slice(1).some((hole) => insidePolygonRing(hole, tree.x, tree.y));
    });
  });
  const naked = treePlaces({ streets, greens, origin, radius: VEGETATION_RADIUS });
  const guarded = treePlaces({ streets, greens, origin, radius: VEGETATION_RADIUS, water, buildings });
  const strays = [...naked.roadside, ...naked.canopy].filter((tree) => inFaces(water, tree)).length;
  assert.ok(strays > 0, `这份快照量不出"水里的树"（${strays} 株），那下面那句 0 就是永真`);
  const kept = [...guarded.roadside, ...guarded.canopy];
  assert.equal(kept.filter((tree) => inFaces(water, tree)).length, 0, `${strays} 株水里的树没被挡掉`);
  assert.equal(kept.filter((tree) => inFaces(buildings.filter((feature) => ['Polygon', 'MultiPolygon'].includes(feature.geometry?.type)), tree)).length, 0,
    '树长在别人家屋顶上');
  // 最小间距：冠径 6 m，站得比 5 m 更近就是一坨。对象要从**没去重之前**的那一批里量——`treePlaces` 出来的
  // 已经筛过，拿它自己当分母就是永真。
  const crowded = [...avenueTrees(streets, origin, VEGETATION_RADIUS), ...canopyTrees(greens, origin, VEGETATION_RADIUS)];
  const close = (trees) => {
    let pairs = 0;
    for (let i = 0; i < trees.length; i += 1) {
      for (let j = i + 1; j < trees.length; j += 1) {
        const dx = trees[j].x - trees[i].x;
        const dy = trees[j].y - trees[i].y;
        if (dx * dx + dy * dy < TREE_MIN_SEPARATION_METRES * TREE_MIN_SEPARATION_METRES) pairs += 1;
      }
    }
    return pairs;
  };
  assert.ok(close(crowded) > 0, `没去重的 ${crowded.length} 株里一对 <${TREE_MIN_SEPARATION_METRES} m 的都没有，这条判据没有对象`);
  assert.equal(close(kept), 0, `去重之后还留着 ${close(kept)} 对挤在一起的树`);
  assert.ok(kept.length < crowded.length, `去重一株都没去掉（${kept.length} / ${crowded.length}），那是没接上`);
  assert.ok(kept.length > 1500, `去重之后只剩 ${kept.length} 株，这一公里要空了`);
  assert.deepEqual(treePlaces({ streets, greens, origin, radius: VEGETATION_RADIUS, water, buildings }), guarded,
    '同一份输入重跑一次树变了：去重用了不稳定的顺序');
});

// 三种树要读得出是三种树：冠都压进干顶（不留缝），三个身形两两不同——只换三个颜色过不了这一条。
test('三种剪影各自立得住：冠坐在干顶上，身形两两不同', () => {
  const read = (species) => {
    const trunk = trunkGeometry(species);
    const crown = crownGeometry(species);
    trunk.computeBoundingBox();
    crown.computeBoundingBox();
    const t = trunk.boundingBox;
    const c = crown.boundingBox;
    return {
      trunkBottom: t.min.y,
      trunkTop: t.max.y,
      trunkHalf: Math.max(Math.abs(t.min.x), Math.abs(t.max.x)),
      crownBottom: c.min.y,
      crownTop: c.max.y,
      crownHalf: Math.max(Math.abs(c.min.x), Math.abs(c.max.x), Math.abs(c.min.z), Math.abs(c.max.z)),
      faces: crown.getAttribute('position').count / 3,
      indexed: crown.index !== null,
    };
  };
  const shape = Object.fromEntries(SPECIES.map((species) => [species, read(species)]));
  for (const species of SPECIES) {
    const tree = shape[species];
    const label = SPECIES_LABEL[species];
    // 干高就是名单乘 `TRUNK_METRES` 的那个数：这一句钉"名单真的接到了几何上"。
    within(tree.trunkTop, TRUNK_METRES * SPECIES_SHAPE[species].trunk.height, `${label}的干不是名单点名的那个高度`);
    assert.ok(Math.abs(tree.trunkBottom) < 1e-6, `${label}的干没坐在地上`);
    assert.ok(tree.crownBottom < tree.trunkTop, `${label}的冠悬在干顶之上，中间会露出一截`);
    assert.ok(tree.crownTop > tree.trunkTop, `${label}的冠没高过干顶，读不出一棵树`);
    // 多面体几何本来就是"一面一份顶点"，再 toNonIndexed 一次会在每次载入时留一条控制台警告。
    assert.equal(tree.indexed, false, `${label}的冠被二次去索引了`);
  }
  // 榕：一把伞——冠比它自己高还宽，干又是三种里最矮最粗的。
  assert.ok(shape.banyan.crownHalf * 2 > shape.banyan.crownTop - shape.banyan.crownBottom, '榕不是一把伞：冠没有比它自己的冠高更宽');
  assert.ok(shape.banyan.trunkTop < shape.camphor.trunkTop, '榕的干不该比香樟高');
  // 香樟：一枚立起来的卵——冠高过自己的宽度，而且是三种里最高的一株。
  assert.ok(shape.camphor.crownTop - shape.camphor.crownBottom > shape.camphor.crownHalf * 2, '香樟不是卵：冠比它自己宽');
  assert.ok(shape.camphor.crownTop > shape.banyan.crownTop && shape.camphor.crownTop > shape.palm.crownTop, '香樟该是三种里最高的那一株');
  // 棕榈：一根杆子顶上一圈叶——净干比整圈叶高的两倍还多，叶圈比榕的穹顶还薄。
  assert.ok(shape.palm.trunkTop > 2 * (shape.palm.crownTop - shape.palm.crownBottom), '棕榈的净干不到叶圈高度的两倍，读不出是一根杆子');
  assert.ok(shape.palm.crownTop - shape.palm.crownBottom < shape.banyan.crownTop - shape.banyan.crownBottom, '棕榈的叶圈比榕的穹顶还厚');
  assert.ok(shape.palm.trunkHalf < shape.camphor.trunkHalf && shape.camphor.trunkHalf < shape.banyan.trunkHalf, '三种树的干粗细没有拉开');
  // 整株顶高两两差一米以上：挤在同一个高度上就是一顶冠换了三个颜色。
  const tops = SPECIES.map((species) => shape[species].crownTop);
  const apart = tops.flatMap((height, index) => tops.slice(index + 1).map((other) => Math.abs(height - other)));
  assert.ok(Math.min(...apart) > 1, `三者的整株顶高只差 ${Math.min(...apart).toFixed(2)} m`);
  // 几何的面数就是点名的那些数：穹顶恒是二十面体那 20 面，棕榈的叶一圈要 9 片、每片两个四边形。
  // 两句分开钉：只写"面数 = 名单张数 × 4"的话，把名单从 9 改成 7 两边一起变，抓不到少画了一片叶。
  assert.equal(SPECIES_SHAPE.palm.crown.fronds, 9, '棕榈的叶圈不是点名那 9 片');
  assert.equal(shape.palm.faces, 36, '棕榈的叶几何不是 9 片 × 每片两个四边形');
  assert.equal(SPECIES_SHAPE.banyan.crown.lobes, 3, '榕的冠不是点名那三块穹顶');
  assert.equal(shape.banyan.faces, 60, '榕的冠不是 3 块 × 每块二十面体 20 面');
  assert.equal(shape.camphor.faces, 20, '香樟该是一整顶卵，不是叠出来的');
});

test('每种树的名单只点名存在的三种、加起来是 1，身形与中文名一格不缺', () => {
  for (const [kind, mix] of Object.entries(SPECIES_MIX)) {
    assert.deepEqual(Object.keys(mix).sort(), [...SPECIES].sort(), `${kind} 的名单与 \`SPECIES\` 不同名`);
    const total = SPECIES.reduce((sum, species) => sum + mix[species], 0);
    assert.ok(Math.abs(total - 1) < 1e-9, `${kind} 的名单加起来是 ${total}，不是 1`);
  }
  for (const species of SPECIES) {
    assert.ok(SPECIES_SHAPE[species]?.trunk && SPECIES_SHAPE[species]?.crown, `${species} 没有身形`);
    assert.ok(SPECIES_LABEL[species], `${species} 没有中文名，卡片上写不出来`);
  }
  // 棕榈在名单里给了三种绿地，但林地那一格是 0——上一句"加起来是 1"证不了这一格真的是 0。
  assert.equal(SPECIES_MIX.wood.palm, 0, '林地的名单没给棕榈记 0');
  assert.ok(SPECIES_MIX.grass.palm > 0.3, '草坪的名单不该把棕榈压到抽不出来');
});

// 同一条路栽同一种苗是"行道树"读得出来的前提：用户 2026-10-09 那句"太多太乱"里就包括一路换三种树。
test('一种树归一条街：主种压倒性、街与街各不同，林地里没有棕榈', () => {
  const count = (trees) => trees.reduce((row, tree) => {
    const species = speciesOf(tree);
    return { ...row, [species]: (row[species] ?? 0) + 1 };
  }, {});
  const road101 = count(avenueTrees([road(101, AVENUES[0], -600, 600)], origin, 1000));
  const total = SPECIES.reduce((sum, species) => sum + (road101[species] ?? 0), 0);
  assert.ok(total > 100, `一条 1.2 km 的路只放出 ${total} 株，量不出配比`);
  const dominant = SPECIES.reduce((best, species) => ((road101[species] ?? 0) > (road101[best] ?? 0) ? species : best), SPECIES[0]);
  // 一条街只许 `SPECIES_INTERPLANT` 那一成换种；实测这一条 0.86，逐株随机只会得到 0.5。
  assert.ok((road101[dominant] ?? 0) / total > 1 - SPECIES_INTERPLANT,
    `一条街里主种只占 ${(100 * (road101[dominant] ?? 0) / total).toFixed(0)}%，那是逐株随机而不是一路一种`);
  // 反例：整条网络的主种三种都上得了路，否则上一句只是"根本没换过种"。
  const byStreet = (features) => {
    const rows = new Map();
    for (const tree of avenueTrees(features, origin, VEGETATION_RADIUS)) {
      if (!rows.has(tree.patch)) rows.set(tree.patch, []);
      rows.get(tree.patch).push(tree);
    }
    return new Map([...rows].map(([patch, list]) => [patch, count(list)]));
  };
  const patches = byStreet(streets);
  assert.ok(patches.size > 50, `只量到 ${patches.size} 条路，配比没有对象`);
  const dominants = new Set([...patches.values()].map((row) => SPECIES.reduce((best, species) => ((row[species] ?? 0) > (row[best] ?? 0) ? species : best), SPECIES[0])));
  assert.equal(dominants.size, SPECIES.length, `这些街的主种只有 ${[...dominants].join('/')}，三种没有都上路`);
  // 同一份输入重跑：一株都不换种（`patch` 带着 osmId，随机数没有第二次掷骰）。
  assert.deepEqual([...byStreet(streets).values()], [...patches.values()], '刷新一次页面，某条路的树换了种');

  const greenery = createVegetation({ streets, greens, origin });
  assert.ok(greenery.report.byKind.wood > 20, `林地一共 ${greenery.report.byKind.wood} 株，下面两句是空的`);
  assert.equal(greenery.report.speciesByKind.wood.palm, undefined, '密冠里插了一根光杆：林地里长出了棕榈');
  assert.ok((greenery.report.speciesByKind.grass.palm ?? 0) > 5, '草坪里一株棕榈都没有，那是抽签抽不到别种而不是名单给了 0');
  const againScene = createVegetation({ streets, greens, origin });
  assert.deepEqual(againScene.report.speciesByKind, greenery.report.speciesByKind, '刷新一次页面，哪块绿地种什么变了');
  for (const body of [greenery, againScene]) body.dispose();
});

test('三种树各一份干一份冠，影子那一份仍按位置配到每一株脚下', () => {
  const places = treePlaces({ streets, greens, origin });
  const greenery = createVegetation({ streets, greens, origin });
  const meshes = greenery.group.children;
  assert.deepEqual(meshes.map((mesh) => mesh.name), [
    'vegetation-banyan-trunks', 'vegetation-banyan-crowns',
    'vegetation-camphor-trunks', 'vegetation-camphor-crowns',
    'vegetation-palm-trunks', 'vegetation-palm-crowns',
    'vegetation-pads',
  ], '三种树该是六个实例网格加一片接地影，全部挂在 `vegetation` 这一组里（镜头门控与透视镜开关才跟着一起走）');
  assert.ok(meshes.every((mesh) => mesh.isInstancedMesh), '近场的树必须走实例，不然几千个网格把帧率吃掉');
  assert.equal(greenery.report.trees, places.roadside.length + places.canopy.length);
  const pads = meshes.at(-1);
  assert.equal(pads.count, greenery.report.trees, '一片影配一株树，株数必须一样');
  // 每种两份网格装的是同一批株，三份加起来等于全场：漏一株就是"这株没干"或"这株两顶冠"。
  for (const species of SPECIES) {
    const trunks = meshes.find((mesh) => mesh.name === `vegetation-${species}-trunks`);
    const crowns = meshes.find((mesh) => mesh.name === `vegetation-${species}-crowns`);
    assert.equal(trunks.count, crowns.count, `${species} 的干与冠不是同一批株`);
    assert.equal(trunks.count, greenery.report.bySpecies[species], `${species} 装的株数与报告不一致`);
    assert.ok(trunks.count > 100, `${species} 只装了 ${trunks.count} 株，这一种在画面里读不出来`);
  }
  assert.equal(SPECIES.reduce((sum, species) => sum + greenery.report.bySpecies[species], 0), greenery.report.trees,
    '三种加起来不等于全场的株数');

  const matrix = new THREE.Matrix4();
  const shift = new THREE.Vector3();
  const spin = new THREE.Quaternion();
  const size = new THREE.Vector3();
  const pose = (mesh, index) => {
    mesh.getMatrixAt(index, matrix);
    matrix.decompose(shift, spin, size);
    return { x: shift.x, y: shift.y, z: shift.z, sx: size.x, sy: size.y, sz: size.z };
  };
  const parked = new Map();
  const colour = new THREE.Color();
  const seen = new Set();
  for (const species of SPECIES) {
    const trunks = meshes.find((mesh) => mesh.name === `vegetation-${species}-trunks`);
    const crowns = meshes.find((mesh) => mesh.name === `vegetation-${species}-crowns`);
    assert.ok(crowns.instanceColor, `${species} 的冠没有逐株颜色`);
    for (let index = 0; index < trunks.count; index += 1) {
      const trunk = pose(trunks, index);
      const crown = pose(crowns, index);
      assert.equal(`${trunk.x.toFixed(4)},${trunk.z.toFixed(4)}`, `${crown.x.toFixed(4)},${crown.z.toFixed(4)}`,
        `${SPECIES_LABEL[species]}第 ${index} 株的干与冠不在同一处`);
      // 整株等比缩放：身形写在几何里，放大一株不会把它拉扁。
      assert.ok(Math.abs(trunk.sx - trunk.sy) < 1e-6 && Math.abs(trunk.sx - trunk.sz) < 1e-6,
        `${SPECIES_LABEL[species]}第 ${index} 株不是等比缩放，树会歪`);
      assert.ok(trunk.sx >= TREE_SCALE_FROM - 1e-6 && trunk.sx <= TREE_SCALE_TO + 1e-6,
        `${SPECIES_LABEL[species]}第 ${index} 株缩放了 ${trunk.sx}`);
      colour.fromArray(crowns.instanceColor.array, index * 3);
      seen.add(colour.getHexString());
      parked.set(`${trunk.x.toFixed(4)},${trunk.z.toFixed(4)}`, { species, size: trunk.sx });
    }
  }
  assert.equal(parked.size, greenery.report.trees, `六个网格的位置去重后只剩 ${parked.size} 处，两株树抢了同一个位置`);
  assert.ok(seen.size >= 2, '整片绿地一个颜色，读不出公园与林地的差别');
  for (const hex of seen) assert.ok(Object.values(CANOPY_COLOURS).some((value) => value.slice(1) === hex), `冒出一个没在色表里的 ${hex}`);

  // 影子逐片核位置与半径（配对只看位置，所以第几片排在第几株不重要；重要的是每片都在某株脚下、且半径是**那一种**的冠径折算）。
  const share = new Set();
  for (let index = 0; index < pads.count; index += 1) {
    const pad = pose(pads, index);
    const tree = parked.get(`${pad.x.toFixed(4)},${pad.z.toFixed(4)}`);
    assert.ok(tree, `第 ${index} 片影 (${pad.x.toFixed(2)}, ${pad.z.toFixed(2)}) 底下没有树`);
    assert.ok(Math.abs(pad.y - PAD_LIFT_METRES) < 1e-6, `第 ${index} 片影没贴地（y=${pad.y}），或高到飘起来了`);
    // 贴片几何是 1×1 的方形，所以实例的 scale 就是长半轴与短半轴的两倍。
    within(pad.sx, CANOPY_RADIUS_METRES * SPECIES_SHAPE[tree.species].crown.radius * tree.size * TREE_PAD_SHARE * 2,
      `#${index} 影子不是${SPECIES_LABEL[tree.species]}的冠径按 ${TREE_PAD_SHARE} 折算的那一片`);
    assert.ok(Math.abs(pad.sx - pad.sz) < 1e-5, `#${index} 的树影是椭的，可三种树的冠都是圆的`);
    share.add(tree.species);
  }
  assert.deepEqual([...share].sort(), [...SPECIES].sort(), `影子只配到 ${share.size} 种树的冠径，第三种没接上`);
  assert.ok(pads.material.opacity > 0 && pads.material.opacity <= 0.5, '一片影要么没画，要么黑成一坨');
  greenery.dispose();
  assert.equal(greenery.group.children.length, 0, 'dispose 没把网格摘下来');
});

test('石材中轴上不长树：让位名单把站错的株挪开，株数不因此变少', () => {
  const greens = JSON.parse(readFileSync(new URL('../public/data/canton-greens.geojson', import.meta.url), 'utf8')).features;
  const water = JSON.parse(readFileSync(new URL('../public/data/canton-water.geojson', import.meta.url), 'utf8')).features;
  const blocks = JSON.parse(readFileSync(new URL('../public/data/canton-blocks.geojson', import.meta.url), 'utf8')).features;
  const rings = stoneRings(carvePlaza({ greens, water, blocks, streets }));
  assert.ok(rings.length >= 4, '石材名单空了，这一发什么都没量到');
  const inMetres = rings.map((ring) => ring.map(([lng, lat]) => {
    const { dx, dy } = plane(origin, { lng, lat });
    return [dx, dy];
  }));
  const standing = (set) => set.filter((tree) => inMetres.some((ring) => insidePolygonRing(ring, tree.x, tree.y))).length;
  // 配额这一格用 `canopyTrees` 直接量：`treePlaces` 后面还接了一道最小间距去重，那一步是按位置吃树的，
  // 拿它比"株数不因此变少"会让两条规则互相遮蔽。
  const bare = canopyTrees(greens, origin, VEGETATION_RADIUS, GREEN_DENSITY, []);
  assert.ok(standing(bare) > 0, '没有一株树站在石材上，那这条让位规则是空的');
  const shy = canopyTrees(greens, origin, VEGETATION_RADIUS, GREEN_DENSITY, inMetres);
  assert.equal(standing(shy), 0, '让位之后还有树长在石板上');
  assert.equal(shy.length, bare.length, '让位把配额抽干了：面积该长的树还是得长出来');
  // 名单确实从 `treePlaces` 一路传到那一层：整场摆出来的树里也不许有站在石板上的。
  assert.equal(standing(treePlaces({ streets, greens, origin, avoid: rings }).canopy), 0, 'treePlaces 没把让位名单传下去');
});

test('镜头一拉开就把整片树收掉，透视镜也收，回来还是同一批', () => {
  const greenery = createVegetation({ streets, greens, origin });
  assert.equal(greenery.setZoom(TREE_MIN_ZOOM - 1), true, '第一次设镜头不该被当成没变');
  assert.equal(greenery.visible(), false, '拉远了还在画几千个不到两像素的树冠');
  assert.equal(greenery.setZoom(TREE_MIN_ZOOM), true);
  assert.equal(greenery.visible(), true, '到了该出现的级别却没出现');
  assert.equal(greenery.setZoom(TREE_MIN_ZOOM + 0.005), false, '半像素的抖动就重画一次');
  assert.equal(greenery.setVegetation(false), true, '透视镜该把花园收走');
  assert.equal(greenery.visible(), false, '高度分布视图里还站着一片树');
  assert.equal(greenery.setVegetation(true), true);
  assert.equal(greenery.visible(), true, '回到普通视图后没有把树还回来');
  const again = createVegetation({ streets, greens, origin });
  const a = new THREE.Matrix4();
  const b = new THREE.Matrix4();
  greenery.group.children[0].getMatrixAt(7, a);
  again.group.children[0].getMatrixAt(7, b);
  assert.deepEqual(a.elements, b.elements, '刷新一次页面，第 8 株树挪了位置');
});
