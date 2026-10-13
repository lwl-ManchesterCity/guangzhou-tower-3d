export const SCENES = {
  canton: {
    id: 'canton', name: '广州塔', title: '广州塔与珠江', center: { lat: 23.109, lng: 113.31913 }, radius: 3000,
    buildings: 'canton-buildings.geojson', index: 'canton-buildings-index.json', towerId: 584204634,
    camera: { zoom: 15.5, mobileZoom: 15, landscapeZoom: 14.4, pitch: 62, bearing: -25 },
  },
  jingtai: {
    id: 'jingtai', name: '景泰小学（景泰校区）', title: '山脚下的小学', center: { lat: 23.17107, lng: 113.26646 }, radius: 2000,
    buildings: 'jingtai-buildings.geojson', index: 'jingtai-buildings-index.json', campusId: 1178149399,
    grounds: 'jingtai-grounds.geojson', pois: 'jingtai-pois.json',
    camera: { zoom: 16.65, mobileZoom: 16.7, landscapeZoom: 16.45, pitch: 58, bearing: 0 },
  },
};

export function resolveScene(search = '') {
  const id = new URLSearchParams(search).get('scene');
  return Object.hasOwn(SCENES, id) ? SCENES[id] : SCENES.canton;
}
