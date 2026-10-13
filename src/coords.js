// Amap reports positions in GCJ-02 while every other layer here is WGS-84, so the two never share a coordinate.
// Algorithm after the MIT-licensed coordtransform reference implementation.
const PI = Math.PI;
const SEMI_MAJOR = 6378245;
const FLATTENING = 0.00669342162296594323;

const shiftLat = (lng, lat) => -100 + 2 * lng + 3 * lat + 0.2 * lat * lat + 0.1 * lng * lat + 0.2 * Math.sqrt(Math.abs(lng))
  + (20 * Math.sin(6 * lng * PI) + 20 * Math.sin(2 * lng * PI)) * 2 / 3
  + (20 * Math.sin(lat * PI) + 40 * Math.sin(lat / 3 * PI)) * 2 / 3
  + (160 * Math.sin(lat / 12 * PI) + 320 * Math.sin(lat * PI / 30)) * 2 / 3;

const shiftLng = (lng, lat) => 300 + lng + 2 * lat + 0.1 * lng * lng + 0.1 * lng * lat + 0.1 * Math.sqrt(Math.abs(lng))
  + (20 * Math.sin(6 * lng * PI) + 20 * Math.sin(2 * lng * PI)) * 2 / 3
  + (20 * Math.sin(lng * PI) + 40 * Math.sin(lng / 3 * PI)) * 2 / 3
  + (150 * Math.sin(lng / 12 * PI) + 300 * Math.sin(lng / 30 * PI)) * 2 / 3;

function shift([lng, lat]) {
  const radLat = lat / 180 * PI;
  const magic = 1 - FLATTENING * Math.sin(radLat) ** 2;
  const root = Math.sqrt(magic);
  return [
    (shiftLng(lng - 105, lat - 35) * 180) / (SEMI_MAJOR / root * Math.cos(radLat) * PI),
    (shiftLat(lng - 105, lat - 35) * 180) / ((SEMI_MAJOR * (1 - FLATTENING)) / (magic * root) * PI),
  ];
}

export function wgs84ToGcj02(point) {
  const [dLng, dLat] = shift(point);
  return [point[0] + dLng, point[1] + dLat];
}

export function gcj02ToWgs84(point) {
  const [dLng, dLat] = shift(point);
  return [point[0] - dLng, point[1] - dLat];
}
