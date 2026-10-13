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

// A point `metres` from `from` on a compass bearing, on the sphere the data is stored on.
export function destination(from, metres, bearing) {
  const phi = radians(from.lat), lambda = radians(from.lng), delta = metres / EARTH_RADIUS, theta = radians(bearing);
  const sinTo = Math.sin(phi) * Math.cos(delta) + Math.cos(phi) * Math.sin(delta) * Math.cos(theta);
  const cosTo = Math.sqrt(Math.max(0, 1 - sinTo * sinTo));
  const to = lambda + Math.atan2(Math.sin(theta) * Math.sin(delta) * Math.cos(phi), Math.cos(delta) - Math.sin(phi) * sinTo);
  return { lng: degrees(to), lat: degrees(Math.atan2(sinTo, cosTo)) };
}

// Distance and direction on the plane the map actually rotates. Measuring on the sphere instead puts the bearing out
// by about a third of a degree at this latitude, which is visible as a label that does not sit under its own building.
export function plane(from, to) {
  const per = 2 * Math.PI * EARTH_RADIUS * Math.cos(radians((from.lat + to.lat) / 2));
  const mercatorY = (latitude) => (180 - Math.log(Math.tan(Math.PI / 4 + radians(latitude) / 2)) / radians(1)) / 360;
  const dx = ((to.lng - from.lng) / 360) * per;
  const dy = (mercatorY(from.lat) - mercatorY(to.lat)) * per;
  return { dx, dy, distance: Math.hypot(dx, dy) };
}

// MapLibre's own perspective camera: a 36.87° vertical field, and a world of 512 px tiles.
export const CAMERA_FOV = 36.87;
export const CAMERA_TILE = 512;

/**
 * The camera that puts the eye `metres` from `target` and `altitude` above the ground it stands on, looking at the
 * target's own level. Distance and altitude are the two numbers a shot is written with; pitch, bearing and zoom are
 * what the camera has to be to satisfy them, which is what stops a placement that reads well on paper from turning
 * into a camera the map then clamps.
 *
 * @param {{target: {lat: number, lng: number}, metres: number, altitude: number, around: number, height: number}} placement
 *   `around` is the compass bearing from the target to the eye; `height` is the canvas the perspective is scaled by.
 */
export function cameraFromPlacement({ target, metres, altitude, around, height }) {
  const eye = destination(target, metres, around);
  const { dx, dy, distance } = plane(eye, target);
  const line = Math.hypot(distance, altitude);
  const cameraToCenter = 0.5 / Math.tan(radians(CAMERA_FOV) / 2) * height;
  return {
    center: [target.lng, target.lat],
    pitch: degrees(Math.atan2(distance, altitude)),
    bearing: (degrees(Math.atan2(dx, dy)) + 360) % 360,
    zoom: Math.log2(cameraToCenter * 2 * Math.PI * EARTH_RADIUS * Math.cos(radians(target.lat)) / (line * CAMERA_TILE)),
  };
}

export function formatCoordinates({ lat, lng }) {
  return `${Math.abs(lat).toFixed(5)}° ${lat < 0 ? 'S' : 'N'} · ${Math.abs(lng).toFixed(5)}° ${lng < 0 ? 'W' : 'E'}`;
}

export function featureCollection(features = []) {
  return { type: 'FeatureCollection', features };
}
