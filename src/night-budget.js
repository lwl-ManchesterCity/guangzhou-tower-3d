// V7 的十档夜景亮度预算：把文档那张表落成一份配置，两处消费。
//
// - `scripts/night-budget-meter.mjs` 按 `layers` 把三个机位的画面归并成逐档实测，用 `range` 判"漂没漂"，
//   用 `below` 判"谁压过了谁"，越界就打印违规并以非零码退出；
// - `tests/night-budget.test.js` 先问这张表自己成不成立（档位、区间、关系的目标都在，且关系不自相矛盾），
//   再把 `src/atmosphere.js` 里那些能闭式算出上屏值的夜景取值算一遍，落不进区间就是改配色的人越了档。
//
// 文档要的是"不要看着调"。这一份就是那把闸门：调亮度的人必须同时改这张表，改表会留下注释里的数。
//
// 第 1、2、3 档的 `range` 是 `null`：它们量的是竖条，而竖条里大半是天——三盏皇冠的条按中位读 37~43，按 p90 读
// 146~150，同一个数没法既当"最亮的一小撮"又当"这条的平均"。这三档因此只报不判，判它们的是浏览器那侧的皇冠与
// 皇冠断言，和文档自己给的眯眼列（"只剩 1~3 档可见"量的就是那一列）。三盏红色障碍灯 2026-10-04 按用户裁定整项删除，
// 所以这一档现在只有皇冠；V8 文档 Phase 3 的清单里还写着"障碍红灯"，那一行同样作废，迁移时不要搬回来。
//
// `range` 不是推出来的，是从 README V7 节记录的三机位实测中位倒推的，两侧各留三到五级——所以它宽到能容纳
// 机位差（同一档在三个机位能差十几级：北岸中轴位离楼近、高空位在灯层的 minzoom 之下），又窄到能抓住
// 一次真正的走偏（A3 抬亮窗、A4 压绿地那种量级）。
//
// `below` 只在**同一个机位的同一次读数**里比较，因为绝对值跨机位不可比，先后顺序可比。读法是"本档必须比列出的每一档暗"：
// 文档点名的两条死标准就是其中的两条——塔身主体不得超过旁边普通楼的亮窗（1.5 below 4b）、绿地与水面不得比楼墙亮
// （9、10 below 7）。
//
// 只有两类取值能不上屏就算出明度：`fill` 拿不到方向光，hex 就是上屏值；`extrusion` 的侧面被 MapLibre 压到
// `1 - light.intensity`（实测比值 1.55，见 `src/landmark-forms.js` 里那段注释）。其余的档——灯、车流、皇冠、
// 塔身网格、桥的护栏——是合成出来的，源码算不出它落在哪，所以它们只有 `layers`（像素那一侧的判据）没有 `sources`。
// 道路面也归在"算不出"里：它是一摞 line，顶上那层 hex 算出来 55.6，实测那一档的中位是 44.4，差额在底下那层
// casing 与远处段上的雾里——**线层的上屏值不是它自己的 hex**，所以这一条只能走像素。
// 桥身（`bridge`）同理不预测：它是 extrusion，可那一档的读数被护栏那条亮边主导（57.1），拿桥身的 hex 去对区间
// 只会指错地方。
import { ATMOSPHERES } from './atmosphere.js';

// Rec.709 on the sRGB values, which is what the meter measures and what the eye ranks by at these levels.
export const hexLuma = (hex) => {
  const at = (offset) => Number.parseInt(hex.slice(offset, offset + 2), 16);
  return Math.round((0.2126 * at(1) + 0.7152 * at(3) + 0.0722 * at(5)) * 10) / 10;
};

// The floor MapLibre presses an extruded side wall down to: the diffuse term is remapped onto
// `[1 - intensity, 1]`, so a wall's own hex reaches the screen multiplied by this.
export const extrusionFloor = () => 1 - ATMOSPHERES.night.light.intensity;

export const predictedLuma = (kind, hex) => {
  const flat = hexLuma(hex);
  return kind === 'extrusion' ? Math.round(flat * extrusionFloor() * 10) / 10 : flat;
};

// 1.5 与 4b 是文档表里没有的两行：前者是 A1 把两座壳体的塔身从第 1 档挪去第 7 档之后留下的那一档，
// 后者是"亮窗"里真的落在窗上的那部分像素（按图层归并的那一行读的是透过格间隙看到的墙）。
export const NIGHT_BANDS = [
  {
    band: 1,
    label: '三塔塔冠',
    layers: [],
    // The crowns are measured off their own bars in the meter, not off a layer.
    // Not gated from a bar: the crown bars are mostly sky, so their median reads 37-43 while their own p90 reads
    // 146-150. The crowns are graded where they are actually measurable - the browser's crown and beacon claims,
    // and the squint column, which is the document's own test for "只剩 1~3 档可见".
    range: null,
    below: [],
  },
  {
    band: 1.5,
    label: '东西塔塔身主体',
    layers: [],
    // 33.4 / 32.8 at the two cameras that draw them. The band is the wall band on purpose - the shafts are buildings.
    // 33.4 at the hero camera, 32.9 on the north axis, 41 from above - the high bar is short and starts under the
    // crown lamp, so the spread across the three cameras is what the interval has to hold.
    range: [26, 43],
    // Against 4b, not against 4: band 4's own row is mostly wall seen through the grid (A3's 灯芯 lesson), and at
    // the north camera that row reads 30.4 - dimmer than a shaft that is doing nothing wrong.
    below: ['4b'],
  },
  {
    band: 2,
    label: '广州塔身网格',
    layers: [],
    range: null,
    below: [],
  },
  {
    band: 3,
    label: '地标标签',
    layers: [],
    // The plates are DOM, and the meter reads their boxes; the budget only says they stay under the crowns.
    range: null,
    below: [],
  },
  {
    band: 4,
    label: '亮窗（含格间隙）',
    layers: ['building-lights', 'building-lights-alt', 'building-lights-2', 'building-lights-2-alt', 'building-glow',
      'building-glow-breath-0', 'building-glow-breath-1'],
    // 41 / 39.6 / 30.4: this row is mostly wall, and it is kept because that is the row the basemap's own
    // layer-attributed sampling can produce. The claim about windows is graded on 4b.
    range: [28, 46],
    below: ['4b'],
  },
  {
    band: '4b',
    label: '亮窗（灯芯）',
    // The same four layers as band 4, graded on the pixels that are really a window: `sub` says so, and it is what
    // keeps `layerBands()` from reporting the four layers as claimed twice.
    sub: 4,
    layers: ['building-lights', 'building-lights-alt', 'building-lights-2', 'building-lights-2-alt'],
    // 68 at the hero camera, 51.9 on the north axis - the same windows, a different share of them in frame.
    range: [46, 84],
    below: [],
  },
  {
    band: 5,
    label: '车流光带/光点',
    layers: ['traffic-flow', 'traffic-tail', 'traffic-band'],
    range: [50, 64],
    // No relation to the windows, and that is a measurement rather than an omission. The traffic reads 56.6 /
    // 54.4 / 52.7 at the three cameras and the lamp cores read 68 / 51.9 / - , because the cores are the far bank
    // seen from the plaza while the traffic is the hundred metres in front of the lens. The brief's own squint
    // acceptance lists 车流 as one of the three things that must survive squinting, so ranking it under the
    // windows at every camera is not what the document asks for; its two hard standards are the shaft and the
    // ground bands, and both are declared where they belong.
    below: [],
  },
  {
    band: 6,
    label: '桥体',
    layers: ['bridge-decks', 'bridge-parapets'],
    // 57.1 / 56.4 / - : the deck body is in the wall band and only the parapet keeps the bright edge, so the row
    // reads between the two. It must stay under the lit windows, which is what V7 moved it for.
    range: [40, 70],
    below: ['4b'],
  },
  {
    band: 7,
    label: '楼体墙面',
    layers: ['neighborhood-buildings', 'neighborhood-buildings-overview', 'context-buildings'],
    // 31.5 / 32.8 measured; the floor is the darkest category's own prediction (`buildings.unknown` → 26.8), so a
    // palette that drops one more category below that is out of band rather than quietly invisible.
    range: [26, 38],
    below: [8, 4, '4b', 5, 6],
    sources: [
      { kind: 'extrusion', keys: ['buildings.commercial', 'buildings.residential', 'buildings.public', 'buildings.unknown', 'context'] },
    ],
  },
  {
    band: 8,
    label: '道路面',
    layers: ['road_motorway', 'road_trunk_primary', 'road_secondary_tertiary', 'road_minor', 'road_link', 'road_service_track',
      'road_motorway_link', 'tunnel_motorway', 'tunnel_trunk_primary', 'tunnel_secondary_tertiary', 'tunnel_minor', 'tunnel_link',
      'tunnel_service_track', 'path_pedestrian'],
    range: [38, 52],
    below: ['4b', 5, 6],
  },
  {
    band: 9,
    label: '绿地',
    layers: ['park', 'landcover_grass', 'landcover_wood', 'landcover_wetland', 'landuse_pitch', 'landuse_cemetery',
      'landuse_school', 'landuse_hospital', 'landuse_residential'],
    range: [18, 28],
    below: [7, 8, 4, '4b', 5, 6],
    sources: [{ kind: 'fill', keys: ['park', 'grass', 'wood'] }],
  },
  {
    band: 10,
    label: '水面',
    layers: ['water', 'river-surface'],
    range: [18, 32],
    below: [7, 8, 4, '4b', 5, 6],
    sources: [{ kind: 'fill', keys: ['water'] }],
  },
];

// How far a band may sit above something the table ranks over it before the meter calls it 越档. Two levels, because
// that is what the cameras are worth: the two inversions this gate found on a correct picture were 1.0 (water against
// a north-axis wall sample of 468 pixels) and 2.5 (traffic against lamp cores two kilometres away), while every
// violation V7 actually listed was +5 (the greens against the walls) or more - up to +70 for the shafts.
export const BELOW_TOLERANCE = 2;

export const bandOf = (id) => NIGHT_BANDS.find((entry) => entry.band === id);

// Which band a rendered layer belongs to, as the meter asks it: the first band that names the layer wins, so a layer
// listed twice would be silently mis-bucketed and the table says so instead.
export const layerBands = () => {
  const map = new Map();
  for (const entry of NIGHT_BANDS) {
    if (entry.sub) continue;
    for (const layer of entry.layers) {
      if (map.has(layer)) throw new Error(`${layer} is claimed by bands ${map.get(layer)} and ${entry.band}`);
      map.set(layer, entry.band);
    }
  }
  return map;
};
