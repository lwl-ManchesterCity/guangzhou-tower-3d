// V4-8：街区之间的转场。文档要的是"同实例三段式飞行"，这一版做不到同实例，原因写在下面第一条判据里：
// 两份街区各自是一份本地快照，塔边 3 km 圈与景泰 2 km 圈之间还空着一段谁都没画的距离（`sceneGap` 实测
// 3,700 m 上下），而 style、导览、透视镜、POI 全在模块加载时按 `SCENE` 定死 —— 要在一个实例里飞过去，等于
// 把整个 app 改成可热换场景。落地的是同一视觉意图的两段接力：离场那侧把街区升成一枚圆盘，换页，落页从
// **同样大小**的那枚圆盘降回默认机位。切页那一帧两边都只是一枚小圆盘浮在空底上，所以看不出"跳"。
import { distanceMeters } from './geo.js';

export const HANDOFF_KEY = 'neighborhood.scene-flight';
// 交接只管一次浏览：超过这个数还没落到对面那页（网络卡住、用户自己改了地址），就按正常开页走，不要半路插一段降落。
export const HANDOFF_TTL_MS = 20000;
// 圆盘的直径。开屏机位 15.5 级下塔边 3 km 圈占满 1,440 px 宽的画面，缩到 150 px 时街区已经不是内容而是"一块地方"，
// 再小就连那点轮廓都不剩了 —— 这个数是量出来的，判据在 tests/scene-flight.test.js 里读 `discPixelsOf` 本身。
export const DISC_PIXELS = 150;
export const FLY_OUT_MS = 900, FLY_IN_MS = 1400;

// Web Mercator 在赤道上每像素 156543.03 m（zoom 0），往高纬按 cos 收缩。
const EQUATOR_METRES_PER_PIXEL = 156543.03;
const cosine = (lat) => Math.cos((lat * Math.PI) / 180);

/** 一份街区在某一档缩放下占多少屏幕像素（直径）。 */
export const discPixelsOf = ({ radius, center }, zoom) => 2 * radius / (EQUATOR_METRES_PER_PIXEL * cosine(center.lat) / 2 ** zoom);

/** 把街区缩到 `disc` 像素该飞到哪一级：上面那个式子反解出来的 z。 */
export function relayZoom({ radius, center }, disc = DISC_PIXELS) {
  return Math.log2(disc * EQUATOR_METRES_PER_PIXEL * cosine(center.lat) / (2 * radius));
}

/** 中继机位：站在街区自己头上、正着看，不带方位也不带俯仰 —— 切页时这两维最容易露馅。 */
export const relayView = (scene, disc = DISC_PIXELS) => ({
  center: scene.center, zoom: relayZoom(scene, disc), bearing: 0, pitch: 0,
});

/** 两份快照的边与边之间空多少米：这一段谁都没画，它是"必须换页"的那笔账。 */
export const sceneGap = (a, b) => Math.max(0, distanceMeters(a.center, b.center) - a.radius - b.radius);

export function writeHandoff(storage, record) {
  if (!storage) return false;
  try {
    storage.setItem(HANDOFF_KEY, JSON.stringify(record));
    return true;
  } catch {
    // 无痕模式下 sessionStorage 会抛，接力退化成直接换页就是对的，不该把场景切换按钮弄坏。
    return false;
  }
}

/**
 * 读一次就销：落在对面那页时它只该降落一次，刷新、回退都不该再插一段飞机。
 * 对不上 `sceneId` 或过期的记录同样被吃掉——那是上一次没落成的残骸，留着只会让别的页面莫名其妙地飞起来。
 */
export function readHandoff(storage, sceneId, now = Date.now()) {
  if (!storage) return null;
  let raw = null;
  try {
    raw = storage.getItem(HANDOFF_KEY);
    if (raw) storage.removeItem(HANDOFF_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!record || record.to !== sceneId || typeof record.at !== 'number') return null;
  if (now - record.at > HANDOFF_TTL_MS || now - record.at < 0) return null;
  return record;
}
