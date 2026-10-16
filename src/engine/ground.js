// V8 Phase 0-1：地面。文档要的是"水系/绿地/道路/街区地块 → ShapeGeometry 平面，z 分层抬高防 z-fighting"。
// 这一层能画什么取决于本地快照里有什么。Phase 0 只有道路与一条按实测河宽描出的示意江带；Phase 1 补了一次
// Overpass 提取（`scripts/prepare-canton-surface.mjs`），把底图那四层真几何取回本地：
//   · 水系  `canton-water.geojson`   41 面 —— **示意江带由它取代**：岸线是真的，带宽就不用猜了
//   · 绿地  `canton-greens.geojson`  272 面（公园/草地/林地/湿地/球场）
//   · 地块  `canton-blocks.geojson`  595 面（居住/学校/医院/行政/行人区）
//   · 道路  `canton-streets.geojson` 504 条 LineString，按 `class` 分级取宽
// 边界逐字取 OSM：闭合 way 成环，multipolygon 按成员 way 首尾拼接，开口的（12 条"缓跑径"跑道环）整条不取，
// 不把两端连起来、不补坐标。
import * as THREE from 'three';

// The layer cake the brief asks for, in metres above the ground plane. Everything that sits on the ground is within
// half a metre, which is far below the depth precision the camera keeps at these sight lines but well above the
// coplanar flicker two meshes at exactly y=0 would show. Every tone gets its own height: a park sharing a boundary
// with a lawn is a shared edge at the same y otherwise, and that flickers.
export const GROUND_LAYERS = { base: 0, block: 0.05, pavement: 0.06, grass: 0.12, park: 0.13, wood: 0.14, water: 0.2, road: 0.3 };

// Road carriageway widths by the class the Overpass extract carries. 示意: OSM gives no width for most of these,
// and the picture only needs the hierarchy - motorway visibly wider than a primary road.
export const ROAD_WIDTH_METRES = {
  motorway: 26, trunk: 22, primary: 18, secondary: 14, tertiary: 11,
  minor: 8, service: 5, track: 4, path: 3, pedestrian: 4, unresolved: 7,
};

export const roadWidth = (feature) => ROAD_WIDTH_METRES[feature?.properties?.class] ?? ROAD_WIDTH_METRES.unresolved;

// Which tone an OSM `kind` belongs to. Every kind the extractions carry is listed by name: an unmapped kind falling
// through to `block` would quietly paint a park in the residential tint, so `tests/engine.test.js` pins this table
// against the kinds that are actually in the files.
// 球场/跑道/湿地归草地、行人区归铺装：Liberty 给它们各有各的底色，现版色板里没有那一格，取最近的一档。
export const TONE_OF_KIND = {
  water: 'water', riverbank: 'water', basin: 'water', dock: 'water',
  park: 'park', garden: 'park', golf: 'park',
  grass: 'grass', grassland: 'grass', wetland: 'grass', pitch: 'grass', track: 'grass', cemetery: 'grass',
  wood: 'wood', forest: 'wood',
  residential: 'block', civic: 'block', school: 'block', hospital: 'block', campus: 'block',
  pedestrian: 'pavement', mountain: 'grass',
};

export const toneOf = (feature) => TONE_OF_KIND[feature?.properties?.kind] ?? null;

/**
 * A flat ribbon along a polyline: every segment becomes a quad, so a 500-line road network stays one draw call once
 * the pieces are merged. Normals point up because these are ground decals, not walls.
 */
export function ribbonGeometry(points, width, project, y = GROUND_LAYERS.road) {
  const half = width / 2;
  const positions = [];
  for (let index = 1; index < points.length; index++) {
    const from = project({ lng: points[index - 1][0], lat: points[index - 1][1] });
    const to = project({ lng: points[index][0], lat: points[index][1] });
    const dx = to.x - from.x, dz = to.z - from.z;
    const length = Math.hypot(dx, dz);
    if (!length) continue;
    // The left-hand normal in the XZ plane, scaled to the half width.
    const nx = (-dz / length) * half, nz = (dx / length) * half;
    const a = [from.x + nx, from.z + nz], b = [from.x - nx, from.z - nz];
    const c = [to.x + nx, to.z + nz], d = [to.x - nx, to.z - nz];
    positions.push(a[0], y, a[1], b[0], y, b[1], c[0], y, c[1]);
    positions.push(b[0], y, b[1], d[0], y, d[1], c[0], y, c[1]);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/** 把同色的几何并成一份：只搬 position，所以进来的必须都是非索引三角（`toNonIndexed()` 之后）。 */
export const mergePositions = (parts) => {
  const positions = [];
  for (const part of parts) {
    const array = part.getAttribute('position').array;
    for (let i = 0; i < array.length; i++) positions.push(array[i]);
    part.dispose();
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
};

// One polygon - an outer ring plus its holes - as a flat plate at `y`. `rings[0]` is the outline; the rest are holes,
// and they are real: 24 of the 41 water faces carry one, which is an island in the channel.
export function plateGeometry(rings, project, y = GROUND_LAYERS.block) {
  const toPoints = (ring) => ring.map(([lng, lat]) => {
    const point = project({ lng, lat });
    return new THREE.Vector2(point.x, -point.z);
  });
  const shape = new THREE.Shape(toPoints(rings[0]));
  for (const hole of rings.slice(1)) if (hole.length > 2) shape.holes.push(new THREE.Path(toPoints(hole)));
  // `ShapeGeometry` hands back an indexed buffer while the ribbons are raw triangles, and `merge` below only knows how
  // to concatenate positions - an index left in would be read as vertex order and paint a torn plate. De-index here so
  // every ground piece is the same kind of buffer, and a plate's vertex count is a real triangle count.
  const geometry = new THREE.ShapeGeometry(shape).toNonIndexed();
  // Shape space is XY with the ring's south axis fed in as -z, so turning it flat by -90° about X puts the ring
  // back on (x, z) with its normal pointing up; the mirror image of that turn lays the plate face down.
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, y, 0);
  return geometry;
}

/** Each polygon of a Polygon or MultiPolygon as its own array of rings (outer first, then holes). */
export const polygonsOf = (geometry) => (geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates);

/**
 * @param {{project: Function, radius: number, colors: object, streets?: object[], surfaces?: object[]}} input
 * @returns {{group: THREE.Group, report: object, dispose: Function}}
 */
export function createGround({ project, radius, colors, streets = [], surfaces = [] }) {
  const group = new THREE.Group();
  group.name = 'ground';
  const geometries = [];
  const add = (name, geometry, color) => {
    if (!geometry) return null;
    // Unlit on purpose: the map paints these as flat fills, where the hex in the palette *is* the pixel. Under a
    // Lambert material the same hex came back washed toward the sun, which is how the first Phase 1 frame ended up
    // brighter than the picture it is supposed to match. The walls keep their lighting - MapLibre lights those too.
    const material = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    geometries.push(geometry);
    group.add(mesh);
    return mesh;
  };

  const base = new THREE.CircleGeometry(radius, 96);
  base.rotateX(-Math.PI / 2);
  add('ground-base', base, colors.base);

  const report = { tones: {}, features: {}, failed: [] };
  const byTone = new Map();
  for (const feature of surfaces) {
    const tone = toneOf(feature);
    if (!tone) { report.failed.push({ osmId: feature?.properties?.osmId, kind: feature?.properties?.kind, error: 'no tone for kind' }); continue; }
    if (!byTone.has(tone)) byTone.set(tone, []);
    byTone.get(tone).push(feature);
  }
  for (const [tone, features] of byTone) {
    const parts = [];
    for (const feature of features) {
      if (feature.geometry?.type !== 'Polygon' && feature.geometry?.type !== 'MultiPolygon') {
        report.failed.push({ osmId: feature.properties.osmId, kind: feature.properties.kind, error: `不是面：${feature.geometry?.type}` });
        continue;
      }
      for (const rings of polygonsOf(feature.geometry)) {
        let plate = null;
        try { plate = plateGeometry(rings, project, GROUND_LAYERS[tone]); } catch (error) {
          report.failed.push({ osmId: feature.properties.osmId, kind: feature.properties.kind, error: error.message });
          continue;
        }
        if (plate.getAttribute('position').count) parts.push(plate);
        else { plate.dispose(); report.failed.push({ osmId: feature.properties.osmId, kind: feature.properties.kind, error: '空面' }); }
      }
    }
    if (!parts.length) continue;
    add(`ground-${tone}`, mergePositions(parts), colors[tone]);
    report.tones[tone] = parts.length;
    report.features[tone] = features.length;
  }

  if (streets.length) {
    add('ground-road', mergePositions(streets.map((feature) => ribbonGeometry(feature.geometry.coordinates, roadWidth(feature), project, GROUND_LAYERS.road))), colors.road);
    report.tones.road = streets.length;
    report.features.road = streets.length;
  }

  return {
    group,
    layers: { ...GROUND_LAYERS },
    report,
    dispose: () => {
      for (const geometry of geometries) geometry.dispose();
      group.traverse((object) => object.material?.dispose?.());
    },
  };
}
