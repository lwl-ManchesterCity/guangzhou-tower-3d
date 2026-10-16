// V8 Phase 0：入口。`?engine=three` 时挂这一套，不带参数时现版路径逐字节不变 —— 本仓库不是 git 仓库，
// 文档给的"legacy 分支"落不了地，所以回退靠的是这个开关（文档给的第二个选项）。
import { DEFAULT_CENTER, SCENE } from '../config.js';
import { createEngineScene } from './scene.js';
import { attachRotate } from './gestures.js';
import { trafficSprite } from '../traffic-life.js';
import { createNearField, engineDecks } from '../near-field.js';
import { createBaseBands } from '../shadow-pads.js';

// Which local snapshot feeds each layer. `canton-river.geojson`（那条按实测河宽描出的示意江带）从这里
// 退场了：Phase 1 取回真岸线之后水面改画 `canton-water.geojson`，示意带宽就没有存在的必要了，但现版引擎的落水
// 色带还指着那个文件，所以文件本身留着。
export const ENGINE_LAYERS = {
  buildings: 'canton-buildings.geojson', streets: 'canton-streets.geojson',
  water: 'canton-water.geojson', greens: 'canton-greens.geojson', blocks: 'canton-blocks.geojson',
  river: 'canton-river.geojson', bridge: 'haixin-bridge.geojson',
};

export async function bootThreeEngine({ container, base = '/data/', onError, ...rest }) {
  const load = async (file) => {
    const response = await fetch(`${base}${file}`);
    if (!response.ok) throw new Error(`${file} 未能加载（HTTP ${response.status}）`);
    return (await response.json()).features ?? [];
  };
  const entries = await Promise.all(Object.entries(ENGINE_LAYERS)
    .map(async ([key, file]) => [key, await load(file)]));
  // 近场三组（项 5 与江上的船）。算法、路网、米制原点与现版是同一份，所以这里不写第二套"车怎么摆"，也不写
  // 第二套开关：装配交给 `src/near-field.js`，谁在动由引擎这一侧的 120 ms 一拍说了算。
  // 车的高度还有一项来自桥：`crossings` 里那些 `part === 'deck'` 的件就是现版那两层挤出体的顶。
  // 引擎这一侧只把海心桥画成了体（壳体那一格，#190），其余跨江桥面还是平色路带，所以这张表由 `engineDecks()`
  // 从"这一侧真画了哪几座桥面"里派生：它现在只有一条，顶高读的是壳体自己那两格 `base + thickness`。
  // 传整份快照表会让车站到一条没画出来的桥上——同名继承那条规则认的是桥名，不是这一侧画没画。
  const streets = (entries.find(([key]) => key === 'streets') ?? [])[1] ?? [];
  const river = (entries.find(([key]) => key === 'river') ?? [])[1] ?? [];
  const bridge = (entries.find(([key]) => key === 'bridge') ?? [])[1] ?? [];
  // 岸线用同一批 `water` 面，所以船的横向游移在窄的那条汊里会被夹回到水里。
  const shore = (entries.find(([key]) => key === 'water') ?? [])[1] ?? [];
  // 那颗光晕贴图由这里造、也由这里还：`traffic-life.js` 的 dispose 只管自己那批几何与材质，共用贴图归建它的那一方。
  const sprite = trafficSprite();
  const nearField = createNearField({ streets, river, shore, origin: SCENE.center ?? DEFAULT_CENTER, sprite, decks: engineDecks(bridge) });
  // 楼根那一圈接地带：与现版共用 `src/shadow-pads.js`，所以两边的画面在这一格上是同一片影、同一个门控。
  const bases = createBaseBands({ features: (entries.find(([key]) => key === 'buildings') ?? [])[1] ?? [], origin: SCENE.center ?? DEFAULT_CENTER });
  const engine = createEngineScene({ container, data: Object.fromEntries(entries), nearField, bases, ...rest });
  const gesture = attachRotate({ canvas: engine.canvas, rig: engine.rig });
  const dispose = engine.dispose;
  engine.dispose = () => {
    gesture.dispose();
    dispose();
    sprite?.dispose();
  };
  // The shipped buttons call these names, so the engine answers to them rather than making the UI learn a second
  // vocabulary mid-migration.
  engine.setAtmosphere = engine.setMode;
  // 时长与现版对齐：`recenter` 1,200 ms、`overview` 1,400 ms（`src/map.js` 里那两个数），减弱动效时一律 0。
  // 在此之前这两个按钮在引擎这一侧是瞬移的，所以"点一下跳到广州塔头顶"和现版的"飞过去"不是同一个动作。
  const still = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;
  engine.recenter = () => engine.flyTo({ center: SCENE.center, zoom: SCENE.camera.zoom, bearing: SCENE.camera.bearing, pitch: SCENE.camera.pitch }, still() ? 0 : 1200);
  engine.overview = () => engine.flyTo({ center: SCENE.center, zoom: 12.4, bearing: 0, pitch: 0 }, still() ? 0 : 1400);
  // 动效开关在引擎这一侧从此也有对应动作了（车流、行人、交叉淡）。减弱动效与现版同一个判断：不开。
  engine.setMotion(!still());
  onError?.(null);
  return engine;
}
