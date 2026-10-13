import { DEFAULT_BUILDING_HEIGHT } from './config.js';
import { featureCollection, METERS_PER_DEGREE } from './geo.js';
import { distanceToGeometry, insideRing, ringCentroid } from './buildings.js';

// One non-OSM outline source, kept deliberately separate from normalizeBuildings: that builder's contract is "an OSM way
// with tags", and pushing footprints through it would either fabricate a way id or drop them. Everything here is the
// other half of that contract — an outline that is *not* an OSM element says so in every field that reaches the map.
export const EASTASIA_SOURCE = {
  name: '东亚建筑矢量数据集（East Asian countries building vector data）',
  doi: '10.5281/zenodo.8174931',
  recordUrl: 'https://zenodo.org/records/8174931',
  published: '2023-07-22',
  // .shp.xml CreaDate 20230423 — the interpretation date, not the state of the ground today.
  interpretedAt: '2023-04-23',
  archive: 'East_Asian_buildings.zip',
  archiveBytes: 23108515351,
  archiveMd5: 'd356f487b19eaa13c6e12eb42ac3ca53',
  member: 'China/Guangdong/Guangzhou.shp',
  memberCrs: 'EPSG:32649',
  license: 'CC BY 4.0',
  // Stated by the authors on the record page; the upstream imagery terms and the missing per-element source code list
  // stay unresolved (docs/audits/jingtai-p1-sources.md P1-3b), so they travel with every report about this data.
  licenseGap: '作者声明 CC BY 4.0；配套论文写明轮廓由高分辨率商业影像判读，归档内无许可文本与 STATUS 代码表，上游影像条款未清',
  noHeight: '数据集无 height/levels 字段，所有轮廓只能按默认 9.6 m 示意绘制',
  noNaming: '数据集无名称与地址字段，这些轮廓不参与楼名与地址检索',
  idPrefix: 'eastasia/',
  footprintSource: 'eastasia-2023',
  cardNote: '轮廓来自开放数据集东亚建筑矢量数据（DOI 10.5281/zenodo.8174931，CC BY 4.0，2023-04 影像判读）；该来源无高度、名称与用途字段。',
};

export const MERGE_RULES = { minAreaSquareMeters: 20, duplicateMeters: 1, osmPrecedenceMeters: 15 };
export const REJECT_REASONS = ['invalid-geometry', 'outside-radius', 'inside-campus', 'tiny-area', 'matches-osm', 'duplicate-footprint'];

const ringTwiceArea = (ring) => ring.slice(1).reduce((sum, p, i) => sum + (ring[i][0] - ring[0][0]) * (p[1] - ring[0][1]) - (p[0] - ring[0][0]) * (ring[i][1] - ring[0][1]), 0);
const orient = (ring, outer) => (ringTwiceArea(ring) > 0) === outer ? ring : [...ring].reverse();
const closed = (ring) => ring.length >= 4 && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1];
const finitePoint = ([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat) && Math.abs(lat) <= 85 && Math.abs(lng) <= 180;

export function polygonsOf(geometry) {
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates;
  throw new Error(`footprint geometry must be Polygon or MultiPolygon, got ${geometry.type}`);
}
// Every vertex of every ring, Polygon and MultiPolygon alike: depth 2 down from the ring list.
export const vertexList = (geometry) => polygonsOf(geometry).flat(2);
const exteriorRings = (geometry) => polygonsOf(geometry).map((rings) => rings[0]);

// metres² on the same tangent plane the OSM path uses, so the 20 m² floor means the same thing on both sides.
export function footprintArea(geometry, center) {
  const metersX = Math.cos(center.lat * Math.PI / 180) * METERS_PER_DEGREE;
  return polygonsOf(geometry).reduce((total, rings) => {
    const outer = Math.abs(ringTwiceArea(rings[0])) / 2;
    const holes = rings.slice(1).reduce((sum, ring) => sum + Math.abs(ringTwiceArea(ring)) / 2, 0);
    return total + (outer - holes) * metersX * METERS_PER_DEGREE;
  }, 0);
}

const distanceBetween = (a, b) => Math.hypot((a.lng - b.lng) * Math.cos(a.lat * Math.PI / 180) * METERS_PER_DEGREE, (a.lat - b.lat) * METERS_PER_DEGREE);

// Area centroid of the largest part, flagged when it falls outside its own outline: a concave block's centroid is then
// not a position the block occupies, and no proximity rule may trust it.
export function footprintCentroid(geometry) {
  const largest = exteriorRings(geometry).reduce((a, b) => (Math.abs(ringTwiceArea(b)) > Math.abs(ringTwiceArea(a)) ? b : a));
  const [lng, lat] = ringCentroid(largest);
  return { lat, lng, inside: exteriorRings(geometry).some((ring) => insideRing(ring, lng, lat)) };
}

// Outline-to-outline gap, both directions vertex-to-face: 0 as soon as either footprint touches or contains the other.
// Same predicate the P1-3b band table was measured with, so merge counts stay comparable to that audit.
export function footprintGap(a, b) {
  let best = Infinity;
  for (const [lng, lat] of vertexList(a.geometry)) best = Math.min(best, distanceToGeometry({ lat, lng }, b.geometry));
  for (const [lng, lat] of vertexList(b.geometry)) best = Math.min(best, distanceToGeometry({ lat, lng }, a.geometry));
  return best;
}

const CELL_DEGREES = 0.002; // ~200 m, so a 15 m test only ever needs a cell and its neighbours
const cellOf = (value) => Math.floor(value / CELL_DEGREES);

// Indexed and queried by bounding box, not by vertex: a long block can pass within 15 m of a footprint while every one
// of its own corners sits further away, and a vertex-only index would then report "no neighbour" and duplicate it.
const bboxOf = (geometry) => vertexList(geometry).reduce(([a, b, c, d], [lng, lat]) => [Math.min(a, lng), Math.min(b, lat), Math.max(c, lng), Math.max(d, lat)], [Infinity, Infinity, -Infinity, -Infinity]);
const cellsOf = ([minLng, minLat, maxLng, maxLat], pad = 0) => {
  const cells = [];
  for (let x = cellOf(minLng) - pad; x <= cellOf(maxLng) + pad; x += 1) {
    for (let y = cellOf(minLat) - pad; y <= cellOf(maxLat) + pad; y += 1) cells.push(`${x}:${y}`);
  }
  return cells;
};

function spatialIndex(features) {
  const grid = new Map();
  for (const feature of features) {
    for (const cell of cellsOf(bboxOf(feature.geometry))) {
      if (!grid.has(cell)) grid.set(cell, []);
      grid.get(cell).push(feature);
    }
  }
  return grid;
}

function nearbyCandidates(grid, geometry) {
  const out = new Set();
  for (const cell of cellsOf(bboxOf(geometry), 1)) for (const feature of grid.get(cell) ?? []) out.add(feature);
  return [...out];
}

// An outline that is far outside the indexed area shares no cell with anything, and an empty candidate list is the one
// case where the grid says nothing — there the caller has to look at the whole pool rather than guess "no match".
function nearestGap(pool, candidates, target) {
  let best = Infinity;
  if (candidates.length) {
    for (const other of candidates) if (other !== target) best = Math.min(best, footprintGap(target, other));
    return best;
  }
  for (const other of pool) if (other !== target) best = Math.min(best, footprintGap(target, other));
  return best;
}

// One source record can cover several detached blocks. Each part becomes its own feature so the merged file stays
// Polygon-only like the OSM snapshot, which is what the card anchor and the hit-test rely on.
function partsOf(feature) {
  let polygons;
  try { polygons = polygonsOf(feature.geometry); } catch { return []; }
  if (!polygons.length || polygons.some((rings) => rings.some((ring) => !ring.every(finitePoint) || !closed(ring)))) return [];
  return polygons.map((rings, index) => ({
    type: 'Feature', id: feature.id,
    properties: { ...feature.properties, part: index + 1, parts: polygons.length },
    geometry: { type: 'Polygon', coordinates: rings.map((ring, i) => orient(ring, i === 0)) },
  }));
}

const recordNumber = (feature) => Number(/^gz-([1-9]\d*)$/.exec(String(feature.id ?? ''))?.[1] ?? NaN);

export function normalizeFootprints(collection, options = {}) {
  const {
    center, radius, campusGeometry = null, source = EASTASIA_SOURCE, osmFeatures = [],
    minAreaSquareMeters = MERGE_RULES.minAreaSquareMeters, duplicateMeters = MERGE_RULES.duplicateMeters,
    osmPrecedenceMeters = MERGE_RULES.osmPrecedenceMeters,
  } = options;
  if (!center || !Number.isFinite(radius)) throw new Error('normalizeFootprints needs center and radius');
  if (campusGeometry && campusGeometry.type !== 'Polygon') throw new Error('campusGeometry must be a Polygon');
  const ordered = collection.features.flatMap(partsOf)
    .sort((a, b) => (recordNumber(a) || Infinity) - (recordNumber(b) || Infinity) || a.properties.part - b.properties.part);
  const osmGrid = spatialIndex(osmFeatures);
  const counts = Object.fromEntries(REJECT_REASONS.map((reason) => [reason, 0]));
  const samples = {};
  const reject = (feature, reason, detail) => {
    counts[reason] += 1;
    (samples[reason] ??= []).length < 20 && samples[reason].push({ id: feature.id, part: feature.properties.part, detail });
  };

  const usable = [];
  for (const part of ordered) {
    const geometry = part.geometry;
    if (part.id === undefined || !Number.isSafeInteger(recordNumber(part))) { reject(part, 'invalid-geometry', '缺少可回溯的记录号'); continue; }
    const distance = distanceToGeometry(center, geometry);
    if (distance > radius) { reject(part, 'outside-radius', `最近边 ${Math.round(distance)} m > ${radius} m`); continue; }
    // The scene's own subject: OSM holds no teaching building for it, so nothing here may paint one either.
    if (campusGeometry && vertexList(geometry).some(([lng, lat]) => insideRing(campusGeometry.coordinates[0], lng, lat))) {
      reject(part, 'inside-campus', '轮廓顶点落入校园用地面内'); continue;
    }
    const area = footprintArea(geometry, center);
    if (area < minAreaSquareMeters) { reject(part, 'tiny-area', `${area.toFixed(1)} m² < ${minAreaSquareMeters} m²`); continue; }
    if (nearestGap(osmFeatures, nearbyCandidates(osmGrid, geometry), part) <= osmPrecedenceMeters) {
      reject(part, 'matches-osm', `与既有 OSM 轮廓间距 ≤ ${osmPrecedenceMeters} m，以 OSM 为准`); continue;
    }
    usable.push({ ...part, metrics: { distance, area, centroid: footprintCentroid(geometry) } });
  }

  // Two outlines on the same spot would extrude as two blocks; the larger one is kept.
  const usableGrid = spatialIndex(usable);
  const dropped = new Set();
  for (const feature of usable) {
    if (dropped.has(feature)) continue;
    const twins = nearbyCandidates(usableGrid, feature.geometry)
      .filter((other) => other !== feature && !dropped.has(other) && other.metrics.centroid.inside && feature.metrics.centroid.inside)
      .filter((other) => distanceBetween(feature.metrics.centroid, other.metrics.centroid) < duplicateMeters);
    const [keeper] = [feature, ...twins].sort((a, b) => b.metrics.area - a.metrics.area);
    for (const duplicate of [feature, ...twins]) {
      if (duplicate === keeper) continue;
      dropped.add(duplicate);
      reject(duplicate, 'duplicate-footprint', `质心相距 < ${duplicateMeters} m，保留较大轮廓 ${keeper.id}#p${keeper.properties.part}`);
    }
  }

  let seq = 0;
  const features = [];
  for (const feature of usable) {
    if (dropped.has(feature)) continue;
    seq += 1;
    const id = `${source.idPrefix}${seq}`;
    const sourceId = `eastasia/${feature.id}${feature.properties.parts > 1 ? `#p${feature.properties.part}` : ''}`;
    features.push({
      type: 'Feature', id,
      properties: {
        osmId: id, sourceId,
        footprintSource: source.footprintSource, sourceLicense: source.license, sourceCrs: source.memberCrs, sourceRecord: feature.id,
        ...(Number.isFinite(Number(feature.properties.dataset_id)) ? { sourceDatasetId: Number(feature.properties.dataset_id) } : {}),
        ...(Number.isFinite(Number(feature.properties.orig_oid)) ? { sourceOrigOid: Number(feature.properties.orig_oid) } : {}),
        ...(feature.properties.status !== undefined && feature.properties.status !== null ? { sourceStatus: String(feature.properties.status) } : {}),
        category: 'unknown', height: DEFAULT_BUILDING_HEIGHT, base: 0, heightSource: 'estimate',
        distance: Math.round(feature.metrics.distance), area: Math.round(feature.metrics.area),
      },
      geometry: feature.geometry,
    });
  }
  return {
    features,
    stats: {
      inputFeatures: collection.features.length, inputParts: ordered.length, kept: features.length,
      records: new Set(ordered.map((part) => part.id)).size, rejected: counts, samples,
      minAreaSquareMeters, duplicateMeters, osmPrecedenceMeters,
    },
  };
}

export function mergeJingtaiBuildings(osmCollection, footprintFeatures) {
  const taken = new Set(osmCollection.features.map((feature) => String(feature.properties.osmId)));
  const added = footprintFeatures.filter((feature) => !taken.has(String(feature.properties.osmId)));
  return { ...featureCollection([...osmCollection.features, ...added]), properties: { sources: ['OpenStreetMap (ODbL)', 'eastasia-2023 (CC BY 4.0)'] } };
}

// The merged file cannot go through validateJingtai: that validator's promise is "every feature is an OSM element with
// OSM geometry", and a footprint source breaks it by design. This is the matching promise for the merged shape: the OSM
// half stays byte-identical, and the added half may only claim what the source actually says.
export function validateMergedJingtai(merged, osmCollection, footprints, options = {}) {
  const {
    center, radius, campusGeometry = null, source = EASTASIA_SOURCE,
    minAreaSquareMeters = MERGE_RULES.minAreaSquareMeters, duplicateMeters = MERGE_RULES.duplicateMeters,
  } = options;
  const require = (condition, message) => { if (!condition) throw new Error(message); };
  const added = merged.features.slice(osmCollection.features.length);
  const osmIds = new Set(osmCollection.features.map((feature) => String(feature.properties.osmId)));
  require(JSON.stringify(merged.features.slice(0, osmCollection.features.length)) === JSON.stringify(osmCollection.features), 'OSM features changed while merging');
  require(added.length === footprints.features.length, `Merged total ${merged.features.length} does not match OSM ${osmCollection.features.length} + footprints ${footprints.features.length}`);
  const centroids = new Map(added.map((feature) => [feature, footprintCentroid(feature.geometry)]));
  const addedGrid = spatialIndex(added);
  for (const feature of added) {
    const p = feature.properties;
    require(!osmIds.has(String(p.osmId)), `Footprint reuses an OSM identity: ${p.osmId}`);
    require(/^eastasia\/[1-9]\d*$/.test(String(p.osmId)), `Footprint identity must be namespaced: ${p.osmId}`);
    require(!/^(?:relation\/)?\d+$/.test(String(p.osmId)), `Footprint identity looks like an OSM id: ${p.osmId}`);
    require(/^eastasia\/gz-[1-9]\d*(#p[1-9]\d*)?$/.test(String(p.sourceId)), `Footprint source record: ${p.sourceId}`);
    require(p.footprintSource === source.footprintSource, `Footprint without source class: ${p.osmId}`);
    require(p.heightSource === 'estimate' && p.height === DEFAULT_BUILDING_HEIGHT && p.base === 0, `Footprint claims a height it does not have: ${p.osmId}`);
    require(!['name', 'nameEn', 'street', 'house', 'type', 'place'].some((key) => key in p), `Footprint carries naming it cannot source: ${p.osmId}`);
    require(p.category === 'unknown', `Footprint claims a use it cannot source: ${p.osmId}`);
    require(feature.geometry.type === 'Polygon', `Merged file must stay Polygon-only: ${p.osmId}`);
    require(distanceToGeometry(center, feature.geometry) <= radius, `Footprint outside ${radius} m: ${p.osmId}`);
    require(footprintArea(feature.geometry, center) >= minAreaSquareMeters, `Footprint below the ${minAreaSquareMeters} m² floor: ${p.osmId}`);
    require(Math.abs(p.distance - Math.round(distanceToGeometry(center, feature.geometry))) <= 1, `Footprint distance stale: ${p.osmId}`);
    require(Math.abs(p.area - Math.round(footprintArea(feature.geometry, center))) <= 1, `Footprint area stale: ${p.osmId}`);
    if (campusGeometry) require(!vertexList(feature.geometry).some(([lng, lat]) => insideRing(campusGeometry.coordinates[0], lng, lat)), `Footprint inside campus: ${p.osmId}`);
    const own = centroids.get(feature);
    if (!own.inside) continue;
    for (const other of nearbyCandidates(addedGrid, feature.geometry)) {
      if (other === feature) continue;
      const centroid = centroids.get(other);
      if (!centroid?.inside || distanceBetween(own, centroid) >= duplicateMeters) continue;
      throw new Error(`Duplicate footprints kept: ${p.osmId} / ${other.properties.osmId}`);
    }
  }
  return true;
}
