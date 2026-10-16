export const SCENES = {
  canton: {
    id: 'canton', name: '广州塔', title: '广州塔与珠江', center: { lat: 23.109, lng: 113.31913 }, radius: 3000,
    buildings: 'canton-buildings.geojson', index: 'canton-buildings-index.json', towerId: 584204634,
    camera: { zoom: 15.5, mobileZoom: 15, landscapeZoom: 14.4, pitch: 62, bearing: -25 },
  },
};

export function resolveScene(search = '') {
  const id = new URLSearchParams(search).get('scene');
  return Object.hasOwn(SCENES, id) ? SCENES[id] : SCENES.canton;
}
