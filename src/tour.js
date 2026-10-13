import { DEFAULT_CENTER, SCENE, TOWER_OSM_ID } from './config.js';

export const TOUR_STOPS = SCENE.id === 'jingtai' ? [
  { name: '景泰小学（景泰校区）', bank: '校园', center: [DEFAULT_CENTER.lng, DEFAULT_CENTER.lat], zoom: 16.7, pitch: 57, bearing: 0, osmId: 1178149399, sourceId: 'way/1178149399',
    description: '从云龙路38号出发，查看校园真实边界；本次 OSM 快照的目标校园内无 pitch/track，未生成跑道。' },
  { name: '三泰公园东苑', bank: '街区', center: [113.2634346, 23.1674743], zoom: 17.5, pitch: 50, bearing: -20, osmId: 337541381, sourceId: 'way/337541381',
    description: '近看三泰公园东苑，镜头落在实际 OSM 公园多边形内部。' },
  { name: '三泰公园西苑', bank: '街区', center: [113.2611534, 23.1676484], zoom: 17.5, pitch: 50, bearing: 25, osmId: 337541386, sourceId: 'way/337541386',
    description: '转向三泰公园西苑，查看街区中的另一片真实公园绿地。' },
  { name: '白云山林地边界', bank: '山脚', center: [113.2693872, 23.1707658], zoom: 16.6, pitch: 55, bearing: 70, osmId: 8249243, sourceId: 'relation/8249243',
    description: '此处仅标示白云山的 OSM 林地边界，不是观景台，未重建三维高程；这是一程山脚镜头导览，不是步行路线。' },
] : [
  { name: '广州塔', bank: '南岸', center: [DEFAULT_CENTER.lng, DEFAULT_CENTER.lat], zoom: 15.4, pitch: 58, bearing: -25, osmId: TOWER_OSM_ID,
    description: '从珠江南岸出发，隔江望向珠江新城。' },
  { name: '海心桥', bank: '江上', center: [113.314334, 23.1110888], zoom: 16, pitch: 45, bearing: 35, osmId: 1313608038,
    description: '步行拱桥横跨珠江；桥面按 OSM 的闭合轮廓立起，净空与厚度是示意，拱肋尚未重建。' },
  { name: '花城广场', bank: '北岸', center: [113.319181, 23.122579], zoom: 15.7, pitch: 40, bearing: 180, osmId: 243319596,
    description: '沿花城广场向南望，绿地串起珠江新城的中轴线。' },
  { name: '广州图书馆', bank: '北岸', center: [113.3206608, 23.1189093], zoom: 17, pitch: 48, bearing: 35, osmId: 240896441,
    description: '在花城广场东侧的广州图书馆，结束这程两岸眺望。' },
];

export const TOUR_DWELL_MS = 7000;

export function createTour(map, { camera, onChange }) {
  let index = -1, playing = false, travelling = false, timer, arrival;
  const publish = () => onChange({ index, playing, travelling });
  function cancel() {
    clearTimeout(timer);
    if (arrival) map.off('moveend', arrival);
    arrival = undefined;
  }
  function schedule() {
    clearTimeout(timer);
    if (playing) timer = setTimeout(() => {
      if (index === TOUR_STOPS.length - 1) exit();
      else visit(index + 1);
    }, TOUR_DWELL_MS);
  }
  function visit(next) {
    cancel();
    map.stop();
    index = next;
    travelling = true;
    publish();
    arrival = () => {
      arrival = undefined;
      travelling = false;
      publish();
      schedule();
    };
    map.once('moveend', arrival);
    map.flyTo(camera(TOUR_STOPS[index]));
  }
  function exit() {
    if (index < 0) return;
    cancel();
    index = -1;
    playing = false;
    travelling = false;
    map.stop();
    publish();
  }
  return {
    get active() { return index >= 0; },
    start(autoplay = true) { playing = autoplay; visit(0); },
    exit,
    step(delta) {
      if (index < 0) return;
      const next = index + delta;
      if (next >= TOUR_STOPS.length) exit();
      else if (next >= 0) visit(next);
    },
    toggle() {
      if (index < 0) return;
      playing = !playing;
      if (!playing) { cancel(); map.stop(); publish(); }
      else if (travelling) visit(index);
      else { publish(); schedule(); }
    },
    reframe() { if (index >= 0) visit(index); },
  };
}
