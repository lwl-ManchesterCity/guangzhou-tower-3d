import { DEFAULT_CENTER, VIEW_LIMITS } from './config.js';

// `#map=zoom/lat/lng/bearing/pitch&b=osmId@lat,lng`. The first three parts follow OpenStreetMap's own link order so a
// pasted OSM URL still lands; the selected block carries an interior point of its footprint, because re-opening the
// card works by picking that point back exactly like a click does.
const finite = (value) => Number.isFinite(value);
const near = (value, other) => Math.abs(value - other) <= VIEW_LIMITS.span;
const clamp = (value, [min, max]) => Math.min(max, Math.max(min, value));
const digits = (value, places) => Number(value.toFixed(places));
const wrapped = (bearing) => ((bearing + 180) % 360 + 360) % 360 - 180;

export function parseView(hash) {
  const params = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  const camera = (params.get('map') ?? '').split('/').map(Number);
  const view = camera.every(finite) && camera.length >= 3 && camera.length <= 5
    && Math.abs(camera[1]) <= 85 && Math.abs(camera[2]) <= 180
    && camera[0] >= VIEW_LIMITS.minZoom && camera[0] <= VIEW_LIMITS.maxZoom
    && near(camera[1], DEFAULT_CENTER.lat) && near(camera[2], DEFAULT_CENTER.lng);
  const block = (params.get('b') ?? '').split('@');
  const [id = '', point = ''] = block;
  const coordinates = point.split(',');
  const [lat, lng] = coordinates.map(Number);
  // Way ids travel as plain numbers; anything namespaced keeps its prefix, because the prefix is what tells the card
  // which source to cite. Only the two prefixes the pipeline actually emits may travel: `way/1` matches no feature in
  // either snapshot, so accepting it would hand back a link that silently selects nothing.
  const namespaced = /^(?:relation|eastasia)\/[1-9]\d*$/.test(id);
  const numericId = Number(namespaced ? id.slice(id.indexOf('/') + 1) : id);
  const osmId = namespaced ? id : numericId;
  const selected = block.length === 2 && coordinates.length === 2 && (namespaced || /^\d+$/.test(id))
    && Number.isSafeInteger(numericId) && numericId > 0 && finite(lat) && finite(lng) && near(lat, DEFAULT_CENTER.lat) && near(lng, DEFAULT_CENTER.lng);
  return {
    camera: view ? { zoom: camera[0], center: { lng: camera[2], lat: camera[1] }, bearing: finite(camera[3]) ? camera[3] : 0, pitch: clamp(finite(camera[4]) ? camera[4] : 0, [0, VIEW_LIMITS.maxPitch]) } : null,
    selection: selected ? { osmId, lat, lng } : null,
  };
}

export function formatView({ zoom, center, bearing = 0, pitch = 0 }, selection = null) {
  const camera = [digits(zoom, 2), digits(center.lat, 5), digits(center.lng, 5), digits(wrapped(bearing), 1), digits(pitch, 1)];
  return `#map=${camera.join('/')}${selection ? `&b=${selection.osmId}@${digits(selection.lat, 6)},${digits(selection.lng, 6)}` : ''}`;
}
