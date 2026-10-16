// 近场三组（车、人、船）的装配器：挂进场景、每拍推进、夜景亮灯、总开关、给判据的那一份读数，五件事一个口令。
//
// 为什么现在收：这两条渲染路径此前各接了一遍同样的五件事。2026-10-09 加江上的船时最能看出来——`map.js`+`tower.js`
// 与 `boot.js`+`scene.js` 各挂一次组、各推进一次、各藏一次发数账，连 `nearTraffic()` 的读数都是两份逐字相同的代码。
// 收完之后调用方只剩一件各自的事：**这一场的近场是哪几份快照喂出来的**。两处确实不一样，所以留在参数上：
// 现版那侧桥体已被 `src/bridges.js` 挤成实体，车要站到桥面顶上（`decks`）；新引擎这一侧只把海心桥画成了体
// （壳体那一格，#190），所以它传的是 `engineDecks()` 那份只有一条的表——其余跨江桥在这一侧还是平色路带，
// 把整份桥面表搬过来只会让车站到自己没画出来的桥面上去。那颗光晕贴图要 DOM，也由调用方造好递进来。
import { TRAFFIC_LIFE_RADIUS, WALKER_MIN_ZOOM, createTrafficLife, deckHeights } from './traffic-life.js';
import { BOAT_LIFE_RADIUS, createWaterLife } from './waterlife.js';
import { createShoreBand } from './shadow-pads.js';
import { deriveJunctions } from './junctions.js';
import { LANDMARK_FORMS } from './landmark-forms.js';

/**
 * 引擎那一侧的桥面表：只有 `LANDMARK_FORMS` 里 `kind === 'deck'` 的那几座在这一侧真的被画成了体，
 * 顶高用它自己的 `base + thickness`（也就是 `DECK_TOP_METRES`），写成 `deckHeights` 认的那种件。
 * 剩下的桥等它们的桥体进引擎那天自己进这张表——这一侧多画一座桥，这里就自动多一条，不需要有人记得来改。
 *
 * @param {object[]} features 引擎喂给壳体的那批件（`haixin-bridge.geojson` 之类）
 */
export const engineDecks = (features = []) => deckHeights(features
  .filter((feature) => LANDMARK_FORMS[feature?.properties?.osmId]?.kind === 'deck')
  .map((feature) => {
    const form = LANDMARK_FORMS[feature.properties.osmId];
    return { ...feature, properties: { ...feature.properties, part: 'deck', height: form.base + form.thickness } };
  }));

/**
 * @param {{streets?: object[], river?: object[], shore?: object[], origin: {lng: number, lat: number},
 *   decks?: {byOsmId: Map, byName: Map, heightOf: Function}|null, sprite?: object|null,
 *   trafficRadius?: number, boatRadius?: number, junctions?: boolean}} options
 *   路网/江中心线/岸线面与米制原点；没有路网的那一侧就是没有近场。
 *   `junctions: false` 是留给判据的闸门——路口在这里派生，所以两条渲染路径不可能各算出一套路口。
 */
export function createNearField({ streets = [], river = [], shore = [], origin, decks = null, sprite = null,
  trafficRadius = TRAFFIC_LIFE_RADIUS, boatRadius = BOAT_LIFE_RADIUS, withJunctions = true } = {}) {
  // 路口从同一份路网派生（快照里没有信号灯点要素，见 `junctions.js` 开头），所以灯也自动两边同形。
  const junctions = streets.length && withJunctions
    ? deriveJunctions({ features: streets, origin, radius: trafficRadius }) : [];
  const traffic = streets.length
    ? createTrafficLife({ features: streets, origin, radius: trafficRadius, sprite, decks, junctions }) : null;
  const boats = river.length ? createWaterLife({ features: river, origin, radius: boatRadius, shore }) : null;
  // 近岸那一圈湿线：静态，但它站的是同一批水面多边形（`shore`），所以跟着近场一起挂、一起被透视镜收走。
  // 组名既不叫 `traffic-life` 也不叫 `water-life`——浏览器那条数发数的判据按名字藏组，多出来的这一组自己结自己的账。
  const wet = shore.length ? createShoreBand({ features: shore, origin }) : null;
  // 逐组交出去，谁没造出来就少一组：两边的场景都只做一句 `scene.add(...groups)`。
  const groups = [traffic?.group, boats?.group, wet?.group].filter(Boolean);

  return {
    groups,
    counts: { cars: traffic?.counts.cars ?? 0, walkers: traffic?.counts.walkers ?? 0, boats: boats?.counts.boats ?? 0 },
    /** 湿线那一层的账（几圈、几圈被水面宽度闸门拒掉），判据与 README 读这一格。 */
    shoreBand: wet?.report ?? null,
    /** 灯的底账：派生出几个路口、几个进口道真接上了灯、三层几何各多少台。 */
    signals: { junctions: junctions.length, ...(traffic?.signals ?? { approaches: 0, poles: 0, lines: 0 }) },
    /**
     * 走一格。两个参数都是**绝对**读数：秒是车流开起来一共走了多少秒（`motion.life / 1000`），不是这一拍的增量；
     * 层级是当前镜头。累积成增量会让船在江上乱跳，而"关掉动效回出厂那一帧"也回不去。
     */
    advance(seconds, zoom) {
      traffic?.advance(seconds, zoom);
      boats?.advance(seconds);
    },
    // 倍率与"车头朝哪一边亮"只有车吃：船是固定尺度、长轴钉在航道上，不看镜头。
    // 这两笔必须在**画的那一帧**交，理由与 `setLit` 相反侧：载入那帧、跑过又停下那帧、从没动过的页面必须是同一张画。
    setZoom(zoom) { traffic?.setZoom(zoom); wet?.setZoom(zoom); },
    faceCamera(bearing) { traffic?.faceCamera(bearing); },
    // 白天车还是车、船还是船，只有灯跟着夜景走，所以这一刀只切灯，不切整组。
    setLit(on) {
      traffic?.setLit(on);
      boats?.setLit(on);
    },
    // 高度透视镜把楼收走时近场整组一起离场——两边从此是同一个口令。湿线也跟着走：它是"这一公里的地面细节"，
    // 不是数据视图要看的东西，而且像素判据那几条"读之前先藏近场"的门槛不必再加一格。
    setVisible(on) {
      traffic?.setVisible(on);
      boats?.setVisible(on);
      wet?.setShown(on);
    },
    /**
     * teardown：一个口令把这三组自己造的几何与材质全还掉（#177）。
     * 现版那侧靠 `tower.js` 的 `onRemove` 遍历整个场景兜住，新引擎那侧此前只收了自己那几块——
     * 两边都改成喊这里，才不必再靠"谁记得遍历一遍"。组里的节点由各组自己清（判据钉的就是这一条）。
     */
    dispose() {
      traffic?.dispose();
      boats?.dispose();
      wet?.dispose();
    },
    /** 面板与判据看的那一份读数。两边同形，判据才能把同一秒的同一格在两引擎各读一次来对。 */
    readout() {
      if (!traffic) return null;
      const parts = traffic.parts();
      return { ...traffic.counts, radius: trafficRadius, reach: traffic.reach(),
        boats: boats?.counts.boats ?? 0, boatLights: boats?.parts().lights.visible ?? false,
        boatReach: boats?.reach() ?? 0, boatRadius, boatClock: boats?.parts().clock ?? 0,
        visible: traffic.group.visible, lamps: parts.lamps.visible, people: parts.people.visible,
        walkerMinZoom: WALKER_MIN_ZOOM, clock: parts.clock, boost: parts.zoom,
        // 灯的读数整份挂在这一格里：两条渲染路径同一秒应给同一个 tally，而 `parent` 证明它真的挂在车那一组里面。
        signal: parts.signals ? { approaches: parts.signals.approaches, states: parts.signals.states,
          parent: parts.signals.parent, clock: parts.signals.clock } : null };
    },
  };
}
