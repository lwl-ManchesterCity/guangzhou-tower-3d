import { SCENES } from './scenes.js';
import { normalizeBuildings, searchIndex, insideRing, interiorPoint, distanceToGeometry, buildingHeight, buildingCategory, buildingLabels } from './buildings.js';
import { distanceMeters, featureCollection } from './geo.js';
import { buildWalkingGraph, footAccess, nearestGraphNodes, shortestWalk } from './walking.js';

const scene = SCENES.jingtai;
export const REQUIRED_STATIONS = [
  { name: '大金钟路', lat: 23.16451, lng: 113.27178 },
  { name: '飞翔公园', lat: 23.17137, lng: 113.25826 },
  { name: '中医药大学', lat: 23.16010, lng: 113.26380 },
];
const nameAddressSource = '用户核验附件 sonus-handoff-3d-neighborhood-v3.md：景泰校区、云龙路38号；轮廓来自 OSM way/1178149399';
const osmId = (e) => `${e.type}/${e.id}`;
const osmName = (e) => e.tags?.['name:zh'] || e.tags?.name || e.tags?.['name:en'] || '';
const samePoint = (a, b) => a?.[0] === b?.[0] && a?.[1] === b?.[1];
const validPoint = (p) => p && Number.isFinite(p.lon) && Number.isFinite(p.lat) && Math.abs(p.lon) <= 180 && Math.abs(p.lat) <= 85;
const ringArea = (ring) => ring.slice(1).reduce((sum, p, i) => sum + (ring[i][0] - ring[0][0]) * (p[1] - ring[0][1]) - (p[0] - ring[0][0]) * (ring[i][1] - ring[0][1]), 0) / 2;
const orient = (ring, outer) => (ringArea(ring) > 0) === outer ? ring : [...ring].reverse();

function joinedRings(members) {
  const segments = members.map((member) => {
    if (!member.geometry?.length || !member.geometry.every(validPoint)) throw new Error('missing member geometry');
    return member.geometry.map((p) => [p.lon, p.lat]);
  });
  const rings = [];
  while (segments.length) {
    let ring = segments.shift();
    while (!samePoint(ring[0], ring.at(-1))) {
      const next = segments.flatMap((segment, i) => samePoint(ring.at(-1), segment[0]) ? [{ i, reverse: false }] : samePoint(ring.at(-1), segment.at(-1)) ? [{ i, reverse: true }] : []);
      if (next.length !== 1) throw new Error(next.length ? 'ambiguous member junction' : 'unclosed member chain');
      const { i, reverse } = next[0];
      let segment = segments.splice(i, 1)[0];
      if (reverse) segment = [...segment].reverse();
      ring = [...ring, ...segment.slice(1)];
    }
    if (ring.length < 4 || Math.abs(ringArea(ring)) < 1e-15) throw new Error('degenerate ring');
    rings.push(ring);
  }
  return rings;
}

export function pointInGeometry(geometry, lng, lat) {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
  return polygons.some((rings) => insideRing(rings[0], lng, lat) && !rings.slice(1).some((ring) => insideRing(ring, lng, lat)));
}

// Match only exact member endpoints, never close open OSM ways or invent connecting edges.
export function geometryFromElement(element) {
  if (element.type === 'way') {
    const rings = joinedRings([{ geometry: element.geometry }]);
    return { type: 'Polygon', coordinates: [orient(rings[0], true)] };
  }
  if (element.type !== 'relation' || element.tags?.type !== 'multipolygon') throw new Error('not a polygon/multipolygon');
  if (element.members?.some((m) => m.type === 'relation' || m.type === 'node' && ['inner', 'outer'].includes(m.role))) throw new Error('unsupported nested/non-way polygon member');
  const members = element.members?.filter((m) => m.type === 'way') ?? [];
  if (members.some((m) => !['outer', 'inner', ''].includes(m.role))) throw new Error('unknown polygon member role');
  const outers = joinedRings(members.filter((m) => m.role !== 'inner'));
  const inners = joinedRings(members.filter((m) => m.role === 'inner'));
  if (!outers.length) throw new Error('missing outer ring');
  const polygons = outers.map((ring) => [orient(ring, true)]);
  for (const inner of inners) {
    const containers = outers.map((outer, i) => ({ outer, i })).filter(({ outer }) => inner.slice(0, -1).every(([lng, lat]) => insideRing(outer, lng, lat)));
    if (!containers.length) throw new Error('hole outside outer ring');
    containers.sort((a, b) => Math.abs(ringArea(a.outer)) - Math.abs(ringArea(b.outer)));
    polygons[containers[0].i].push(orient(inner, false));
  }
  return polygons.length === 1 ? { type: 'Polygon', coordinates: polygons[0] } : { type: 'MultiPolygon', coordinates: polygons };
}

export function geometryPoint(geometry) {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
  for (const polygon of [...polygons].sort((a, b) => Math.abs(ringArea(b[0])) - Math.abs(ringArea(a[0])))) {
    const point = interiorPoint(polygon[0]);
    if (pointInGeometry(geometry, ...point)) return point;
    // Scan interior scanlines as the outer centroid can lie in an actual OSM hole.
    const lats = polygon[0].map((p) => p[1]);
    const min = Math.min(...lats), max = Math.max(...lats);
    for (let row = 1; row < 32; row++) {
      const y = min + (max - min) * row / 32;
      const xs = [];
      for (const ring of polygon) for (let i = 1; i < ring.length; i++) {
        const a = ring[i - 1], b = ring[i];
        if ((a[1] > y) !== (b[1] > y)) xs.push(a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
      }
      xs.sort((a, b) => a - b);
      for (let i = 1; i < xs.length; i++) {
        const candidate = [(xs[i - 1] + xs[i]) / 2, y];
        if (pointInGeometry(geometry, ...candidate)) return candidate;
      }
    }
  }
  throw new Error('no interior label point');
}

const exteriorPoints = (geometry) => (geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates).flatMap((polygon) => polygon[0]);
// Same rule as the building radius: an outline counts by its nearest edge, not by its nearest corner.
const geometryDistance = (geometry) => distanceToGeometry(scene.center, geometry);

function groundKind(element) {
  if (element.type === 'way' && element.id === scene.campusId) return 'campus';
  const tags = element.tags ?? {};
  if (['pitch', 'track'].includes(tags.leisure)) return tags.leisure;
  if (['park', 'garden'].includes(tags.leisure)) return 'park';
  if (tags.leisure === 'nature_reserve' || tags.natural === 'wood' || tags.landuse === 'forest') return 'mountain';
  return null;
}

function poiClassification(tags) {
  if (['school', 'kindergarten', 'college', 'university'].includes(tags.amenity)) return ['school', { school: '学校', kindergarten: '幼儿园', college: '学院', university: '大学' }[tags.amenity]];
  if (['park', 'garden', 'pitch', 'track'].includes(tags.leisure)) return ['park', { park: '公园', garden: '花园', pitch: '球场', track: '跑道' }[tags.leisure]];
  if (tags.railway === 'station' && (tags.station === 'subway' || tags.subway === 'yes') || tags.public_transport === 'station' && tags.subway === 'yes') return ['transit', '地铁站'];
  if (['restaurant', 'cafe', 'fast_food', 'bar', 'pub', 'food_court', 'ice_cream'].includes(tags.amenity)) return ['food', { restaurant: '餐厅', cafe: '咖啡馆', fast_food: '快餐', bar: '酒吧', pub: '酒馆', food_court: '美食广场', ice_cream: '冰淇淋店' }[tags.amenity]];
  if (tags.shop && !['no', 'vacant', 'closed'].includes(tags.shop)) return ['shop', { convenience: '便利店', supermarket: '超市', bakery: '面包店', clothes: '服装店', books: '书店' }[tags.shop] || '商店'];
  return null;
}

export function normalizeJingtaiPois(elements, geometries, exclusions = []) {
  const pois = [], seen = new Set(), stations = new Set();
  for (const element of elements) {
    const id = osmId(element), tags = element.tags ?? {}, classification = poiClassification(tags);
    if (!classification || seen.has(id)) continue;
    seen.add(id);
    const [category, label] = classification;
    let lat, lng;
    if (element.type === 'node') ({ lat, lon: lng } = element);
    else if (geometries.has(id)) [lng, lat] = geometryPoint(geometries.get(id));
    else if (element.center) ({ lat, lon: lng } = element.center);
    else { exclusions.push({ id, reason: 'POI has no reliable geometry/point' }); continue; }
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const originalName = osmName(element), stationName = originalName.replace(/站$/, '');
    if (category === 'transit') {
      if (!stationName || stations.has(stationName)) continue;
      stations.add(stationName);
    }
    const required = category === 'transit' && REQUIRED_STATIONS.find((station) => station.name === stationName);
    const rawCoordinate = { lat, lng };
    if (required) ({ lat, lng } = required);
    const distance = distanceMeters(scene.center, { lat, lng });
    if (distance > scene.radius) continue;
    const campus = element.type === 'way' && element.id === scene.campusId;
    if (campus) ({ lat, lng } = scene.center);
    pois.push({ id, lat, lng, distance: campus ? 0 : Math.round(distance), name: campus ? scene.name : category === 'transit' ? `${stationName}站` : originalName || `${label}（未命名）`, category, label,
      address: campus ? '云龙路38号' : String(tags['addr:full'] || [tags['addr:street'], tags['addr:housenumber']].filter(Boolean).join(' ')),
      openingHours: String(tags.opening_hours || ''), osmUrl: `https://www.openstreetmap.org/${id}`,
      ...(tags.leisure ? { leisure: tags.leisure } : {}), ...(tags.sport ? { sport: tags.sport } : {}),
      ...(campus ? { campus: true, source: nameAddressSource } : {}),
      ...(required ? { coordinateSource: '用户核验附件：站点坐标（WGS84）', osmCoordinate: rawCoordinate } : {}),
    });
  }
  const priority = { school: 0, park: 1, transit: 2, food: 3, shop: 4 };
  return pois.sort((a, b) => Number(Boolean(b.campus)) - Number(Boolean(a.campus)) || priority[a.category] - priority[b.category] || a.distance - b.distance || a.id.localeCompare(b.id));
}

export function walkingForStations(elements, campus, pois) {
  const graph = buildWalkingGraph(elements);
  const rawNodes = new Map(elements.filter((e) => e.type === 'node').map((e) => [e.id, e]));
  const campusNodes = new Set(campus.nodes);
  const origins = [...graph.nodes].filter(([id]) => campusNodes.has(id) && !graph.blocked.has(id)).map(([id, point]) => ({ nodeId: id, ...point, source: rawNodes.get(id)?.tags?.entrance || rawNodes.get(id)?.tags?.barrier === 'gate' ? 'OSM campus gate shared with foot-allowed highway' : 'OSM campus boundary node shared with foot-allowed highway', accessDistance: 0 }));
  const campusGeometry = geometryFromElement(campus);
  // A mapped entrance inside the campus is usable only if it is itself on the graph.
  for (const node of rawNodes.values()) {
    if (!node.tags?.entrance && node.tags?.barrier !== 'gate') continue;
    if (!graph.nodes.has(node.id) || !pointInGeometry(campusGeometry, node.lon, node.lat) || !footAccess(node.tags, { node: true })) continue;
    if (!origins.some((origin) => origin.nodeId === node.id)) origins.push({ nodeId: node.id, lat: node.lat, lng: node.lon, source: 'OSM gate/entrance within campus on foot-allowed highway', accessDistance: 0 });
  }
  const allEntrances = elements.filter((e) => e.type === 'node' && e.tags?.railway === 'subway_entrance');
  const metadata = { algorithm: 'Dijkstra / geodesic OSM edge lengths', radiusMeters: 2500, nodeCount: graph.nodes.size, directedEdgeCount: [...graph.edges.values()].reduce((sum, edges) => sum + edges.length, 0), excludedWays: graph.exclusions, origins,
    policy: 'Only shared OSM node IDs connect ways. Pedestrian access and oneway:foot apply; motor-vehicle oneway does not. No inferred cross-road/campus snapping. Entrance must share a foot-allowed highway node. No straight-line coefficient.',
    originCandidates: campus.nodes.map((id) => ({ id: `node/${id}`, onGraph: graph.nodes.has(id), tags: rawNodes.get(id)?.tags ?? {} })),
    nearbyRoadNodesNotUsed: nearestGraphNodes(graph, scene.center, 100).slice(0, 10).map(({ distance, ...node }) => ({ ...node, distanceFromCampusCenter: distance, reason: 'Nearby is not connected: no mapped campus gate/path. Not used as a walking origin.' })),
  };
  for (const poi of pois.filter((p) => p.category === 'transit')) {
    const stationName = poi.name.replace(/站$/, '');
    const entrances = allEntrances.filter((entrance) => osmName(entrance).startsWith(`${stationName}站`));
    const evidence = entrances.map((entrance) => ({ id: osmId(entrance), nodeId: entrance.id, lat: entrance.lat, lng: entrance.lon, name: osmName(entrance), ref: entrance.tags.ref ?? '', source: 'OSM railway=subway_entrance, explicit station-name match', onGraph: graph.nodes.has(entrance.id), accessDistance: graph.nodes.has(entrance.id) ? 0 : null, nearestGraphNodes: graph.nodes.has(entrance.id) ? [] : nearestGraphNodes(graph, { lat: entrance.lat, lng: entrance.lon }, 40).slice(0, 3) }));
    let best = null;
    for (const origin of origins) {
      const route = shortestWalk(graph, origin.nodeId, evidence.filter((entry) => entry.onGraph).map((entry) => entry.nodeId));
      if (route && (!best || route.distance < best.distance)) best = { ...route, origin };
    }
    const common = { straightLineDistance: poi.distance, entrances: evidence, originCandidates: origins, method: metadata.algorithm, originReference: `way/${scene.campusId}`, networkRadiusMeters: 2500 };
    if (best) {
      const entrance = evidence.find((entry) => entry.nodeId === best.nodeIds.at(-1));
      poi.walkingDistance = Math.round(best.distance);
      poi.walkingRoute = best.geometry;
      poi.walking = { ...common, origin: best.origin, entrance, endpointAccessDistances: { origin: 0, entrance: 0 }, networkDistance: best.distance, nodeIds: best.nodeIds, wayIds: best.wayIds, routeSource: 'OSM foot-allowed road graph; campus network connection to named subway entrance' };
    } else {
      poi.walkingUnavailable = !origins.length ? 'OSM 未标注可与步行道路可靠连接的校门/校园边界节点，不能从校园中心跨墙接路。' : !evidence.some((entry) => entry.onGraph) ? '该站的具名出入口未接入可步行 OSM 路网；不推断跨路连接或将站中心当入口。' : '校园接点与地铁入口在2.5km抓取路网内不可达（含通行限制）；未生成推测路线。';
      poi.walking = { ...common, unavailable: poi.walkingUnavailable, endpointAccessDistances: { origin: origins.length ? 0 : null, entrance: evidence.some((entry) => entry.onGraph) ? 0 : null } };
    }
  }
  return metadata;
}

export function prepareJingtai(raw, source = {}) {
  if (!Array.isArray(raw.elements) || raw.remark) throw new Error('Incomplete raw Overpass snapshot');
  const elements = raw.elements, exclusions = [], geometries = new Map();
  const campus = elements.find((e) => e.type === 'way' && e.id === scene.campusId);
  if (!campus || campus.tags?.amenity !== 'school') throw new Error('Required Jingtai campus way missing');
  for (const element of elements) {
    if (element.type === 'node' || !groundKind(element) && !poiClassification(element.tags ?? {}) && !element.tags?.building && !element.tags?.['building:part']) continue;
    try { geometries.set(osmId(element), geometryFromElement(element)); }
    catch (error) { exclusions.push({ id: osmId(element), reason: error.message }); }
  }
  const campusGeometry = geometries.get(osmId(campus));
  if (!campusGeometry || !pointInGeometry(campusGeometry, scene.center.lng, scene.center.lat)) throw new Error('Campus footprint does not contain verified WGS84 center');
  const grounds = featureCollection(elements.flatMap((element) => {
    const kind = groundKind(element), geometry = geometries.get(osmId(element));
    if (!kind || !geometry || geometryDistance(geometry) > scene.radius) return [];
    const target = kind === 'campus' || ['pitch', 'track'].includes(kind) && exteriorPoints(geometry).slice(0, -1).every(([lng, lat]) => pointInGeometry(campusGeometry, lng, lat));
    return [{ type: 'Feature', id: element.type === 'way' ? element.id : `relation/${element.id}`, geometry, properties: { osmId: element.id, osmType: element.type, sourceId: osmId(element), osmUrl: `https://www.openstreetmap.org/${osmId(element)}`, kind, target, name: kind === 'campus' ? scene.name : osmName(element), osmName: osmName(element), distance: Math.round(geometryDistance(geometry)), ...(element.tags?.sport ? { sport: element.tags.sport } : {}), ...(element.tags?.leisure ? { leisure: element.tags.leisure } : {}), ...(kind === 'campus' ? { campus: true, category: 'public', street: '云龙路', house: '38', distance: 0, height: 0, base: 0, source: nameAddressSource } : { source: 'OpenStreetMap raw geometry; no invented track or mountain outline' }) } }];
  }));
  const buildings = normalizeBuildings(elements.filter((e) => e.id !== scene.campusId), { center: scene.center, radius: scene.radius, towerId: null });
  const relationBuildings = [];
  for (const element of elements.filter((e) => e.type === 'relation' && (e.tags?.building || e.tags?.['building:part']))) {
    const geometry = geometries.get(osmId(element));
    if (!geometry || geometryDistance(geometry) > scene.radius) continue;
    const { height, base, heightSource, levels } = buildingHeight(element.tags);
    if (height <= base || element.tags.location === 'underground' || Number(element.tags['building:levels']) < 0) continue;
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    const area = polygons.reduce((sum, rings) => sum + Math.abs(ringArea(rings[0])) - rings.slice(1).reduce((holes, ring) => holes + Math.abs(ringArea(ring)), 0), 0) * Math.cos(scene.center.lat * Math.PI / 180) * 111195 ** 2;
    relationBuildings.push({ type: 'Feature', id: `relation/${element.id}`, geometry, properties: { osmId: `relation/${element.id}`, sourceId: osmId(element), category: buildingCategory(element.tags), height, base, heightSource, distance: Math.round(geometryDistance(geometry)), area: Math.round(area), ...(levels ? { levels } : {}), ...buildingLabels(element.tags) } });
    const memberIds = new Set(element.members.filter((m) => m.type === 'way').map((m) => m.ref));
    buildings.features = buildings.features.filter((feature) => !memberIds.has(feature.id));
  }
  buildings.features.push(...relationBuildings);
  const index = searchIndex(buildings.features.filter((f) => f.geometry.type === 'Polygon'), { center: scene.center, radius: scene.radius });
  // Re-evaluate all representative points against holes as well as outer rings.
  for (const feature of buildings.features) {
    if (!feature.properties.name && !feature.properties.street) continue;
    const [lng, lat] = geometryPoint(feature.geometry), p = feature.properties;
    const existing = index.entries.find((entry) => entry.osmId === p.osmId);
    if (existing) Object.assign(existing, { lng, lat });
    else index.entries.push({ osmId: p.osmId, name: p.name ?? '', nameEn: p.nameEn ?? '', street: p.street ?? '', house: p.house ?? '', category: p.category, height: Math.round(p.height), heightSource: p.heightSource, distance: p.distance, lng, lat });
  }
  index.entries.unshift({ osmId: scene.campusId, campus: true, name: scene.name, nameEn: '', street: '云龙路', house: '38', category: 'public', height: 0, heightSource: 'estimate', distance: 0, ...scene.center, source: nameAddressSource });
  index.entries.sort((a, b) => a.distance - b.distance);
  const pois = normalizeJingtaiPois(elements, geometries, exclusions);
  const walking = walkingForStations(elements, campus, pois);
  const tourAnchors = grounds.features.filter((f) => /三泰/.test(f.properties.name) || f.properties.kind === 'mountain' && /白云山/.test(f.properties.name)).map((feature) => {
    const point = feature.properties.kind === 'mountain' ? exteriorPoints(feature.geometry).sort((a, b) => distanceMeters(scene.center, { lng: a[0], lat: a[1] }) - distanceMeters(scene.center, { lng: b[0], lat: b[1] }))[0] : geometryPoint(feature.geometry);
    return { sourceId: feature.properties.sourceId, name: feature.properties.name, kind: feature.properties.kind, lng: point[0], lat: point[1], coordinateSource: feature.properties.kind === 'mountain' ? 'nearest actual OSM outer-ring vertex (mountain boundary, not claimed viewpoint)' : 'interior point of actual OSM park polygon' };
  });
  const report = { center: scene.center, radiusMeters: scene.radius, rawElements: elements.length, buildings: buildings.features.length,
    heights: buildings.features.reduce((counts, f) => ({ ...counts, [f.properties.heightSource]: (counts[f.properties.heightSource] ?? 0) + 1 }), {}),
    grounds: grounds.features.reduce((counts, f) => ({ ...counts, [f.properties.kind]: (counts[f.properties.kind] ?? 0) + 1 }), {}),
    targetSports: grounds.features.filter((f) => f.properties.target && ['pitch', 'track'].includes(f.properties.kind)).map((f) => ({ id: f.properties.sourceId, kind: f.properties.kind, sport: f.properties.sport ?? '', geometry: f.geometry.type })),
    campusSportsNote: grounds.features.some((f) => f.properties.target && ['pitch', 'track'].includes(f.properties.kind)) ? 'Only actual OSM campus sports polygons are marked target.' : '本次完整 OSM 快照的目标校园内无 pitch/track；未将校外球场移入校园，未生成跑道。',
    pointOnlyGrounds: elements.filter((e) => e.type === 'node' && groundKind(e)).map((e) => ({ id: osmId(e), kind: groundKind(e), lat: e.lat, lng: e.lon, reason: 'OSM point only; retained as POI, no invented surface polygon.' })),
    pois: pois.length, categories: pois.reduce((counts, p) => ({ ...counts, [p.category]: (counts[p.category] ?? 0) + 1 }), {}),
    stations: pois.filter((p) => p.category === 'transit').map((p) => ({ id: p.id, name: p.name, distance: p.distance, walkingDistance: p.walkingDistance ?? null, walkingUnavailable: p.walkingUnavailable ?? null })),
    mountains: grounds.features.filter((f) => f.properties.kind === 'mountain').map((f) => ({ id: f.properties.sourceId, name: f.properties.name, geometry: f.geometry.type })), tourAnchors, exclusions,
  };
  const metadata = { ...source, osmTimestamp: raw.osm3s?.timestamp_osm_base, center: scene.center, radiusMeters: scene.radius, report, walking };
  const files = { 'jingtai-buildings.geojson': buildings, 'jingtai-buildings-index.json': index, 'jingtai-grounds.geojson': grounds, 'jingtai-pois.json': { type: 'poi-snapshot', center: scene.center, radiusMeters: scene.radius, total: pois.length, pois, source: { attribution: source.attribution, osmTimestamp: metadata.osmTimestamp, rawSha256: source.sha256 } }, 'jingtai-metadata.json': metadata };
  validateJingtai(raw, files);
  return { files, report };
}

export function validateJingtai(raw, files) {
  const require = (condition, message) => { if (!condition) throw new Error(message); };
  const elements = new Map(raw.elements.map((e) => [osmId(e), e]));
  const buildings = files['jingtai-buildings.geojson'], grounds = files['jingtai-grounds.geojson'], index = files['jingtai-buildings-index.json'], snapshot = files['jingtai-pois.json'];
  const campus = grounds.features.find((f) => f.properties.campus);
  require(campus?.properties.osmId === 1178149399 && campus.properties.name === '景泰小学（景泰校区）', 'Wrong campus identity');
  require(pointInGeometry(campus.geometry, 113.26646, 23.17107), 'Wrong campus footprint/position');
  require(campus.properties.street === '云龙路' && campus.properties.house === '38' && campus.properties.height === 0 && campus.properties.base === 0 && campus.properties.category === 'public' && campus.properties.target, 'Wrong campus land-use properties');
  require(index.radiusMeters === 2000 && snapshot.radiusMeters === 2000, 'Expected 2km scene');
  require(snapshot.total === snapshot.pois.length && new Set(snapshot.pois.map((p) => p.id)).size === snapshot.total, 'POI total/duplicate mismatch');
  require(!buildings.features.some((f) => f.properties.osmId === 1178149399), 'Campus land must not be a building');
  require(buildings.features.length > 295, 'Missing 2km building coverage');
  for (const feature of [...buildings.features, ...grounds.features]) {
    const id = feature.properties.sourceId || `way/${feature.properties.osmId}`;
    require(elements.has(id), `Feature has no OSM source: ${id}`);
    require(geometryDistance(feature.geometry) <= 2000, `Feature outside 2km: ${id}`);
    const expected = geometryFromElement(elements.get(id));
    const orientPolygon = (rings) => rings.map((ring, i) => orient(ring, i === 0));
    const actual = { type: feature.geometry.type, coordinates: feature.geometry.type === 'Polygon' ? orientPolygon(feature.geometry.coordinates) : feature.geometry.coordinates.map(orientPolygon) };
    require(JSON.stringify(expected) === JSON.stringify(actual), `Feature geometry differs from raw OSM: ${id}`);
    if (feature.properties.heightSource) {
      const height = buildingHeight(elements.get(id).tags);
      require(feature.properties.height === height.height && feature.properties.heightSource === height.heightSource, `Invented height: ${id}`);
    }
  }
  for (const entry of index.entries) {
    const footprint = entry.campus ? campus : buildings.features.find((f) => f.properties.osmId === entry.osmId);
    require(footprint && pointInGeometry(footprint.geometry, entry.lng, entry.lat), 'Search index point outside footprint');
  }
  require(index.entries.some((entry) => entry.campus && entry.height === 0 && entry.heightSource === 'estimate'), 'Missing campus search entry');
  const pitches = grounds.features.filter((f) => f.properties.kind === 'pitch');
  require(pitches.length >= 5 && new Set(pitches.map((f) => f.properties.sourceId)).size === pitches.length, 'Missing real distinct pitches');
  for (const pitch of grounds.features.filter((f) => ['pitch', 'track'].includes(f.properties.kind))) {
    const contained = exteriorPoints(pitch.geometry).slice(0, -1).every(([lng, lat]) => pointInGeometry(campus.geometry, lng, lat));
    require(pitch.properties.target === contained, 'Incorrect campus sports target');
  }
  for (const name of ['三泰公园东苑', '三泰公园西苑']) require(snapshot.pois.some((p) => p.name === name && p.category === 'park'), `Missing ${name}`);
  const graph = buildWalkingGraph(raw.elements);
  const recomputedStations = snapshot.pois.filter((p) => p.category === 'transit').map(({ name, category, distance }) => ({ name, category, distance }));
  walkingForStations(raw.elements, elements.get(`way/${scene.campusId}`), recomputedStations);
  for (const station of REQUIRED_STATIONS) {
    const poi = snapshot.pois.find((p) => p.category === 'transit' && p.name === `${station.name}站`);
    require(poi && poi.lat === station.lat && poi.lng === station.lng, `Missing/wrong required station: ${station.name}`);
  }
  for (const poi of snapshot.pois) {
    require(elements.has(poi.id) && ['school', 'park', 'transit', 'food', 'shop'].includes(poi.category), 'Invalid POI source/category');
    require(distanceMeters(scene.center, poi) <= 2000 && Math.abs(distanceMeters(scene.center, poi) - poi.distance) <= 1, 'Incorrect POI straight-line distance/radius');
    if (poi.category !== 'transit') continue;
    require(elements.get(poi.id).tags.railway !== 'subway_entrance', 'Entrance counted as station');
    require(new Set(snapshot.pois.filter((p) => p.category === 'transit').map((p) => p.name)).size === snapshot.pois.filter((p) => p.category === 'transit').length, 'Duplicate stations');
    const expectedWalking = recomputedStations.find((p) => p.name === poi.name);
    if (poi.walkingDistance == null) {
      require(Boolean(poi.walkingUnavailable) && !poi.walkingRoute, 'Missing explicit walking limitation');
      require(poi.walkingUnavailable === expectedWalking.walkingUnavailable && JSON.stringify(poi.walking) === JSON.stringify(expectedWalking.walking), 'Walking limitation/evidence differs from raw graph');
      continue;
    }
    require(expectedWalking.walkingDistance != null && poi.walking?.origin && poi.walking?.entrance, 'Walking path lacks verified campus/entrance connection');
    require(JSON.stringify(poi.walking) === JSON.stringify(expectedWalking.walking), 'Walking connection/evidence differs from raw graph');
    const route = shortestWalk(graph, poi.walking.origin.nodeId, [poi.walking.entrance.nodeId]);
    require(route && Math.round(route.distance) === poi.walkingDistance && JSON.stringify(route.geometry) === JSON.stringify(poi.walkingRoute), 'Walking path/distance differs from OSM graph');
    require(JSON.stringify(route.nodeIds) === JSON.stringify(poi.walking.nodeIds) && JSON.stringify(route.wayIds) === JSON.stringify(poi.walking.wayIds), 'Walking node/way evidence differs');
    require(poi.walking.endpointAccessDistances.origin === 0 && poi.walking.endpointAccessDistances.entrance === 0, 'Unverified endpoint connector');
  }
  return true;
}
