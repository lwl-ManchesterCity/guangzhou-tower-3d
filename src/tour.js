import { DEFAULT_CENTER, TOWER_OSM_ID } from './config.js';

// 八站。前四站自 2026-07 起就在这条线上，后四站的落点**不另写一遍**：它们逐位取自
// `src/landmarks.js` 那张地标表——镜头要飞到的，就是名牌与卡片认的那一栋，两处各写一个数就总有一天会对不上。
// 判据（`tests/tour.test.js`）钉两件事：每个站点的 `osmId` 必须在仓库已发布数据里点得到名字，
// 且 `center` 与那一处自带的中心相差不超过 100 m（站与站之间最近的两个要素相距 150 m，所以 100 m 抓得住串站）。
export const TOUR_STOPS = [
  { name: '广州塔', bank: '南岸', center: [DEFAULT_CENTER.lng, DEFAULT_CENTER.lat], zoom: 15.4, pitch: 58, bearing: -25, osmId: TOWER_OSM_ID,
    description: '从珠江南岸出发，隔江望向珠江新城。' },
  { name: '海心桥', bank: '江上', center: [113.314334, 23.1110888], zoom: 16, pitch: 45, bearing: 35, osmId: 1313608038,
    description: '步行拱桥横跨珠江；桥面按 OSM 的闭合轮廓立起，拱肋与吊杆沿轮廓内量出的跨径线起拱，净空与厚度是示意。' },
  { name: '花城广场', bank: '北岸', center: [113.319181, 23.122579], zoom: 15.7, pitch: 40, bearing: 180, osmId: 243319596,
    description: '沿花城广场向南望，绿地串起珠江新城的中轴线。' },
  { name: '广州图书馆', bank: '北岸', center: [113.3206608, 23.1189093], zoom: 17, pitch: 48, bearing: 35, osmId: 240896441,
    description: '在花城广场东侧的广州图书馆；从这里向北，是中轴两侧的两座塔。' },
  { name: '广东省博物馆', bank: '北岸', center: [113.321145, 23.117494], zoom: 16.8, pitch: 50, bearing: 20, osmId: 240896442,
    description: '珠江东路 2 号，与图书馆相邻；快照标 5 层，按每层 3.2 m 换算作 16 m 示意厚度。' },
  { name: '广州西塔', bank: '北岸', center: [113.317861, 23.120317], zoom: 15.6, pitch: 60, bearing: 270, osmId: 184738716,
    description: '花城广场西侧，与东塔隔广场相望；OSM 标注 440.2 m 与 103 层，自宽脚向圆头收分的曲线是示意。' },
  { name: '广州东塔', bank: '北岸', center: [113.320579, 23.12026], zoom: 15.6, pitch: 60, bearing: 90, osmId: 511404889,
    description: '花城广场东侧；OSM 标注 530 m 与 111 层。它只标了 building:part，所以按"未分类"上色。' },
  { name: '猎德大桥', bank: '江上', center: [113.328447, 23.113333], zoom: 15.2, pitch: 45, bearing: 80, osmId: 233809684,
    description: '塔脚东北 1.07 km；画面里是 OSM 那两条各 17 m 宽的车行面，净空与厚度是示意，斜拉塔与索 OSM 没有。' },
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
