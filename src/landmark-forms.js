import * as THREE from 'three';
import { distanceMeters, plane } from './geo.js';
import { ATMOSPHERES, mixHex, mixPreset, recedeColor } from './atmosphere.js';
import { FACADE_CATEGORY_SHAPES, FACADE_METRES_PER_PIXEL, FACADE_SHAPES, FACADE_TILE_SIZE } from './facade.js';
import { abutmentGeometry, crossingChord, ribGeometry } from './bridge-form.js';
import { facadeAtlas } from './tower-facade.js';

// Three of the six landmarks are buildings whose footprint *and* height are both measured in OSM, and whose real shape
// is not a box: 西塔 closes in from a wide foot to a rounded crown, 东塔 steps back four times on the way up, 省博 is a
// box that hangs over a recessed podium. What stands below is the snapshot's own ring, at the snapshot's own height, on
// the snapshot's own ground position. The only thing read off public descriptions rather than out of the data is how
// wide the building is at a given height, which is why every card that describes one of them calls the form 示意.
//
// A level is `[fraction of height, width scale]`. Two levels at the same fraction make a vertical jump in the curve
// and therefore a horizontal ledge - that is what a setback is, and what the underside of an overhang is.
// The two numbers OSM does not carry for 海心桥. They are constants of the drawing, not measurements, and they are
// named here so the card and the test can both point at them.
export const DECK_CLEARANCE_METRES = 12;
export const DECK_THICKNESS_METRES = 3.5;

// A tower that starts at ground with its own shaft looks planted on the city rather than built out of it: what meets
// the street is a wide low base, and the snapshot's outline is the shaft, not that base. So the podium is drawn - both
// numbers are its own, named here so the card can point at them - but its shape comes from the same measured outline
// scaled about its own centre, which keeps it off the "someone placed a polygon" side of the line.
export const PODIUM_METRES = 24;
export const PODIUM_SPREAD = 1.25;

// Wilkinson Eyre 说西塔的结构是「tubular diagrid structure 'nodes-out' every 12 storeys to form 54 m high giant steel
// diamonds」。12 层 × 4.274 m（快照的 103 层除以 440.2 m）＝ 51.3 m，与那句 54 m 差 5%——两个数说的是同一栋楼，取
// 整层数那一档，因为层数是快照给的、54 m 是稿子里说的。
export const DIAGRID_STOREYS = 12;
// 一根斜撑管多粗。中建（施工方）写的是「直径由底部 1.8 米渐变为 0.7 米的大直径厚壁钢管柱」，所以这不是一根常量
// 而是一条沿高度的线性渐变；`DIAGRID_RIB_METRES` 留着当"没有那份资料时"的底。
export const DIAGRID_RIB_METRES = 1.6;
export const DIAGRID_RIB_BASE_METRES = 1.8;
export const DIAGRID_RIB_TOP_METRES = 0.7;
// 东塔：主骨架是「8 根巨型钢柱加 6 道巨型环形钢桁架」。柱子的**位置**实测轮廓自己给了（那 8 个硬角），
// 桁架的**数量**是资料给的、标高没有资料，所以等分放并写成示意。
export const BELT_TRUSSES = 6;
export const BELT_TRUSS_METRES = 7.6;
export const PIER_METRES = 2.4;
// 转角超过这个数就算一个"硬角"：西塔 6 个（中建的「由 6 条曲线组成的三角形」）、东塔 8 个（那 8 根巨柱）。
export const CORNER_DEGREES = 25;

export const LANDMARK_FORMS = {
  // 广州国际金融中心(广州西塔): 440.2 m, 103 层. Wilkinson Eyre 自己的说法是「三角形平面」＋「最宽处在高度的三分之一处，
  // 向上越收越窄」＋「塔楼在ground level与一个大型裙房相连」——所以塔脚不是最宽的那一圈，而第一版画的从地面一路收到
  // 0.45（66 m 收到 30 m）在画面上就是一支火箭。下面这条曲线照那三句话重排：脚落在 OSM 实测轮廓上（1.0），
  // 到 1/3 高处微微鼓出去（1.06，仍不超过实测轮廓 6%），之后单调收窄到 0.66。
  184738716: {
    kind: 'taper',
    levels: [[0, 1], [0.16, 1.03], [0.33, 1.06], [0.52, 1], [0.7, 0.92], [0.85, 0.82], [0.95, 0.72], [1, 0.66]],
    // 那圈菱形斜撑是这栋楼最好认的东西。这一栋的立面不再用重复小格，而是画一张自己米数的立面图（见 `tower-facade.js`）：
    // 每 12 层一颗菱形、钢管从底部 1.8 m 渐变到顶部 0.7 m，两个数都有出处。
    diagrid: { storeys: DIAGRID_STOREYS },
    facade: { lattice: { storeys: DIAGRID_STOREYS, from: DIAGRID_RIB_BASE_METRES, to: DIAGRID_RIB_TOP_METRES }, bays: 28 },
    // What it burns at night, and where the crown begins. The shell has no window grid - the 示意灯窗 pattern lives on
    // the box geometry these forms replace - so the wall colour of a night built out of lit windows left it a black
    // hole: measured at the 花城广场 camera, its crown rendered luma 24-36 while the neighbouring volumes sat at 60-140.
    // The lamp colour is its own, read off how the two towers are lit from the plaza, and the top of the curve carries
    // more of it than the shaft, which is what a floodlit tower looks like from below.
    podium: { metres: PODIUM_METRES, spread: PODIUM_SPREAD },
    night: { glow: '#ffd9a0', crownFrom: 0.81, fins: { metres: 34, duty: 0.4, floor: 0.6 }, spill: true, lamps: 0.14 },
  },
  // 周大福金融中心（广州东塔）: 530 m, 111 层. KPF 的说法是「与通常的锥形造型不同」——塔身是直段，
  // 形状集中在四个转接点（办公→住宅→酒店→塔冠）上，退台在四个角部；立面「陶土竖框从塔楼底部延伸，强调竖向」。
  // 第一版每 20% 高度退一台、从地面就开始，退到 0.38（65 m 收到 25 m），画面上是一节竹。现在下半段 291 m 是直筒，
  // 四个硬跳全在上半段，每次只收 5~9%，顶上 0.70 留成一个塔冠而不是尖。竖框按 `facade` 那一条把玻璃压窄。
  511404889: {
    kind: 'setbacks',
    levels: [[0, 1], [0.55, 1], [0.55, 0.95], [0.72, 0.95], [0.72, 0.88], [0.85, 0.88], [0.85, 0.79],
      [0.95, 0.79], [0.95, 0.7], [1, 0.7]],
    // 8 根巨柱站在那 8 个实测硬角上，6 道环形桁架等分在这根直筒上（标高是示意）。开间比西塔密一倍、玻璃只占每个
    // 开间的一半宽，因为 KPF 的说法是「陶土竖框从塔楼底部延伸，强调竖向」——这一栋读起来是竖的，不是西塔那种斜的。
    facade: { piers: 'corners', pierWidth: PIER_METRES, bands: BELT_TRUSSES, bandHeight: BELT_TRUSS_METRES,
      bays: 40, paneXShare: 0.5, paneYShare: 0.8 },
    podium: { metres: PODIUM_METRES, spread: PODIUM_SPREAD },
    night: { glow: '#cfe4ff', crownFrom: 0.74, fins: { metres: 26, duty: 0.46, floor: 0.5 }, spill: true, lamps: 0.14 },
  },
  // 广东省博物馆: 16 m (OSM 5 层换算). The box is the building and it overhangs its own base, so this is the one place
  // in the scene where the shell gets wider going up.
  240896442: {
    kind: 'cantilever',
    levels: [[0, 0.7], [0.38, 0.7], [0.38, 1], [1, 1]],
    // Sixteen metres of roof seen from a plaza above it: a crown share here reads as a slab of paper, so the museum
    // burns evenly with no crown at all - and "evenly" now means the wall band, because V7 put every shaft in the scene
    // on the same budget as the blocks standing next to it.
    // 严迅奇的说法是「抬升的博物馆盒子」，灵感取自宝盒与象牙球雕刻，立面是"嵌入体量的几何凹孔"加
    // 铝板／玻璃／花岗石。所以这一栋的图不画竖梃也不画斜撑，只画一片**被掏空的石屏**：洞的位置由
    // (开间, 层) 的哈希决定，密度是画的常数。
    facade: { bays: 14, carve: { share: 0.26 }, paneXShare: 0.62, paneYShare: 0.66 },
    night: { glow: '#f0e0c8' },
  },
  // 海心桥: OSM gives the deck as a closed way - a curved strip about 334 m between its abutments, 600 m along its own
  // edge, and 6,800 m² of plan. That outline is what stands here. What OSM does not give is how far the deck stands
  // off the water or how thick it is, so those two numbers are drawn rather than measured - and the arch the
  // `bridge:structure=arch` tag promises is not built yet, because its rib needs the deck's centreline, and a strip
  // whose two edges carry different vertex counts does not give one up by pairing.
  1313608038: {
    kind: 'deck',
    levels: [[0, 1], [1, 1]],
    base: DECK_CLEARANCE_METRES,
    thickness: DECK_THICKNESS_METRES,
    // A deck has no crown to crown, so `crownFrom` stays away, and its shaft wears the same band as every other shaft.
    // What makes the crossing read at night is the deck's edge colour in the map theme, not a lamp baked into the mesh:
    // measured, the strip already reached luma 88 against 43 for the windows it crosses, so this is where the shell
    // stops adding to it and band 6's fix moves to the colour that is actually painting it.
    night: { glow: '#e8f0ff' },
  },
};

export const FORM_OSM_IDS = Object.keys(LANDMARK_FORMS).map(Number);

// The two shares of a night lamp, for the forms that do not name their own. V7 put the whole night frame on a ten-band
// budget, and the shaft of a landmark is band 7 - the same band as the walls standing next to it - while only the top
// of the curve gets band 1. Measured before that rule existed, the east tower's shaft sat at luma 113 against 31 for
// its neighbours, i.e. two towers were the brightest buildings on the axis for no reason but their own emissive.
// The crown share also leaves headroom on purpose: the bloom pass in phase B brightens whatever clears its threshold,
// so a crown tuned to look right *with* bloom has to look slightly under-exposed without it.
export const FORM_NIGHT_BODY = 0.02;
// 塔身上有灯图时走这一档：暗格是 0，所以平均亮度还是由"亮了多少格"决定，这一档只保证
// 亮着的那几十格真的亮到能读出来——0.02 那一档是给整面墙当背景用的，压在窗上就是看不见。
export const FORM_NIGHT_LAMP = 0.55;
export const FORM_NIGHT_CROWN = 0.7;

// Two of the three towers ask for a `night.spill`: a band of their own lamp colour on the water in front of them, which
// is the second half of V7's band-10 item (the river was dark except where 广州塔's band already lay). Where it lies is
// measured, not placed - `channelCrossing` in `tower.js` takes the OSM centre line of 珠江 (the new
// `public/data/canton-river.geojson`, three ways) and finds the foot of the perpendicular from the scene's centre, which
// is 广州塔's own foot: 320 m due north, at 113.319130,23.111893, where the line runs due east. Each shell gets that same
// point slid along the channel to its own easting, so the three bands lie on one measured stretch of river, 155 m apart
// in the frame at the hero camera. Measured against the obvious alternative - each shell's *own* nearest point on the
// line, 560 m and 568 m south at 23.1152 - that lands in the north channel, where the basemap draws water for only 11 of
// 24 samples along the axis: a hundred-odd metres of creek with promenade either side. The main channel is what the two
// towers face at night. The reach itself (200 m) is the longest that stayed on drawn water for all three bands at all
// three cameras; at 260 m two of them put 2-3 samples on the bank. 省博 is 16 m of roof behind 花城广场 and asks for
// nothing, same rule as its crown.

// The crowns breathe: a lit tower that holds one brightness is a decal. The two periods share no factor with each
// other, and neither is the tower's own 9 s, so the three towers on the axis are never on the same beat.
export const FORM_BREATH_MS = [7000, 8000];

/** One crown's share of its lamp at one point of its own breath: 0.8 at the bottom, 1 at the top. */
export function crownBreath(cycle) {
  if (!(cycle >= 0 && cycle <= 1)) throw new Error(`crown breath needs a cycle between 0 and 1: ${cycle}`);
  return 0.8 + 0.2 * (0.5 + 0.5 * Math.cos(cycle * Math.PI * 2));
}

// GeoJSON says an exterior ring runs counter-clockwise, and the winding the loft's faces need follows from that; the
// snapshot is not trusted to keep the promise, so the ring is turned to match before anything is built.
// How finely a shell is drawn, in metres. A block's extrusion is four flat walls, so its window grid can only be as
// fine as what one 32 px tile spans on a wall - 7.3 m, the floor `facade.js` measures - while a landmark shell is a
// curved loft with its own UVs and can carry a real storey pitch: the snapshot's own level count over its own height.
// `SHELL_STOREY_METRES` is only what a form falls back to when OSM names no levels at all. The ring and taper floors
// below are what the tables alone would give: 西塔's outline is 18 corners over a 201 m perimeter and its taper table
// has nine rows, which is why the tower read as a stack of drums before the ring was subdivided.
export const SHELL_STOREY_METRES = 3.7;
export const SHELL_FACET_METRES = 3;
export const SHELL_BAND_METRES = 6;

// The one pattern cell the scene is drawn at: `fill-extrusion-pattern` spans 32 image pixels over 29.3 m of wall, so
// that is the pitch every block reads at and the finest pitch that does not shimmer. A landmark shell has its own
// metres and can go finer, and it did - at a storey of its own, 3.7 m - which is how two towers ended up wearing a
// fabric next to a city wearing a grid. The cell is now snapped to that shared pitch, and the snapshot decides how
// many storeys fit inside it.
export const FACADE_CELL_METRES = FACADE_TILE_SIZE * FACADE_METRES_PER_PIXEL;

/** How tall one storey of this building is: what the snapshot's own level count says, or the fallback it cannot say. */
export function shellStoreyMetres(feature, height) {
  const levels = Number(feature?.properties?.levels);
  return levels > 0 && height > 0 ? height / levels : SHELL_STOREY_METRES;
}

/**
 * The grid scale one shell repeats: the scene's own cell, divided into the storeys the snapshot says it has.
 *
 * A block's band is a floor of the tile (`facade.js` measures it at 7.3 m), so its rhythm is carried by how many bands
 * and bays fit in one tile. A shell has metric UVs and a measured storey, so the band is not free - one band is one
 * floor - and what carries the rhythm instead is the bay count and how much of each band the glass fills. The cell
 * itself is pinned to the neighbourhood's, because a tower whose lines sit at half the pitch of the street below it is
 * a tower wearing fabric while the city wears a grid.
 */
/**
 * The grid scale one shell repeats: the scene's own cell, divided into the storeys the snapshot says it has.
 *
 * A block's band is a floor of the tile (`facade.js` measures it at 7.3 m), so its rhythm is carried by how many bands
 * and bays fit in one tile. A shell has metric UVs and a measured storey, so the band is not free - one band is one
 * floor - and what carries the rhythm instead is the bay count and how much of each band the glass fills. The cell
 * itself is pinned to the neighbourhood's, because a tower whose lines sit at half the pitch of the street below it is
 * a tower wearing fabric while the city wears a grid.
 *
 * A form that names a `diagrid` is the one exception, and it has a source: the tile then holds exactly one diamond,
 * the same number of metres across as up, so the ribs continue across the seam and up every storey line.
 */
export function shellGridScale(storey, shape, diagrid = null) {
  const bay = FACADE_CELL_METRES / Math.max(1, shape.columns);
  const rows = Math.max(1, Math.round(FACADE_CELL_METRES / storey));
  if (!diagrid) {
    return { storey, rows, columns: shape.columns, band: FACADE_CELL_METRES / rows, cell: FACADE_CELL_METRES,
      size: rows * shape.columns * 2, rib: null };
  }
  const diamond = Math.max(2, diagrid.storeys);
  const cell = storey * diamond;
  return { storey, rows: diamond, columns: Math.max(2, Math.round(cell / bay)), band: storey, cell,
    size: diamond * Math.max(2, Math.round(cell / bay)) * 2,
    rib: { metres: diagrid.ribMetres ?? DIAGRID_RIB_METRES, period: cell } };
}

/**
 * A ring's edges split until no facet is longer than `target`, with every original corner kept.
 *
 * Straight edges are subdivided, never curved: the outline stays the one OSM measured, and only the shading gets
 * enough facets to show it as a curve instead of a polygon.
 */
export function refineRing(ring, target = SHELL_FACET_METRES) {
  const points = openRing(ring);
  const out = [];
  for (let index = 0; index < points.length; index += 1) {
    const from = points[index];
    const to = points[(index + 1) % points.length];
    out.push(from);
    const metres = distanceMeters({ lng: from[0], lat: from[1] }, { lng: to[0], lat: to[1] });
    const parts = Math.max(1, Math.round(metres / target));
    for (let step = 1; step < parts; step += 1) {
      const at = step / parts;
      out.push([from[0] + (to[0] - from[0]) * at, from[1] + (to[1] - from[1]) * at]);
    }
  }
  return out;
}

/** 一条环自己的周长，米。 */
export function ringPerimeter(ring, origin) {
  const points = openRing(ring).map(([lng, lat]) => plane(origin, { lng, lat }));
  let around = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    around += Math.hypot(b.dx - a.dx, b.dy - a.dy);
  }
  return around;
}

/**
 * 这条轮廓自己标出来的硬角在哪：绕环比例，转角大于 `degrees` 的那些顶点。
 *
 * 西塔 6 个、东塔 8 个——正好对上施工方那两句话（「水平面上是一个由 6 条曲线组成的三角形」与「主骨架由 8 根
 * 巨型钢柱加 6 道巨型环形钢桁架组成」）。所以柱子不是按好看摆的，是按这条 OSM 环的角摆的。
 */
export function cornerStations(ring, origin, degrees = CORNER_DEGREES) {
  const points = openRing(ring).map(([lng, lat]) => plane(origin, { lng, lat }));
  const count = points.length;
  const run = [0];
  for (let index = 1; index < count; index += 1) {
    run[index] = run[index - 1] + Math.hypot(points[index].dx - points[index - 1].dx, points[index].dy - points[index - 1].dy);
  }
  const around = ringPerimeter(ring, origin);
  const angle = (a, b, c) => Math.abs(Math.atan2((b.dx - a.dx) * (c.dy - b.dy) - (b.dy - a.dy) * (c.dx - b.dx),
    (b.dx - a.dx) * (c.dx - b.dx) + (b.dy - a.dy) * (c.dy - b.dy)) * 180 / Math.PI);
  const out = [];
  for (let index = 0; index < count; index += 1) {
    if (angle(points[(index - 1 + count) % count], points[index], points[(index + 1) % count]) > degrees) out.push(run[index] / around);
  }
  return out;
}

/**
 * The same taper curve with a band every `band` metres, and nothing else changed.
 *
 * Between two levels the curve is linear, so the inserted points lie exactly on the segment it already drew - the
 * silhouette is bit for bit the tower that was specified, and only the shading gains rows. Two levels at the same
 * fraction are a vertical jump (a setback's ledge, an overhang's soffit), and those pairs stay adjacent: `steps` is 0
 * whenever the height does not move, so no jump is ever smoothed over.
 */
export function refineLevels(levels, height, band = SHELL_BAND_METRES) {
  const out = [levels[0]];
  for (let index = 1; index < levels.length; index += 1) {
    const [from, fromScale] = levels[index - 1];
    const [to, toScale] = levels[index];
    const steps = to > from ? Math.max(0, Math.ceil((height * (to - from)) / band) - 1) : 0;
    for (let step = 1; step <= steps; step += 1) {
      const at = step / (steps + 1);
      out.push([from + (to - from) * at, fromScale + (toScale - fromScale) * at]);
    }
    out.push(levels[index]);
  }
  return out;
}

/**
 * The window grid a shell's own metres ask for, as a multiplier on the wall colour.
 *
 * `map` rather than a colour of its own: the wall tone stays whatever `recede()` paints it, so the theme, the distance
 * fade and the category colour all keep working underneath, and the grid only says where the glass is. How many
 * metres one repeat of this tile spans is the caller's `shellGridScale`, which lands it on the scene's own cell; the
 * rhythm itself comes from the same `FACADE_SHAPES` table the blocks read, so an office tower and a housing tower are
 * not dressed alike.
 * A `rib` turns the same tile into one giant diamond: two families of 45° lines whose period is the tile itself, so
 * they continue across the seam in both directions and the lattice never has to be told where the ring starts.
 */
export function shellGridTexture({ rows = 4, columns = 4, paneYShare = 0.6, paneXShare = 0.6, size = 64, glass = 0.7, rib = null } = {}) {
  const data = new Uint8Array(size * size * 4);
  const cell = size / columns;
  const band = size / rows;
  // 一根 1.6 m 的管子，量到斜线上是它在横纵方向各占的宽度：斜线走 45°，所以轴向宽度是垂直厚度的 √2 倍。
  const half = rib ? (rib.metres / 2) * Math.SQRT2 * size / rib.period : 0;
  const toLine = (offset) => {
    const wrapped = ((offset % size) + size) % size;
    return Math.min(wrapped, size - wrapped);
  };
  for (let y = 0; y < size; y += 1) {
    const row = Math.floor(y / band);
    // The pane sits on the floor of its band with a spandrel above it, which is what makes a storey read as one.
    const inPaneY = (y - row * band) / band < paneYShare;
    for (let x = 0; x < size; x += 1) {
      const column = Math.floor(x / cell);
      const inPaneX = (x - column * cell) / cell < paneXShare;
      let value = inPaneY && inPaneX ? glass : 1;
      // 斜撑是白的，切过玻璃；落在竖框上时它本来就与竖框同色，所以它只在玻璃上显形——真实那圈钢管就是如此。
      if (rib && value < 1 && (toLine(x + y) <= half || toLine(x - y) <= half)) value = 1;
      const byte = Math.round(255 * value);
      data.set([byte, byte, byte, 255], (y * size + x) * 4);
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  // A multiplier, not a colour: colour spaces would blend it.
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

const counterClockwise = (points) => {
  let twice = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    twice += a.x * b.y - b.x * a.y;
  }
  return twice < 0 ? points.slice().reverse() : points;
};

/**
 * The shell of one building: the ring stood at each level's height and scaled about its own centre, plus a roof.
 *
 * Local metres, the same frame the tower model is measured in: x east, y up, z south.
 */
export function loftGeometry(ring, height, levels, origin, options = {}) {
  const { base = 0, cap = false } = options;
  // A GeoJSON ring repeats its first point to close itself; kept, that seam becomes a zero-area triangle whose normal
  // is undefined, and one undefined normal in a shared vertex is enough to spoil its neighbours.
  const points = counterClockwise(openRing(ring).map(([lng, lat]) => {
    const { dx, dy } = plane(origin, { lng, lat });
    return { x: dx, y: dy };
  }));
  const centre = points.reduce((sum, point) => ({ x: sum.x + point.x / points.length, y: sum.y + point.y / points.length }), { x: 0, y: 0 });
  const count = points.length;
  const storey = height - base;
  const positions = new Float32Array(levels.length * count * 3);
  // u runs around the ring as a fraction of its own perimeter, v runs up in metres. The fraction is what lets a
  // texture repeat an exact number of times around a shell - see `finStrips` - and one u per ring vertex, shared by
  // every level, is what keeps the stripes plumb as the curve closes in.
  const run = [0];
  for (let index = 1; index < count; index += 1) {
    run[index] = run[index - 1] + Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y);
  }
  const perimeter = run.at(-1) + Math.hypot(points[0].x - points.at(-1).x, points[0].y - points.at(-1).y);
  const uvs = new Float32Array(levels.length * count * 2);
  levels.forEach(([fraction, scale], level) => {
    points.forEach((point, index) => {
      const at = (level * count + index) * 3;
      positions[at] = centre.x + (point.x - centre.x) * scale;
      positions[at + 1] = base + fraction * storey;
      positions[at + 2] = -(centre.y + (point.y - centre.y) * scale);
      const uv = (level * count + index) * 2;
      uvs[uv] = run[index] / perimeter;
      uvs[uv + 1] = positions[at + 1];
    });
  });
  const faces = [];
  for (let level = 0; level + 1 < levels.length; level += 1) {
    for (let index = 0; index < count; index += 1) {
      const next = (index + 1) % count;
      const low = level * count;
      const high = (level + 1) * count;
      faces.push(low + index, low + next, high + index, low + next, high + next, high + index);
    }
  }
  // The roof, and the underside when there is one, are triangulated rather than fanned from the middle: 海心桥's
  // outline is a curved strip whose centre falls outside the deck, and a fan from it sweeps triangles across the
  // hollow and turns their normals the wrong way.
  const lid = (level, upward) => {
    const offset = level * count;
    const flat = points.map((point, index) => new THREE.Vector2(
      positions[(offset + index) * 3],
      -positions[(offset + index) * 3 + 2],
    ));
    for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(flat, [])) {
      const cross = (flat[b].x - flat[a].x) * (flat[c].y - flat[a].y) - (flat[c].x - flat[a].x) * (flat[b].y - flat[a].y);
      const order = cross > 0 === upward ? [a, b, c] : [a, c, b];
      faces.push(offset + order[0], offset + order[1], offset + order[2]);
    }
  };
  const walls = faces.length;
  lid(levels.length - 1, true);
  // A deck you can stand under has an underside, and an open shell seen from below shows its own back faces.
  if (cap) lid(0, false);
  const geometry = new THREE.BufferGeometry();
  geometry.setIndex(faces);
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  // Flat faces rather than smoothed ones: a setback that shares its edge with the wall below it gets an averaged
  // normal, and the ledge the step is made of disappears into a chamfer.
  const faceted = geometry.toNonIndexed();
  geometry.dispose();
  faceted.computeVertexNormals();
  // The lids get their own material slot. Every vertex of a lid sits at one height, so its `v` is one number: the
  // window grid mapped onto a roof samples a single horizontal line of the tile and smears either a band of glass or
  // a band of mullion across the top of the building - a roof wearing windows. Walls are slot 0, lids slot 1.
  faceted.addGroup(0, walls, 0);
  if (faces.length > walls) faceted.addGroup(walls, faces.length - walls, 1);
  // How far around the ring a single trip of u goes, in metres: the only number that turns a repeat count back into
  // the fin spacing a facade was measured in. `u` is a fraction of the *unscaled* ring, so a part built from a scaled
  // one - a podium, or a crown that starts above the foot - has to report the ring it actually drew, or it inherits
  // the shaft's bay count and its windows come out a fifth wider.
  faceted.userData.perimeter = perimeter * levels[0][1];
  return faceted;
}

const openRing = (ring) => (ring.length > 1 && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1]
  ? ring.slice(0, -1)
  : ring);

/**
 * The vertical rhythm a shell has no window grid for, as a one-row texture.
 *
 * u runs around the ring, so every bright column is a plumb line on the facade and the taper of the curve carries
 * them in as it closes in. A `DataTexture` rather than a canvas because the profile is arithmetic, not drawing - and
 * because the curve tables are tested in Node, where there is no document to draw on.
 */
export function finStrips({ columns = 64, duty = 0.4, floor = 0.62, soft = 0.09 } = {}) {
  const data = new Uint8Array(columns * 4);
  for (let column = 0; column < columns; column += 1) {
    // Distance to the seam, which is also the middle of a fin: u wraps, so the bright band straddles 0.
    const at = Math.min(column, columns - column) / columns;
    const away = (low, high) => {
      const t = Math.min(1, Math.max(0, (at - low) / (high - low)));
      return t * t * (3 - 2 * t);
    };
    const value = Math.round(255 * (floor + (1 - floor) * (1 - away(duty / 2 - soft, duty / 2 + soft))));
    data.set([value, value, value, 255], column * 4);
  }
  const texture = new THREE.DataTexture(data, columns, 1, THREE.RGBAFormat);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  // One row of pixels has nothing to average into a mipmap, and the tower is read at a size where a mipmapped strip
  // would arrive as flat grey.
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  // A multiplier on the lamp colour, not a colour of its own.
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/**
 * The two halves of a loft, split at the level its crown starts on.
 *
 * A level carries an absolute fraction, so slicing the table needs no re-basing: both halves stand where the whole
 * one did, and they share the level they are cut at, which is the ledge the setback or the cantilever is made of.
 */
export function splitLevels(levels, crownFrom) {
  if (!(crownFrom > 0)) return [['body', levels]];
  const at = levels.findIndex(([fraction]) => fraction >= crownFrom);
  if (at < 1 || at >= levels.length - 1) return [['body', levels]];
  return [['body', levels.slice(0, at + 1)], ['crown', levels.slice(at)]];
}

/**
 * The shells of the landmarks that have a form, as one group in the scene the tower model already lives in.
 *
 * @param {object} options.features the building snapshot plus the bridge way, from which the rings and heights come.
 * @param {object} options.origin the scene's centre, which is the point the shared model matrix is anchored on.
 */
export function createLandmarkForms({ features, origin }) {
  const group = new THREE.Group();
  group.name = 'landmark-forms';
  const shells = [];
  const built = [];
  let crowns = 0;
  for (const feature of features) {
    const form = LANDMARK_FORMS[feature.properties.osmId];
    if (!form) continue;
    const category = feature.properties.category ?? 'unknown';
    const ring = feature.geometry.coordinates[0];
    let height;
    if (form.kind === 'deck') {
      // The deck stands on drawn numbers, so there is no measured height to read and no hit box to hand out: the
      // nameplate is what opens the card.
      const top = form.base + form.thickness;
      height = top;
    } else {
      // The same coalesce the extrusion height reads, so a shell can never stand at one height while the data behind
      // it is dressed for another.
      height = Number(feature.properties.displayHeight ?? feature.properties.height);
      if (!(height > 0)) continue;
    }
    // The same distance the extrusion ramp reads. The bridge is not in the building snapshot and so carries no
    // `distance` field, which leaves measuring it from the scene centre as the only honest source.
    const centre = ring.slice(0, -1).reduce((sum, point) => ({ lng: sum.lng + point[0] / (ring.length - 1), lat: sum.lat + point[1] / (ring.length - 1) }), { lng: 0, lat: 0 });
    const distance = Math.round(feature.properties.distance ?? distanceMeters(origin, centre));
    const builtShells = [];
    let tallest = null;
    // A part of the structure that is not a loft of the outline - the bridge's rib and its abutments - still has to
    // wear the theme, so it joins the same shell list the painting walks.
    const addPart = (name, geometry, options = {}) => {
      const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ roughness: 0.62, metalness: 0.16, ...options }));
      mesh.name = name;
      mesh.frustumCulled = false;
      group.add(mesh);
      const shell = {
        material: mesh.material, mesh, category, distance, part: 'body',
        glow: form.night?.glow ?? null, share: form.night?.body ?? FORM_NIGHT_BODY, breath: null, lamp: null,
      };
      shells.push(shell);
      builtShells.push(shell);
      return shell;
    };
    let structure = null;
    const outline = refineRing(ring);
    // The category's rhythm, with one form's own override on top: 东塔's facade is described as terracotta piers
    // running from the base, and the way a pier reads at city scale is the wall between two panes, not the band.
    const shape = { ...FACADE_SHAPES[FACADE_CATEGORY_SHAPES[category] ?? 'plain'], ...form.facade };
    // A deck is a deck: it carries no window grid, so it has no grid scale either.
    const storey = form.kind === 'deck' ? null : shellStoreyMetres(feature, height);
    const grid = storey === null ? null : shellGridScale(storey, shape, form.diagrid);
    // 裙房是另一件事：斜撑是塔的结构，不是底座的结构，所以底座仍旧穿街区那一格。
    const footGrid = storey === null ? null : shellGridScale(storey, shape);
    // 点名了立面图的那两栋：一张以"绕环米数 × 标高米数"为坐标的不重复贴图。绕环整数颗菱形，所以接缝上那根撑是完整的。
    const around = storey === null ? 0 : ringPerimeter(ring, origin);
    const atlas = form.facade && grid ? facadeAtlas({
      perimeter: around, height, storey, bays: form.facade.bays ?? 24,
      lattice: form.facade.lattice ? {
        ...form.facade.lattice,
        diamonds: Math.max(2, Math.round(around / grid.cell)),
      } : null,
      piers: form.facade.piers === 'corners' ? cornerStations(ring, origin) : (form.facade.piers ?? null),
      pierWidth: form.facade.pierWidth ?? 0,
      bands: form.facade.bands ? Array.from({ length: form.facade.bands },
        (_, level) => height * (level + 0.5) / form.facade.bands) : null,
      bandHeight: form.facade.bandHeight ?? 0,
      // 一格玻璃占这个开间多宽、多高——东塔的「陶土竖框从塔楼底部延伸，强调竖向」就是靠这两个数读的。
      paneXShare: form.facade.paneXShare, paneYShare: form.facade.paneYShare,
      // 亮哪一格由这一栋自己的 osmId 决定，与楼块那三档灯同一个口径：不手工摆点，也不声称是入住率。
      carve: form.facade.carve ?? null,
      lamps: form.night?.lamps ? { seed: feature.properties.osmId, density: form.night.lamps,
        fins: form.night.fins, wall: FORM_NIGHT_BODY / FORM_NIGHT_LAMP } : null,
    }) : null;
    /** What a loft of this outline wears: the wall, and a lid with the same tone and no window grid on it. */
    const dress = (geometry, scale = grid, part = 'body') => {
      const material = new THREE.MeshStandardMaterial({ roughness: 0.62, metalness: 0.16 });
      if (atlas && scale === grid) {
        // 这一栋的立面图不重复：横轴就是绕环米数、纵轴就是标高米数，所以 480 m 上那道桁架只出现在 480 m。
        // 只有塔身那一格穿它——裙房是底座，斜撑、竖梃、环形桁架都是塔的结构，不该出现在 24 m 的底座上。
        material.map = atlas.texture;
      } else if (scale) {
        // Whole trips around the ring, so the seam is a mullion like every other mullion - the same rule the fins
        // follow - and one cell per `grid.cell` metres of wall up, which is what puts a landmark's facade on the same
        // pitch as the blocks standing beside it.
        const texture = shellGridTexture({ ...shape, rows: scale.rows, columns: scale.columns, size: scale.size, rib: scale.rib });
        texture.repeat.set(Math.max(2, Math.round(geometry.userData.perimeter / scale.cell)), 1 / scale.cell);
        material.map = texture;
      }
      // 灯图只穿在塔身上：塔冠是泛光照明的整块（V6 那档 0.7），给它一张会缺格的窗图等于把冠咬出洞来。
      if (atlas?.lamp && part === 'body' && form.night?.lamps) {
        material.emissiveMap = atlas.lamp;
      } else if (form.night?.fins) {
        // Whole trips of the pattern, so the ring's seam is a fin like every other fin. The spacing the table asks for
        // is then whatever the measured perimeter divides into, which is the same trade the light tracks make.
        const fins = finStrips(form.night.fins);
        fins.repeat.x = Math.max(2, Math.round(geometry.userData.perimeter / form.night.fins.metres));
        material.emissiveMap = fins;
      }
      // A roof is not a facade, and rougher, because that is what a membrane and gravel read as next to glass.
      return [material, new THREE.MeshStandardMaterial({ roughness: 0.86, metalness: 0.04 })];
    };
    /** Stand one loft of this outline in the scene and register what it is wearing, so the theme walk reaches it. */
    const loft = (name, geometry, part, scale = grid) => {
      const [material, roof] = dress(geometry, scale, part);
      const mesh = new THREE.Mesh(geometry, [material, roof]);
      mesh.name = name;
      mesh.frustumCulled = false;
      group.add(mesh);
      const shell = {
        material, roof, mesh, category, distance, part,
        glow: form.night?.glow ?? null,
        lamp: part === 'body' && !!atlas?.lamp && !!form.night?.lamps ? FORM_NIGHT_LAMP : null,
        share: (part === 'crown' ? form.night?.crown ?? FORM_NIGHT_CROWN : form.night?.body ?? FORM_NIGHT_BODY),
        // Which breath period a crown rides; everything else holds its share and breathes through the night walk.
        breath: null,
      };
      shells.push(shell);
      builtShells.push(shell);
      return shell;
    };
    for (const [part, split] of splitLevels(form.levels, form.night?.crownFrom)) {
      // Only the shaft gets the underside: a crown sits on the ledge the split leaves open, and capping it would
      // close a hole that nothing looks through.
      const geometry = loftGeometry(outline, height, refineLevels(split, height), origin,
        part === 'crown' || form.kind !== 'deck' ? {} : { base: form.base, cap: true });
      const shell = loft(part === 'crown' ? `${feature.properties.osmId}:crown` : String(feature.properties.osmId),
        geometry, part);
      if (part === 'crown') shell.breath = crowns++ % FORM_BREATH_MS.length;
      tallest = geometry;
    }
    if (form.podium) {
      // 裙房是同一圈轮廓绕自己的中心放大后立起来的那一圈矮楼，示意高度 24 m：塔身从它的顶面上穿出去，
      // 街道和塔之间就有了一个过渡的东西。它和塔身共用一张窗格，所以读起来是同一栋楼。
      loft(`${feature.properties.osmId}:podium`,
        loftGeometry(outline, form.podium.metres, [[0, form.podium.spread], [1, form.podium.spread]], origin, { cap: true }),
        'podium', footGrid);
    }
    if (form.kind === 'deck') {
      // 桥面的顶面就是 OSM 那条轮廓（上面已经按米数加密后拉伸），这一笔补的是轮廓之外的那部分结构：一道沿
      // 跨径线起拱的肋、若干根吊杆、两个桥台。跨径线是从这条轮廓内部量出来的最长内连线，不是手放的。
      const chord = crossingChord(ring, origin);
      const rib = ribGeometry(chord, form.base + form.thickness);
      addPart(`${feature.properties.osmId}:rib`, rib.geometry, { roughness: 0.42, metalness: 0.55 });
      addPart(`${feature.properties.osmId}:abutment`, abutmentGeometry(chord, form.base), { roughness: 0.72, metalness: 0.08 });
      structure = { span: rib.span, hangers: rib.hangers };
    }
    built.push({
      osmId: feature.properties.osmId, height, category, distance, kind: form.kind, feature,
      // What the facade grid was scaled by, so a card and a test can both point at the number instead of redoing it.
      storey: grid?.storey ?? null, cell: grid?.cell ?? null, rows: grid?.rows ?? null, band: grid?.band ?? null,
      diagrid: form.diagrid ? { storeys: grid.rows, ribMetres: grid.rib?.metres ?? null } : null,
      facade: atlas ? { wide: atlas.wide, tall: atlas.tall, diamond: atlas.diamond, bays: atlas.bay,
        perimeter: atlas.perimeter, height: atlas.height, diamonds: atlas.diamonds,
        piers: (form.facade.piers === 'corners' ? cornerStations(ring, origin) : form.facade.piers) ?? [],
        bands: form.facade.bands ?? 0, lattice: form.facade.lattice ? { ...form.facade.lattice, diamonds: Math.max(2, Math.round(around / grid.cell)) } : null } : null,
      levels: Number(feature.properties.levels) > 0 ? Number(feature.properties.levels) : null,
      podium: form.podium ?? null,
      hit: form.kind !== 'deck', shells: builtShells, structure,
    });
  }
  let wanted = { from: ATMOSPHERES.day, to: ATMOSPHERES.day, share: 0, reveal: 0 };
  let paintedZoom = null;
  let stale = true;
  // How far the night lamps are up, 0 to 1. It walks on the same eased share the walls do, because a form that lit
  // before its neighbours would be a second clock on one transition.
  let lit = null;
  // How long the loop has been running, in milliseconds, which is what each crown divides by its own breath period.
  let breathMs = 0;
  const paintLamps = () => {
    for (const shell of shells) {
      // A roof burns with its walls: it is the same lamp on the same building, and a dark lid on a lit tower reads as a
      // hole cut in the top of it.
      for (const material of [shell.material, shell.roof].filter(Boolean)) {
        if (lit > 0 && shell.glow) {
          // The wall keeps receding under the lamp: the diffuse term is what the scene's own light models the facets
          // with, and an emissive-only mesh is a flat silhouette with a colour on it.
          material.emissive.set(shell.glow);
          // 有灯图的那一格按灯档走（暗格是 0，平均亮度还是由亮了多少格决定），屋顶跟着自己那面墙。
          material.emissiveIntensity = (material === shell.material ? shell.lamp ?? shell.share : shell.share)
            * (shell.breath === null ? 1 : crownBreath((breathMs / FORM_BREATH_MS[shell.breath]) % 1)) * lit;
        } else {
          material.emissive.set(shell.painted ?? '#000000');
          material.emissiveIntensity = 0;
        }
      }
    }
  };
  return {
    group,
    forms: built,
    ids: built.map((form) => form.osmId),
    // What the shells should look like, as a theme pair and a point between them. Nothing is painted here: the layer
    // asks for the picture on the frame it draws, the same number the extrusions read.
    setAtmosphere(options) {
      wanted = { ...wanted, ...options, to: options.to ?? options.from ?? wanted.to };
      stale = true;
    },
    // A shell is one flat colour per material, so following the camera costs four hex mixes - and not following it is
    // what made a landmark tower stand unfogged among a far field that recedes.
    recede(zoom) {
      if (!stale && paintedZoom !== null && Math.abs(zoom - paintedZoom) < 0.02) return false;
      stale = false;
      paintedZoom = zoom;
      // Which end of the walk the lamps are on is read off the theme pair rather than carried as a second flag: the
      // two are already the same fact, and one of them would eventually disagree with the other.
      const from = wanted.resume && lit !== null ? lit : (wanted.from === ATMOSPHERES.night ? 1 : 0);
      const to = wanted.to === ATMOSPHERES.night ? 1 : 0;
      lit = from + (to - from) * wanted.share;
      for (const shell of shells) {
        const at = (theme) => recedeColor(theme, shell.category, shell.distance, { reveal: wanted.reveal, zoom });
        // On an interrupted walk the shells carry on from the colour they are showing rather than from the theme the
        // walk was going to, because a flat-coloured mesh has no expression to keep a middle stop inside.
        const wall = wanted.resume && shell.painted ? shell.painted : at(wanted.from);
        // At share 0 this is `from` bit for bit, so a finished walk - or one that never started - leaves no rounding.
        const colour = mixPreset(wall, at(wanted.to), wanted.share);
        // A mesh has no per-face directional light, so the hex MapLibre paints a wall with lands *brighter* on a shell:
        // measured at the opening camera, the east tower's shaft with its lamp switched off sat at luma 48.9 while the
        // walls beside it - the same colour, run through MapLibre's light - sat at 31.5. The floor MapLibre gives a side
        // face is `1 - light.intensity` (`fill_extrusion.vertex.glsl` remaps the diffuse term to `[1 - intensity, 1]`),
        // so that is the factor that puts a landmark shaft in the same band as the blocks standing next to it. It rides
        // `lit`, so the walk stays continuous and a day frame is bit-for-bit what it was: this is a night-band rule.
        shell.painted = colour;
        for (const material of [shell.material, shell.roof].filter(Boolean)) {
          material.color.set(mixHex(colour, '#000000', (lit ?? 0) * ATMOSPHERES.night.light.intensity));
        }
      }
      paintLamps();
      return true;
    },
    // How far the night is up on the shells, as the lamps last painted it. The tower's bands read this on the frame
    // they draw, so a page that never runs the motion loop still gets its light on the water.
    nightShare() {
      return lit ?? 0;
    },
    // The crowns' slow breath, on the same elapsed clock the tower's own glow reads.
    setBreath(ms) {
      breathMs = Number.isFinite(ms) && ms > 0 ? ms : 0;
      paintLamps();
    },
    setVisible(on) {
      group.visible = Boolean(on);
    },
  };
}
