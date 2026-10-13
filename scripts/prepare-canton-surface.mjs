// V8 Phase 1 数据层：广州塔 3 km 圈的地面矢量。
//
// 为什么要有这一步：现版画面上的水面、公园、草地、林地、地块底色并不是本地数据，而是 OpenFreeMap 矢量瓦片里
// `source-layer` 为 water / waterway / park / landcover / landuse 的那几层（`src/map.js` 只给它们换色）。V8 要废弃瓦片，
// 这几层就没了——新引擎的地面于是只剩道路与一条示意河带。所以按现版画的那几层，逐层从 OSM 取回真几何。
//
// 取的是**边界本身**，不做任何加工：闭合的 way 直接成环，multipolygon relation 按成员 way 的首尾端点拼接，
// 接不上就整条报错、记进 skipped，绝不把开口两端连起来、绝不补坐标（`geometryFromElement` 本来就是这套规矩，
// 与景泰那份快照共用同一个函数，不另写一份会漂的）。
//
// Usage:
//   node scripts/prepare-canton-surface.mjs --fetch            # 取一次原始快照进 data/
//   node scripts/prepare-canton-surface.mjs                    # 从原始快照派生三份 geojson
//   node scripts/prepare-canton-surface.mjs --fetch-only       # 只取数，不派生
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { geometryFromElement } from '../src/jingtai-data.js';
import { OVERPASS_ENDPOINTS } from '../src/config.js';
import { plane } from '../src/geo.js';

const CENTER = { lat: 23.109, lng: 113.31913 };
const RADIUS_METRES = 3000;
const root = new URL('../', import.meta.url);
const rawUrl = new URL('data/canton-surface-overpass.json', root);
const sourceUrl = new URL('data/canton-surface-source.json', root);
const around = `(around:${RADIUS_METRES},${CENTER.lat},${CENTER.lng})`;

// 三组，对应 `GROUND_LAYERS` 里的 water / green / block 三档。每组的规则照的是 Liberty 画的那几层，
// 不是 OSM 标签的全集：画面没画的东西不占数据。顺序即优先级，第一个命中的规则说了算。
export const SURFACE_RULES = [
  ['water', 'riverbank', (t) => t.waterway === 'riverbank'],
  ['water', 'water', (t) => t.natural === 'water'],
  ['water', 'basin', (t) => /^(basin|reservoir|salt_pond)$/.test(t.landuse ?? '')],
  ['water', 'dock', (t) => t.waterway === 'dock'],
  ['green', 'park', (t) => /^(park|garden|nature_reserve|urban|common)$/.test(t.leisure ?? '')],
  // 两个字段要分开测：写成 `${landuse}|${leisure}` 再配 `^(...)$`，尾巴上那个分隔符会让整串匹配不上，
  // 118 个 `landuse=grass` 就是这么从规则里漏出去的（2026-10-04 与底图对账时抓到）。
  ['green', 'grass', (t) => /^(grass|greenfield|village_green|flowerbelt|recreation_ground)$/.test(t.landuse ?? '')
    || t.leisure === 'recreation_ground'],
  ['green', 'wood', (t) => t.natural === 'wood' || t.landuse === 'forest'],
  ['green', 'grassland', (t) => t.natural === 'grassland'],
  ['green', 'wetland', (t) => t.natural === 'wetland'],
  ['green', 'sand', (t) => /^(sand|beach)$/.test(t.natural ?? '') || t.landuse === 'brownfield'],
  ['green', 'pitch', (t) => /^(pitch|track)$/.test(t.leisure ?? '')],
  ['green', 'golf', (t) => /^(golf_course|miniature_golf)$/.test(t.leisure ?? '')],
  ['block', 'cemetery', (t) => t.landuse === 'cemetery'],
  ['block', 'hospital', (t) => t.amenity === 'hospital' || t.healthcare === 'hospital'],
  ['block', 'school', (t) => /^(school|kindergarten|college|university)$/.test(t.amenity ?? '')],
  ['block', 'residential', (t) => /^(residential|commercial|retail|industrial|institutional|railway|military|construction|landfill|garages|allotments|farm)$/.test(t.landuse ?? '')],
  ['block', 'civic', (t) => /^(townhall|library|marketplace|government|police|fire_station|community_centre|sports_centre|stadium|theatre|museum)$/.test(t.amenity ?? '') || /^(zoo|theme_park)$/.test(t.tourism ?? '')],
  ['block', 'pedestrian', (t) => t.highway && (t.area === 'yes' || t['area:highway'])],
];

const classify = (tags) => {
  for (const [group, kind, test] of SURFACE_RULES) if (test(tags)) return { group, kind };
  return null;
};

export const query = `[out:json][timeout:240][maxsize:1073741824];
(
 nwr${around}["natural"~"^(water|wood|grassland|wetland|sand|beach)$"];
 nwr${around}["waterway"~"^(riverbank|dock)$"];
 nwr${around}["landuse"~"^(basin|reservoir|salt_pond|grass|greenfield|village_green|recreation_ground|flowerbelt|forest|cemetery|residential|commercial|retail|industrial|institutional|railway|military|construction|landfill|garages|allotments|farm|brownfield)$"];
 nwr${around}["leisure"~"^(park|garden|nature_reserve|urban|common|pitch|track|golf_course|miniature_golf|recreation_ground)$"];
 nwr${around}["amenity"~"^(hospital|school|kindergarten|college|university|townhall|library|marketplace|government|police|fire_station|community_centre|sports_centre|stadium|theatre|museum)$"];
 nwr${around}["tourism"~"^(zoo|theme_park)$"];
 nwr${around}["highway"]["area"="yes"];
)->.surface;
( .surface; way(r.surface); node(w.surface); );
out body geom;`;

const arg = (name) => process.argv.includes(name);

if (arg('--fetch')) {
  // overpass-api.de 在没有 User-Agent 时直接 406（2026-10-04 实测：同一句查询，不带 UA 406、带 UA 200），
  // 而 mail.ru 那台会在高峰期 504，所以两头都要试。端点顺序沿用 `src/config.js`。
  const headers = { Accept: 'application/json', 'User-Agent': 'canton-3d-street/1.0 (local data audit)' };
  for (const [index, endpoint] of OVERPASS_ENDPOINTS.entries()) {
    try {
      console.log(`向 ${endpoint} 取地面矢量`);
      const response = await fetch(endpoint, {
        method: 'POST', body: new URLSearchParams({ data: query }), headers,
        signal: AbortSignal.timeout(300000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      if (text[0] !== '{') throw new Error(`响应不是 JSON：${text.slice(0, 160)}`);
      const raw = JSON.parse(text);
      if (raw.remark || !Array.isArray(raw.elements)) throw new Error(raw.remark || '响应缺 elements');
      await writeFile(rawUrl, text);
      await writeFile(sourceUrl, `${JSON.stringify({
        endpoint, fetchedAt: new Date().toISOString(), query,
        sha256: createHash('sha256').update(text).digest('hex'),
        center: CENTER, radiusMeters: RADIUS_METRES, elements: raw.elements.length,
        osmTimestamp: raw.osm3s?.timestamp_osm_base,
        license: 'ODbL-1.0', attribution: '© OpenStreetMap contributors',
        note: '边界逐字取 OSM：闭合 way 成环，multipolygon 按成员 way 首尾拼接，接不上的整条记入 skipped，不补坐标、不收口。',
      }, null, 2)}\n`);
      console.log(`原始快照 ${raw.elements.length} 个元素 → ${fileURLToPath(rawUrl)}`);
      break;
    } catch (error) {
      console.error(`${endpoint}: ${error.message}`);
      if (index === OVERPASS_ENDPOINTS.length - 1) throw error;
    }
  }
}

if (!arg('--fetch-only')) {
  const raw = JSON.parse(await readFile(rawUrl, 'utf8'));
  const source = JSON.parse(await readFile(sourceUrl, 'utf8'));
  const text = await readFile(rawUrl, 'utf8');
  if (source.sha256 !== createHash('sha256').update(text).digest('hex')) throw new Error('原始快照校验和不符，拒绝派生');

  const byId = new Map();
  for (const element of raw.elements) if (element.type !== 'node') byId.set(`${element.type}/${element.id}`, element);
  // 成员 way 会同时出现在结果集里；它们只属于各自的关系，不能自己再成一个面。
  const members = new Set();
  for (const element of byId.values()) if (element.type === 'relation') for (const m of element.members ?? []) if (m.type === 'way') members.add(`way/${m.ref}`);

  // 度² → m²：东西按本地平面的每度米数，南北用 METERS_PER_DEGREE 那个常数，与渲染同一把尺。
  const eastMetres = plane(CENTER, { lat: CENTER.lat, lng: CENTER.lng + 1 }).dx;
  const northMetres = 110540;
  const twiceArea = (ring) => ring.slice(1).reduce((sum, point, index) => sum
    + (ring[index][0] - ring[0][0]) * (point[1] - ring[0][1]) - (point[0] - ring[0][0]) * (ring[index][1] - ring[0][1]), 0);
  const polygonsOf = (geometry) => (geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates);
  const squareMetres = (geometry) => polygonsOf(geometry).reduce((sum, rings) => sum
    + Math.abs(twiceArea(rings[0]) - rings.slice(1).reduce((holes, ring) => holes + Math.abs(twiceArea(ring)), 0)) / 2
    * eastMetres * northMetres, 0);
  const vertexRange = (geometry) => {
    let nearest = Infinity, furthest = 0;
    for (const [lng, lat] of polygonsOf(geometry).flat(2)) {
      const distance = plane(CENTER, { lat, lng }).distance;
      nearest = Math.min(nearest, distance);
      furthest = Math.max(furthest, distance);
    }
    return { nearest: Math.round(nearest), furthest: Math.round(furthest) };
  };

  const groups = { water: [], green: [], block: [] };
  const counts = { water: {}, green: {}, block: {} };
  const extents = { water: 0, green: 0, block: 0 };
  const skipped = { open: [], relationMember: 0, unrelated: 0, tiny: 0, assembly: [] };
  for (const element of [...byId.values()].sort((a, b) => a.type.localeCompare(b.type) || a.id - b.id)) {
    if (element.type === 'way' && members.has(`way/${element.id}`)) { skipped.relationMember++; continue; }
    const match = classify(element.tags ?? {});
    if (!match) { skipped.unrelated++; continue; }
    let geometry;
    try { geometry = geometryFromElement(element); } catch (error) {
      if (/unclosed/.test(error.message)) skipped.open.push({
        id: `${element.type}/${element.id}`, kind: match.kind, points: element.geometry?.length ?? 0,
        name: element.tags?.name ?? null,
      });
      else skipped.assembly.push({ id: `${element.type}/${element.id}`, kind: match.kind, error: error.message });
      continue;
    }
    const area = squareMetres(geometry);
    // 200 m² 以下的碎屑不值一个三角形：3 km 圈里 OSM 有几十块这样的草地边角，肉眼在任何机位都到不了一像素。
    if (area < 200) { skipped.tiny++; continue; }
    const { nearest, furthest } = vertexRange(geometry);
    extents[match.group] = Math.max(extents[match.group], furthest);
    groups[match.group].push({
      type: 'Feature',
      properties: { osmId: element.id, source: element.type, kind: match.kind, name: element.tags?.name ?? null,
        area: Math.round(area), nearest, furthest },
      geometry,
    });
    counts[match.group][match.kind] = (counts[match.group][match.kind] ?? 0) + 1;
  }

  for (const [group, filename] of Object.entries({ water: 'canton-water.geojson', green: 'canton-greens.geojson', block: 'canton-blocks.geojson' })) {
    const features = groups[group];
    const output = {
      type: 'FeatureCollection',
      metadata: {
        source: source.endpoint, license: 'ODbL-1.0', attribution: '© OpenStreetMap contributors',
        timestamp: source.osmTimestamp, fetchedAt: source.fetchedAt, rawSha256: source.sha256,
        radius: RADIUS_METRES, rules: '见 scripts/prepare-canton-surface.mjs 的 SURFACE_RULES，照 Liberty 画的 water/park/landcover/landuse 四层取值',
        kinds: counts[group], features: features.length,
        squareMetres: Math.round(features.reduce((sum, feature) => sum + feature.properties.area, 0)),
        furthest: Math.round(extents[group] ?? 0),
        outside: features.filter((feature) => feature.properties.nearest > RADIUS_METRES).length,
        openWays: skipped.open.filter((entry) => entry.kind).length,
        boundary: '边界逐字取 OSM，未简化、未收口；开口 way 与拼不上环的关系在 skipped 里，不补坐标。',
      },
      features,
    };
    await writeFile(new URL(`public/data/${filename}`, root), `${JSON.stringify(output)}\n`);
    console.log(`${filename}: ${features.length} 面 / ${output.metadata.squareMetres.toLocaleString()} m² · 最远 ${output.metadata.furthest} m · ${JSON.stringify(counts[group])}`);
  }
  console.log(`跳过：开口 way ${skipped.open.length} 条、关系成员 ${skipped.relationMember} 条、无规则命中 ${skipped.unrelated} 个、200 m² 以下 ${skipped.tiny} 个；装配失败 ${skipped.assembly.length} 个`);
  for (const entry of skipped.open.slice(0, 12)) console.log(`  开口 ${entry.id} ${entry.kind} ${entry.points} 点 ${entry.name ?? ''}`);
  for (const entry of skipped.assembly.slice(0, 6)) console.log(`  装配失败 ${entry.id}(${entry.kind}) ${entry.error}`);
}
