export const EARTH_RADIUS = 6371008.8;
export const METERS_PER_DEGREE = EARTH_RADIUS * Math.PI / 180;
const radians = (degrees) => degrees * Math.PI / 180;
const degrees = (angle) => angle * 180 / Math.PI;

export function distanceMeters(a, b) {
  const deltaLat = radians(b.lat - a.lat);
  const deltaLng = radians(b.lng - a.lng);
  const value = Math.sin(deltaLat / 2) ** 2 + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(deltaLng / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.sqrt(Math.min(1, value)));
}

export function radiusPolygon(center, radius, segments = 96) {
  const latitude = radians(center.lat);
  const longitude = radians(center.lng);
  const angularDistance = radius / EARTH_RADIUS;
  const points = Array.from({ length: segments }, (_, index) => {
    const bearing = 2 * Math.PI * index / segments;
    const lat = Math.asin(Math.sin(latitude) * Math.cos(angularDistance) + Math.cos(latitude) * Math.sin(angularDistance) * Math.cos(bearing));
    const lng = longitude + Math.atan2(Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latitude), Math.cos(angularDistance) - Math.sin(latitude) * Math.sin(lat));
    return [degrees(lng), degrees(lat)];
  });
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[...points, points[0]]] } };
}

export function coordinateKey(center, radius) {
  return `${center.lat.toFixed(6)},${center.lng.toFixed(6)},${radius}`;
}

export function formatCoordinates({ lat, lng }) {
  return `${Math.abs(lat).toFixed(5)}° ${lat < 0 ? 'S' : 'N'} · ${Math.abs(lng).toFixed(5)}° ${lng < 0 ? 'W' : 'E'}`;
}

export function featureCollection(features = []) {
  return { type: 'FeatureCollection', features };
}
