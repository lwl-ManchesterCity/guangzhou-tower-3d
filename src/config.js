import { resolveScene } from './scenes.js';

export const SCENE = resolveScene(globalThis.location?.search);
export const DEFAULT_CENTER = SCENE.center;
export const RADIUS_METERS = SCENE.radius;
export const TOWER_OSM_ID = 584204634;
export const DEFAULT_BUILDING_HEIGHT = 9.6;
export const MAX_VISIBLE_POIS = 200;
export const POI_CACHE_SIZE = 32;
export const MAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
// Shared in the map constructor and in the URL hash, so a link written by one viewport is readable by the next.
export const VIEW_LIMITS = { minZoom: 10, maxZoom: 18.5, maxPitch: 70, span: 0.3 };
export const OVERPASS_ENDPOINTS = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
];
export const BUILDING_COLORS = { commercial: '#c98a6b', residential: '#d9cfc0', public: '#8fa8bd', unknown: '#c9c4bb' };
export const POI_CATEGORIES = {
  ...(SCENE.id === 'jingtai' ? {
    school: { label: '学校', color: '#667f93', icon: 'visit', selectors: ['[amenity=school]'] },
    park: { label: '公园球场', color: '#62836a', icon: 'park', selectors: ['[leisure~"^(park|pitch)$"]'] },
    transit: { label: '地铁', color: '#527764', icon: 'transit', selectors: ['[railway=station][station=subway]'] },
  } : {}),
  food: { label: '餐饮', color: '#a36548', icon: 'food', selectors: ['[amenity~"^(restaurant|cafe|fast_food|bar|pub|food_court|ice_cream)$"]'] },
  ...(SCENE.id === 'canton' ? {
    visit: { label: '游览', color: '#5c7896', icon: 'visit', selectors: ['[tourism~"^(attraction|museum|gallery|artwork|viewpoint|information)$"]', '[amenity=place_of_worship]'] },
    transit: { label: '出行', color: '#527764', icon: 'transit', selectors: ['[railway=station]', '[railway=subway_entrance]', '[highway=bus_stop]'] },
  } : {}),
  shop: { label: '购物', color: '#92714a', icon: 'shop', selectors: ['[shop]'] },
};
