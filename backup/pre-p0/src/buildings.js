import { DEFAULT_BUILDING_HEIGHT, DEFAULT_CENTER, RADIUS_METERS, TOWER_OSM_ID } from './config.js';
import { featureCollection, METERS_PER_DEGREE } from './geo.js';

const categories = {
  commercial: ['commercial', 'retail', 'office', 'hotel', 'wholesale'],
  residential: ['apartments', 'residential', 'dormitory', 'house', 'detached', 'terrace'],
  public: ['public', 'public_building', 'university', 'hospital', 'school', 'government', 'kindergarten', 'college', 'sports_hall', 'stadium', 'train_station', 'transportation', 'church', 'religious', 'temple', 'grandstand'],
};

export const categoryLabels = { commercial: '商业办公', residential: '住宅', public: '公共设施', unknown: '未分类' };

const typeLabels = {
  apartments: '公寓楼', residential: '住宅楼', house: '住宅', detached: '独栋住宅', terrace: '联排住宅',
  commercial: '商业楼', retail: '零售商业', office: '办公楼', hotel: '酒店', wholesale: '批发市场',
  university: '大学建筑', college: '学院建筑', school: '学校建筑', kindergarten: '幼儿园', dormitory: '宿舍楼',
  hospital: '医院建筑', government: '政府建筑', public: '公共建筑', public_building: '公共建筑',
  train_station: '火车站', transportation: '交通建筑', stadium: '体育场', sports_hall: '体育馆', grandstand: '看台',
  church: '教堂', religious: '宗教建筑', temple: '寺庙', industrial: '工业厂房', service: '配套服务用房',
  construction: '在建建筑', roof: '顶棚', civic: '公共设施', tower: '塔', manufacture: '生产厂房',
  parking: '停车楼', container: '集装箱活动房', garage: '车库', porch: '门廊', hut: '小屋',
};

const placeLabels = {
  mall: '购物中心', restaurant: '餐厅', library: '图书馆', museum: '博物馆', theatre: '剧院', arts_centre: '艺术中心',
  marketplace: '市场', police: '派出所', fire_station: '消防站', courthouse: '法院', place_of_worship: '宗教场所',
  hospital: '医院', school: '学校', government: '政府办公', company: '公司办公', research: '科研办公',
  hotel: '酒店', sports_centre: '体育中心', sports_hall: '体育馆', stadium: '体育场', shelter: '遮雨棚', toilets: '公厕',
  public_building: '公共建筑', kindergarten: '幼儿园', community_centre: '社区中心', hostel: '旅舍', studio: '工作室',
  parking: '停车场', exhibition_centre: '展览中心', cafe: '咖啡厅', clinic: '诊所', bus_station: '公交站房',
  childcare: '托幼机构', ferry_terminal: '客运码头', water_utility: '供水设施', townhall: '市政厅', attraction: '旅游景点',
  political_party: '政党机关', energy_supplier: '能源供应', canteen: '食堂', grave_yard: '墓地', tomb: '墓葬',
  religion: '宗教场所', convenience: '便利店', supermarket: '超市', department_store: '百货商店', gallery: '画廊',
  garden: '庭园', it: 'IT 办公', music: '音乐工作室', books: '书店', apartment: '公寓', post_office: '邮局',
  educational_institution: '教育机构', food_court: '美食广场', social_facility: '社会服务设施', ticket: '售票处',
};

export function buildingLabel(type) {
  return typeLabels[type] ?? null;
}

export function placeLabel(place) {
  return placeLabels[place] ?? null;
}

// OSM housenumbers here come in two shapes: bare ("33") and already suffixed ("795号", "1-2层", "35号（北）39号（南）").
// Appending 号 to the second shape reads "795号 号", so the suffix is only added to a bare number.
export function formatAddress(street, house) {
  if (!street) return '';
  if (!house) return street;
  return /^\d+(?:\s*-\s*\d+)?$/.test(house.trim()) ? `${street} ${house} 号` : `${street} ${house}`;
}

export function buildingCategory(tags) {
  const type = tags.building && tags.building !== 'yes' ? tags.building : tags['building:part'];
  return Object.entries(categories).find(([, values]) => values.includes(type))?.[0] ?? 'unknown';
}

const placeKeys = ['amenity', 'shop', 'office', 'tourism', 'leisure', 'historic'];

// Only whitelisted tags reach the snapshot: untrusted OSM text stays out of the bundle except the labels the card shows.
export function buildingLabels(tags) {
  const type = tags.building && tags.building !== 'yes' ? tags.building : tags['building:part'];
  const place = placeKeys.map((key) => tags[key]).find((value) => value && value !== 'yes');
  return {
    ...(tags.name ? { name: tags.name } : {}),
    ...(tags['name:en'] ? { nameEn: tags['name:en'] } : {}),
    ...(type && type !== 'yes' ? { type } : {}),
    ...(place ? { place } : {}),
    ...(tags['addr:street'] ? { street: tags['addr:street'] } : {}),
    ...(tags['addr:housenumber'] ? { house: tags['addr:housenumber'] } : {}),
    ...(tags.start_date ? { built: tags.start_date } : {}),
  };
}

function numericTag(value) {
  if (typeof value !== 'string' || !/^\s*\d+(?:\.\d+)?\s*(?:m)?\s*$/.test(value)) return null;
  return Number.parseFloat(value);
}

export function buildingHeight(tags) {
  const height = numericTag(tags.height);
  const levels = numericTag(tags['building:levels']);
  const base = numericTag(tags.min_height) ?? (numericTag(tags['building:min_level']) ?? 0) * 3.2;
  return { height: height ?? (levels ? levels * 3.2 : DEFAULT_BUILDING_HEIGHT), base, heightSource: height !== null ? 'height' : levels ? 'levels' : 'estimate', levels: height === null ? levels : null };
}

// Ray casting against a closed [lng, lat] ring, so the last vertex repeats the first.
export function insideRing(ring, lng, lat) {
  let inside = false;
  for (let i = 1, j = 0; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a[1] > lat) !== (b[1] > lat) && lng < (b[0] - a[0]) * (lat - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

// Shortest distance from a point to a Polygon/MultiPolygon outline, in metres: 0 anywhere inside the footprint
// (holes keep their own interior), otherwise the nearest point of any edge. Vertex sampling alone overestimates a
// long thin block that crosses the radius line with every corner outside it, so it silently deletes real buildings.
// The plane is tangent at the query point: over 2 km the sphere correction is far below the metre the callers round to.
export function distanceToGeometry(center, geometry) {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
  if (!polygons.length) throw new Error(`distanceToGeometry needs Polygon or MultiPolygon, got ${geometry.type}`);
  const inside = (lng, lat) => polygons.some((rings) => insideRing(rings[0], lng, lat) && !rings.slice(1).some((ring) => insideRing(ring, lng, lat)));
  if (inside(center.lng, center.lat)) return 0;
  const scale = [Math.cos(center.lat * Math.PI / 180) * METERS_PER_DEGREE, METERS_PER_DEGREE];
  const plane = ([lng, lat]) => [(lng - center.lng) * scale[0], (lat - center.lat) * scale[1]];
  let best = Infinity;
  for (const rings of polygons) for (const ring of rings) {
    const closed = ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1];
    const edges = Array.from({ length: ring.length - (closed ? 1 : 0) }, (_, i) => i + 1);
    if (!closed) edges.push(0);
    for (const i of edges) {
      const a = plane(ring[i - 1]), b = plane(ring[i % ring.length]);
      const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
      const length = dx * dx + dy * dy;
      const t = length ? Math.max(0, Math.min(1, -(a[0] * dx + a[1] * dy) / length)) : 0;
      best = Math.min(best, Math.hypot(a[0] + t * dx, a[1] + t * dy));
    }
  }
  return best;
}

// Area centroid of a closed [lng, lat] ring. The ring is shifted to its own first vertex first: these footprints span
// ~1e-4 degrees at coordinates around 113/23, so the shoelace products would otherwise cancel to noise.
export function ringCentroid(ring) {
  const rest = ring.slice(0, -1);
  const average = [rest.reduce((sum, p) => sum + p[0], 0) / rest.length, rest.reduce((sum, p) => sum + p[1], 0) / rest.length];
  const [origin, span] = [average, ring.reduce((box, p) => [Math.max(box[0], Math.abs(p[0] - average[0])), Math.max(box[1], Math.abs(p[1] - average[1]))], [0, 0])];
  let twiceArea = 0, lng = 0, lat = 0;
  for (let i = 1; i < ring.length; i++) {
    const a = [ring[i - 1][0] - origin[0], ring[i - 1][1] - origin[1]];
    const b = [ring[i][0] - origin[0], ring[i][1] - origin[1]];
    const cross = a[0] * b[1] - b[0] * a[1];
    twiceArea += cross;
    lng += (a[0] + b[0]) * cross;
    lat += (a[1] + b[1]) * cross;
  }
  // A ring that fills almost none of its own bounding box is a sliver or a duplicated outline, and its centroid is noise.
  return Math.abs(twiceArea) < span[0] * span[1] ? average : [origin[0] + lng / (3 * twiceArea), origin[1] + lat / (3 * twiceArea)];
}

// Search results and shared links pick a block by projecting a point of its own footprint, but a concave ring's
// centroid can fall outside the building it describes. Walking out from the centroid in widening rings keeps the
// stored point inside the outline, and near the middle so the card sits on the block rather than on a wing tip.
export function interiorPoint(ring) {
  const [ax, ay] = ringCentroid(ring);
  const [bx, by] = ring.reduce((max, p) => [Math.max(max[0], Math.abs(p[0] - ax)), Math.max(max[1], Math.abs(p[1] - ay))], [0, 0]);
  const span = Math.max(bx, by) * 2;
  const round = ([lng, lat]) => [Number(lng.toFixed(7)), Number(lat.toFixed(7))];
  const steps = Array.from({ length: 12 }, (_, step) => Array.from({ length: 16 }, (_, spoke) => {
    const angle = Math.PI / 8 * spoke + (step % 2) * Math.PI / 16;
    return [Math.cos(angle) * span * (step + 1) / 24, Math.sin(angle) * span * (step + 1) / 24];
  })).flat();
  for (const point of [[ax, ay], ...steps.map(([dx, dy]) => [ax + dx, ay + dy]), ring]) {
    if (insideRing(ring, point[0], point[1])) return round(point);
  }
  return round(ring.reduce((best, p) => (Math.hypot(p[0] - ax, p[1] - ay) < Math.hypot(best[0] - ax, best[1] - ay) ? p : best), ring[0]));
}

// Blocks the search box can actually match on: OSM names first, street addresses second. The tower outline joins the
// list so the scene's own landmark is findable, even though its mesh is parametric rather than snapshot geometry.
export function searchIndex(features, { center = DEFAULT_CENTER, radius = RADIUS_METERS } = {}) {
  const entries = features.flatMap((feature) => {
    const { osmId, name, nameEn, street, house, category, height, heightSource, distance, tower } = feature.properties;
    if (!tower && !name && !street) return [];
    const [lng, lat] = interiorPoint(feature.geometry.coordinates[0]);
    return [{
      osmId,
      ...(tower ? { tower: true } : {}),
      name: name ?? '', nameEn: nameEn ?? '', street: street ?? '', house: house ?? '',
      category: tower ? 'public' : category,
      // The card spells out where a height came from, so the result line needs the same provenance: most blocks carry
      // the default 9.6 m, and printing that as "高 10 m" would read like an OSM measurement.
      height: Math.round(height ?? 0), heightSource: heightSource ?? 'estimate', distance, lat, lng,
    }];
  }).sort((a, b) => a.distance - b.distance);
  return { type: 'building-search-index', center, radiusMeters: radius, entries };
}

export function normalizeBuildings(elements, { center = DEFAULT_CENTER, radius = RADIUS_METERS, towerId = TOWER_OSM_ID } = {}) {
  const seen = new Set();
  const towerOutline = (elements.find((element) => element.id === towerId)?.geometry ?? []).map((p) => [p.lon, p.lat]);
  return featureCollection(elements.flatMap((element) => {
    if (element.type !== 'way' || !Number.isSafeInteger(element.id) || element.id <= 0 || seen.has(element.id) || element.id === towerId) return [];
    seen.add(element.id);
    const tags = element.tags ?? {};
    if (!tags.building && !tags['building:part']) return [];
    const points = element.geometry;
    if (!Array.isArray(points) || points.length < 4 || points.some((p) => !Number.isFinite(p.lat) || !Number.isFinite(p.lon) || Math.abs(p.lat) > 85 || Math.abs(p.lon) > 180)) return [];
    if (points[0].lat !== points.at(-1).lat || points[0].lon !== points.at(-1).lon) return [];
    if (tags['building:part'] && towerOutline.length) {
      const centroid = points.slice(0, -1).reduce((sum, p) => ({ lat: sum.lat + p.lat / (points.length - 1), lon: sum.lon + p.lon / (points.length - 1) }), { lat: 0, lon: 0 });
      if (insideRing(towerOutline, centroid.lon, centroid.lat)) return [];
    }
    const ring = points.map((p) => [Number(p.lon.toFixed(7)), Number(p.lat.toFixed(7))]);
    const distance = distanceToGeometry(center, { type: 'Polygon', coordinates: [ring] });
    if (distance > radius) return [];
    const { height, base, heightSource, levels } = buildingHeight(tags);
    if (height <= base || tags.location === 'underground' || Number(tags['building:levels']) < 0) return [];
    const origin = ring[0];
    const metersX = Math.cos(center.lat * Math.PI / 180) * 111195;
    const area = Math.abs(ring.slice(1).reduce((sum, point, index) => sum + (ring[index][0] - origin[0]) * (point[1] - origin[1]) - (point[0] - origin[0]) * (ring[index][1] - origin[1]), 0)) * metersX * 111195 / 2;
    return [{ type: 'Feature', id: element.id, properties: { osmId: element.id, category: buildingCategory(tags), height, base, heightSource, distance: Math.round(distance), area: Math.round(area), ...(levels ? { levels } : {}), ...buildingLabels(tags) }, geometry: { type: 'Polygon', coordinates: [ring] } }];
  }));
}

// The tower mesh is parametric, so the real outline is kept only as an invisible hit target and label source.
export function towerFeature(elements) {
  const element = elements.find((item) => item.type === 'way' && item.id === TOWER_OSM_ID);
  if (!element?.geometry?.length) return null;
  const ring = element.geometry.map((p) => [Number(p.lon.toFixed(7)), Number(p.lat.toFixed(7))]);
  if (ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1]) ring.push([...ring[0]]);
  const tags = element.tags ?? {};
  return { type: 'Feature', id: element.id, properties: { osmId: element.id, tower: true, kind: tags.man_made ?? 'tower', distance: 0, ...buildingLabels(tags) }, geometry: { type: 'Polygon', coordinates: [ring] } };
}
