import { pointInGeometry } from './jingtai-data.js';

const METRES_PER_DEGREE_LAT = 110540;
const metresPerDegreeLng = (lat) => 111320 * Math.cos(lat * Math.PI / 180);

const metres = (a, b) => Math.hypot((b[0] - a[0]) * metresPerDegreeLng(a[1]), (b[1] - a[1]) * METRES_PER_DEGREE_LAT);

// A gate or a shop entrance sits on the edge of its estate, so distance to the boundary is what decides a near miss.
function toRing(point, ring) {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const span = dx * dx + dy * dy;
    const t = span ? Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / span)) : 0;
    best = Math.min(best, metres(point, [a[0] + t * dx, a[1] + t * dy]));
  }
  return best;
}

const rings = (geometry) => (geometry.type === 'Polygon' ? [geometry.coordinates[0]] : geometry.coordinates.map((polygon) => polygon[0]));
const centreOf = (geometry) => {
  const points = rings(geometry).flat();
  return [points.reduce((sum, p) => sum + p[0], 0) / points.length, points.reduce((sum, p) => sum + p[1], 0) / points.length];
};

// The snapshot is served only by the dev server, so "no names" is a normal state rather than an error: every failure
// path returns null and the caller keeps the plain card.
export async function loadAmapPlaces(fetcher, url, timeoutMs = 10000) {
  try {
    const response = await fetcher(url, { credentials: 'omit', signal: AbortSignal.timeout(timeoutMs) });
    if (!response?.ok) return null;
    const data = await response.json();
    const places = Array.isArray(data?.places)
      ? data.places.filter((place) => place?.name && place.id && Number.isFinite(place.at?.[0]) && Number.isFinite(place.at?.[1]))
      : [];
    return places.length ? places : null;
  } catch {
    return null;
  }
}

// One Amap place per merged shape. A place inside the envelope wins over one beside it, and the closest to the middle
// of the block wins among several, so the same snapshot always yields the same name.
export function nameGroups(shapes, places, { maxMeters = 40 } = {}) {
  const named = new Map();
  for (const shape of shapes) {
    const id = shape.properties?.groupId;
    if (!id) continue;
    const geometry = shape.geometry;
    const centre = centreOf(geometry);
    const matched = places
      .map((place) => ({ place, inside: pointInGeometry(geometry, ...place.at), distance: rings(geometry).reduce((best, ring) => Math.min(best, toRing(place.at, ring)), Infinity) }))
      .filter((hit) => hit.inside || hit.distance <= maxMeters)
      .sort((a, b) => Number(b.inside) - Number(a.inside)
        || metres(a.place.at, centre) - metres(b.place.at, centre)
        || a.place.id.localeCompare(b.place.id, 'en'));
    if (!matched.length) continue;
    const [best, ...rest] = matched;
    named.set(String(id), {
      name: best.place.name,
      id: best.place.id,
      type: best.place.type,
      inside: best.inside,
      distance: best.inside ? 0 : Math.round(best.distance),
      others: rest.length,
    });
  }
  return named;
}
