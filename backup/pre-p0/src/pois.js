import { MAX_VISIBLE_POIS, OVERPASS_ENDPOINTS, POI_CACHE_SIZE, POI_CATEGORIES, RADIUS_METERS } from './config.js';
import { coordinateKey, distanceMeters, featureCollection } from './geo.js';

const TYPE_LABELS = {
  restaurant: '餐厅', cafe: '咖啡馆', fast_food: '快餐', bar: '酒吧', pub: '酒馆', food_court: '美食广场', ice_cream: '冰淇淋店',
  place_of_worship: '宗教建筑', museum: '博物馆', gallery: '美术馆', artwork: '公共艺术', attraction: '景点', viewpoint: '观景点', information: '游客信息',
  station: '车站', subway_entrance: '地铁出入口', bus_stop: '公交站', convenience: '便利店', supermarket: '超市', bakery: '面包店', clothes: '服装店', books: '书店',
};

export function buildQuery(center, radius = RADIUS_METERS) {
  const around = `(around:${radius},${center.lat.toFixed(6)},${center.lng.toFixed(6)})`;
  const selectors = Object.values(POI_CATEGORIES).flatMap((category) => category.selectors);
  return `[out:json][timeout:25];(${selectors.map((selector) => `nwr${around}${selector};`).join('')});out center tags;`;
}

export function normalizePois(elements, center, radius = RADIUS_METERS) {
  const seen = new Set();
  return elements.flatMap((element) => {
    const id = `${element.type}/${element.id}`;
    if (!['node', 'way', 'relation'].includes(element.type) || !Number.isSafeInteger(element.id) || element.id <= 0 || seen.has(id)) return [];
    seen.add(id);
    const lat = element.lat ?? element.center?.lat;
    const lng = element.lon ?? element.center?.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return [];
    const distance = distanceMeters(center, { lat, lng });
    if (distance > radius) return [];
    const tags = element.tags ?? {};
    const category = tags.railway || tags.highway === 'bus_stop' ? 'transit' : tags.shop ? 'shop' : tags.tourism || tags.amenity === 'place_of_worship' ? 'visit' : 'food';
    const type = tags.shop || tags.tourism || tags.railway || tags.highway || tags.amenity;
    const label = TYPE_LABELS[type] || POI_CATEGORIES[category].label;
    const name = tags['name:zh'] || tags.name || tags['name:en'] || `${label}（未命名）`;
    const address = tags['addr:full'] || [tags['addr:street'], tags['addr:housenumber']].filter(Boolean).join(' ');
    return [{ id, lat, lng, distance: Math.round(distance), name: String(name), category, label, address: String(address || ''), openingHours: String(tags.opening_hours || ''), osmUrl: `https://www.openstreetmap.org/${id}` }];
  }).sort((a, b) => a.distance - b.distance);
}

export function poisGeoJSON(pois) {
  return featureCollection(pois.map((poi) => ({ type: 'Feature', properties: { id: poi.id, name: poi.name, category: poi.category }, geometry: { type: 'Point', coordinates: [poi.lng, poi.lat] } })));
}

export function createPoiService({ fetcher = globalThis.fetch, endpoints = OVERPASS_ENDPOINTS, cacheSize = POI_CACHE_SIZE, timeoutMs = 30000 } = {}) {
  const cache = new Map();
  const pending = new Map();

  async function request(center, radius) {
    for (let index = 0; index < endpoints.length; index++) {
      try {
        const response = await fetcher(endpoints[index], {
          method: 'POST', body: new URLSearchParams({ data: buildQuery(center, radius) }),
          credentials: 'omit', signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'application/json' },
        });
        if (response.status === 429) throw new Error('查询较频繁，请稍后点击「重新加载地点」。');
        if (!response.ok) throw new Error(`地点服务暂时不可用（HTTP ${response.status}）。`);
        const data = await response.json();
        if (!Array.isArray(data.elements) || data.remark) throw new Error('地点查询未完成，请稍后重试。');
        const all = normalizePois(data.elements, center, radius);
        return { pois: all.slice(0, MAX_VISIBLE_POIS), total: all.length };
      } catch (error) {
        if (index === endpoints.length - 1 || error.message.includes('查询较频繁')) {
          if (error.name === 'TimeoutError') throw new Error('地点查询超时。地图仍可浏览，请稍后重新加载地点。');
          if (error instanceof TypeError || error instanceof SyntaxError) throw new Error('暂时无法连接地点服务，请检查网络后重试。');
          throw error;
        }
      }
    }
  }

  return {
    async load(center, radius = RADIUS_METERS) {
      const key = coordinateKey(center, radius);
      if (cache.has(key)) {
        const result = cache.get(key);
        cache.delete(key);
        cache.set(key, result);
        return { ...result, cached: true };
      }
      if (pending.has(key)) return pending.get(key);
      const promise = request(center, radius).then((result) => {
        cache.set(key, result);
        if (cache.size > cacheSize) cache.delete(cache.keys().next().value);
        return { ...result, cached: false };
      }).finally(() => pending.delete(key));
      pending.set(key, promise);
      return promise;
    },
  };
}
