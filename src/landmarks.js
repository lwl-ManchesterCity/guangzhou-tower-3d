import { DEFAULT_CENTER } from './config.js';
import { cameraFromPlacement } from './geo.js';

// Seven landmarks. Every one of them is an element this repository already holds - the tower and the three named
// buildings come from `public/data/canton-*.geojson` with their OSM ids and heights, the bridge and the square are the
// ids the shipped tour already flies to, and 猎德大桥 is the deck this scene already draws from
// `public/data/canton-bridges.geojson` (V5 遗留①：它在出厂画框之外，但转过去就该有名字). Nothing here is a coordinate
// typed in by eye: each `center` is the middle of that element's own shipped geometry.
//
// `height` is what the snapshot says, and `heightSource` says how it knows: `height` is an OSM metre value, `levels`
// is a floor count converted at 3.2 m, and `model` is the tower's own geometry.
export const LANDMARKS = [
  { osmId: 584204634, name: '广州塔', latin: 'Canton Tower', center: [DEFAULT_CENTER.lng, DEFAULT_CENTER.lat],
    height: 600, heightSource: 'model', around: 155,
    intro: '阅江西路，OSM 记录 2010-09-28 建成。塔身按 600 m 总高建模，网格与观光平台是示意。' },
  { osmId: 511404889, name: '周大福金融中心（广州东塔）', latin: 'CFT / East Tower', center: [113.320579, 23.12026],
    height: 530, heightSource: 'height', around: 180,
    intro: 'OSM 标注高度 530 m（`height`）与 111 层，花城广场东侧。体块轮廓与高度都来自实测快照，退台的位置是示意。OSM 这条 way 只标了 `building:part=yes`、没有 `building` 值，所以它按"未分类"上色，与隔壁标了 `building=commercial` 的西塔不是一档颜色。' },
  { osmId: 184738716, name: '广州国际金融中心(广州西塔)', latin: 'IFC / West Tower', center: [113.317861, 23.120317],
    height: 440.2, heightSource: 'height', around: 180,
    intro: 'OSM 标注高度 440.2 m（`height`）与 103 层，花城广场西侧，与东塔隔广场相望。自宽脚向圆头收分的曲线是示意。' },
  { osmId: 240896442, name: '广东省博物馆', latin: 'Guangdong Museum', center: [113.321145, 23.117494],
    height: 16, heightSource: 'levels', levels: 5, around: 180,
    intro: 'OSM 标注 5 层，按每层 3.2 m 换算作 16 m 示意厚度，不是实测标高。' },
  { osmId: 1313608038, name: '海心桥', latin: 'Haixin Bridge', center: [113.314334, 23.1110888],
    height: null, heightSource: null, around: 200,
    intro: 'OSM 给的是桥面闭合轮廓（way/1313608038，约 6,800 m²）。桥面按示意净空 12 m、示意厚度 3.5 m 立起，没有实测标高；`bridge:structure=arch` 的拱肋按轮廓内量出的最长内连线（跨径 174 m）起拱，拱高 36 m 与横向偏心 9 m 是示意。' },
  { osmId: 243319596, name: '花城广场', latin: 'Flower City Square', center: [113.319181, 23.122579],
    height: null, heightSource: null, around: 180,
    intro: '中轴线上的广场。画面里的草坪、水面与石材中轴都取自 OSM 实测面（广场面之内 20 块草地、1 块水面、4 块 `pedestrian` 硬质面），只有步行带是沿实测 `pedestrian`/`steps` 线扫出来的——那条道多宽 OSM 没写，6 m 与 4 m 是示意。树不再站在石材上。' },  { osmId: 233809684, name: '猎德大桥', latin: 'Liede Bridge', center: [113.328447, 23.113333],
    height: null, heightSource: null, around: 200,
    intro: '塔脚东北 1.07 km，出厂机位在画框外约 100 px，转过来才有名字。画面里是 OSM 那两条车行面（way/233809684 与 way/440897019，各 17 m 宽）扫出的桥面，按示意净空 12 m、示意厚度 3.5 m 立起；斜拉塔的塔形与索 OSM 没有，所以画面里没有它们，名牌上那颗菱形塔是按公开图片读的示意。' },
];

// The shot has to clear the building it is flying to: the eye sits at least this far above its roof, and never lower
// than `MINIMUM_ALTITUDE`, which is what keeps a five-storey museum from being filmed from just above the pavement.
export const CLEARANCE_METRES = 50;
export const MINIMUM_ALTITUDE = 150;
export const APPROACH_PITCH = 60;

export const approachAltitude = ({ height }) => Math.max(MINIMUM_ALTITUDE, (height ?? 0) + CLEARANCE_METRES);

/**
 * The camera that looks at a landmark from `APPROACH_PITCH` without being inside it.
 *
 * The brief asks for 250 m out at pitch 60, and for a low building that is exactly what this gives. It cannot hold for
 * the towers: 530 m of East Tower seen from 250 m means the eye has to be above the roof, which at pitch 60 puts it
 * 1 km out. The clearance is the part of the brief that keeps the camera out of the building, so that is the part the
 * distance is derived from.
 *
 * @param {object} landmark one of `LANDMARKS`
 * @param {number} height the canvas the perspective is scaled by
 */
export const approachCamera = (landmark, height) => {
  const altitude = approachAltitude(landmark);
  const target = { lat: landmark.center[1], lng: landmark.center[0] };
  const camera = cameraFromPlacement({ target, altitude, around: landmark.around, height,
    metres: altitude * Math.tan(APPROACH_PITCH * Math.PI / 180) });
  return { ...camera, curve: 1.3, duration: 1800 };
};

/**
 * What the card is allowed to say about a landmark's size, in the words the data actually supports.
 *
 * `height` from OSM is a measured metre value; `levels` is a floor count converted at 3.2 m, which is a 示意 thickness
 * rather than a标高; and the tower's 600 m is the model's own geometry, not a snapshot field. Saying which of the
 * three it is costs one suffix and saves the reader from trusting a number that is not a measurement.
 *
 * @param {object} landmark one of `LANDMARKS`
 * @param {object[]} forms the forms this scene stands rather than boxes: `{ osmId, kind }` for each
 */
export function landmarkFacts(landmark, forms = []) {
  const facts = [];
  if (landmark.height && landmark.heightSource === 'height') facts.push(`高度 ${landmark.height} m（OSM 标注 height）`);
  else if (landmark.height && landmark.heightSource === 'levels') facts.push(`高度 ${landmark.height} m（按 ${landmark.levels ?? '?'} 层换算的示意厚度）`);
  else if (landmark.height) facts.push(`高度 ${landmark.height} m（本场景模型的几何）`);
  const form = forms.find((entry) => entry.osmId === landmark.osmId);
  if (form?.kind === 'deck') facts.push(`桥面轮廓来自 OSM 闭合 way，净空与厚度为示意；拱肋按轮廓内量出的 ${form.structure?.span ?? '?'} m 跨径起拱，拱高与偏心为示意`);
  else if (form) {
    // 层高不是画出来的：快照给了层数，一层多高就是高度除以层数，一格多宽又是照着街区那一格定的。
    facts.push(form.levels
      ? `立面按快照 ${form.levels} 层切成每层 ${form.storey.toFixed(2)} m，`
        + (form.facade?.lattice
          // 那一格不是随手换的尺度：事务所写了「每 12 层一颗 54 m 的菱形」，这里取的是整层数那一档。
          ? `外立面每 ${form.cell.toFixed(1)} m（${form.diagrid.storeys} 层）一颗菱形斜撑、绕环 ${form.facade.diamonds} 颗，`
            + `管径按施工方资料由底部 ${form.facade.lattice.from} m 渐变到顶部 ${form.facade.lattice.to} m`
          // 柱子站在哪、有几道桁架是资料给的；只有桁架的标高是等分的。
          : form.facade
            ? `角部 ${form.facade.piers.length} 根巨柱站在这条轮廓自己标出的硬角上，${form.facade.bands} 道环形桁架按施工方资料画、标高为示意`
            : `一格 ${form.cell.toFixed(1)} m 与旁边楼同一尺度`)
      : '立面没有层数可依据，每层按 3.7 m 的示意层高画');
    facts.push(form.podium
      ? `裙房 ${form.podium.metres} m、平面外扩 ${form.podium.spread} 倍为示意；收分曲线按公开资料示意，平面与高度是 OSM 实测`
      : '轮廓按公开资料示意收分，平面与高度仍是 OSM 实测');
  }
  facts.push(`OSM 要素 ${landmark.osmId}`);
  return facts;
}

// Air, in canvas pixels, that two nameplates have to keep between them before both are allowed to speak.
export const DECLUTTER_PAD = 4;

const overlaps = (a, b, pad) => a.x < b.x + b.w + pad && b.x < a.x + a.w + pad
  && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;

/**
 * Which of the plates near each other get to show their name, ranked by the height their own snapshot carries.
 *
 * Seven silhouettes are readable; seven overlapping pills of text read as one garbled line, and the crowding starts as
 * soon as the camera comes within a few hundred metres of the axis. The order is not a design taste: a plate standing
 * for a 600 m tower is the one a viewer is most likely aiming at, and the three elements with no height in OSM - the
 * two bridges and the square - give their text up first. A plate that loses its text keeps the silhouette it was drawn with, so the
 * landmark stays clickable and the card still names it. A plate whose silhouette still lies on one already placed is
 * parked until the camera pulls back.
 *
 * Nothing is nudged sideways. A label that no longer sits on its own building would be a wrong label, not a tidy one.
 *
 * @param {object[]} entries `{ osmId, height, box, diamond }` - `box` is the plate with its name shown, `diamond` the
 *        same plate down to its silhouette, both `{x, y, w, h}` in canvas pixels with x/y at the top left
 * @param {object} options
 * @param {number} options.pad the air required between two placed boxes
 * @returns {{osmId:number, state:'full'|'diamond'|'hidden'}[]} one per entry, in the order they were passed in
 */
export function declutter(entries, { pad = DECLUTTER_PAD } = {}) {
  const ranked = entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => (b.entry.height ?? -1) - (a.entry.height ?? -1) || a.index - b.index);
  const placed = [];
  const states = new Map();
  for (const { entry, index } of ranked) {
    let box = entry.box;
    let state = 'full';
    if (placed.some((other) => overlaps(box, other, pad))) {
      box = entry.diamond;
      state = 'diamond';
    }
    if (state === 'diamond' && placed.some((other) => overlaps(box, other, pad))) state = 'hidden';
    // A parked plate is not on the picture, so it reserves nothing for the ones behind it.
    if (state !== 'hidden') placed.push(box);
    states.set(index, state);
  }
  return entries.map((entry, index) => ({ osmId: entry.osmId, state: states.get(index) }));
}
