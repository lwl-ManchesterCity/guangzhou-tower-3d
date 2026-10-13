import * as THREE from 'three';

// 一栋超高层的立面，用到它自己的米数去画才说得清楚：重复的小格子放不下"54 m 一颗的菱形"和"6 道环形桁架"
// 这两种互不整除的东西。这里给每一栋塔生成一张**不重复**的乘性贴图，横轴是绕环米数、纵轴是标高米数，
// 所以画在 480 m 上的那道桁架就只在 480 m 上出现。格子那两层仍然由 `landmark-forms.js` 的 `shellGridTexture`
// 负责（省博那种一格就够的楼不需要这张图）。
//
// 一个像素多少米。0.5 m 让一层（4.27 m）占 8~9 px、一根 1.8 m 的斜撑管占 3~4 px——再细就读不出来了。
export const FACADE_PIXEL_METRES = 0.5;
// 三层关系：玻璃最暗、竖框次之、结构构件最亮。之前斜撑读不出来就是因为撑和竖框同为 1.0，压在一起没有差别。
export const FACADE_GLASS = 0.62;
export const FACADE_MULLION = 0.84;
export const FACADE_STRUCTURE = 1;

const clamp01 = (value) => Math.min(1, Math.max(0, value));
// 凹孔比玻璃还暗：洞后面是深的室内，不是反光的玻璃。
export const FACADE_CARVE = 0.4;
/** 同一个 (开间, 层) 永远给同一个数——洞的位置与灯的位置都得可复现，不能每次载入重新掷。 */
function hash(a, b) {
  let h = ((a * 2654435761 + b * 374761393 + 1103515245) >>> 0);
  h ^= h >> 13; h = (h * 1274126177) >>> 0; h ^= h >> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * 同一张米数坐标上的**灯**：哪一格亮由 `seed` 与它自己那个开间、那一层决定，暗格是 0，所以整根塔身的平均亮度
 * 由"亮了多少格"决定而不是由强度决定——这正是 V7 那条亮度预算要的口径。
 *
 * 亮的是窗的下半截、并且只占pane 的一半宽：V5/V6 量过，整格铺满会亮成一片墙，读不出"窗"。
 */
export function facadeLamps({ wide, tall, storey, height, bay, paneYShare, paneXShare, seed, density, fins = null, perimeter = 0, wall = 0.04 }) {
  const data = new Uint8Array(wide * tall * 4);
  let sum = 0;
  const litAt = (a, b) => hash(a + seed * 7919, b);
  for (let row = 0; row < tall; row += 1) {
    const up = (row + 0.5) * FACADE_PIXEL_METRES;
    const storeyIndex = Math.floor(up / storey);
    const inPaneY = (up - storeyIndex * storey) / storey;
    const litRow = inPaneY > paneYShare * 0.55 && inPaneY < paneYShare * 0.95;
    for (let column = 0; column < wide; column += 1) {
      const around = (column + 0.5) * FACADE_PIXEL_METRES;
      const bayIndex = Math.floor(around / bay);
      const inPaneX = (around - bayIndex * bay) / bay;
      const litColumn = inPaneX > paneXShare * 0.28 && inPaneX < paneXShare * 0.72;
      // 一格都不亮的时候这张图不能是黑的：塔身原来那层竖向灯带的底要留着，否则加了窗反而让中位数掉到
      // 墙面档以下——那是更黑，不是更亮。底带按灯档折算成图上的数（材质系数是灯档，所以这里乘的是它的比值）。
      const trips = fins && fins.metres > 0 ? Math.max(1, Math.round(perimeter / fins.metres)) : 0;
      const phase = trips ? Math.abs(((around * trips / perimeter) % 1) - 0.5) * 2 : 1;
      const duty = fins ? (fins.duty ?? 0.4) : 0;
      const floor = fins ? (fins.floor ?? 0.6) : 0;
      const band = trips ? floor + (1 - floor) * Math.max(0, 1 - Math.abs(phase - duty / 2) / (duty / 2)) : 0;
      const value = litRow && litColumn && litAt(bayIndex, storeyIndex) < density ? 255
        : Math.round(255 * Math.min(1, band * wall));
      const index = (row * wide + column) * 4;
      data[index] = value;
      data[index + 1] = value;
      data[index + 2] = value;
      data[index + 3] = 255;
      sum += value;
    }
  }
  const texture = new THREE.DataTexture(data, wide, tall, THREE.RGBAFormat);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  // 与立面图同一条坐标轴：壳的 v 是标高米数，所以这张图的纵向也得按整根塔高铺开。
  texture.repeat.set(1, 1 / height);
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  // 这张图的平均分量，判据要用它给塔身定上限：材质系数走灯那一档（0.55），但图上九成是墙面档折算下来的底带，
  // 所以"塔身平均发多少光"是 `emissiveIntensity × mean`，不是材质系数本身。
  texture.userData.mean = sum / (wide * tall) / 255;
  return texture;
}

/**
 * 一张以"绕环米数 × 标高米数"为坐标的立面图。
 *
 * @param {object} options
 * @param {number} options.perimeter 绕环一圈多少米（这一栋自己的底圈周长）
 * @param {number} options.height 塔高多少米
 * @param {number} options.storey 一层多少米（快照的 高度 ÷ 层数）
 * @param {number} options.bays 绕环分几个开间
 * @param {object} [options.lattice] 菱形斜撑：`{diamonds, from, to}`——一颗多高由 `perimeter / diamonds` 定，
 *        管径从底部的 `from` 米渐变到顶部的 `to` 米
 * @param {number[]} [options.piers] 竖梃的绕环位置（0~1 的比例），一根柱子就站在这里
 * @param {number} [options.pierWidth] 竖梃多宽（米）
 * @param {number[]} [options.bands] 环形桁架的标高（米）
 * @param {number} [options.bandHeight] 一道桁架多高（米）
 */
export function facadeAtlas({ perimeter, height, storey, bays = 4, lattice = null, piers = null,
  pierWidth = 0, bands = null, bandHeight = 0, paneYShare = 0.72, paneXShare = 0.62, lamps = null,
  carve = null } = {}) {
  if (!(perimeter > 0 && height > 0 && storey > 0)) throw new Error('立面图需要正的周长、塔高与层高');
  const wide = Math.max(8, Math.round(perimeter / FACADE_PIXEL_METRES));
  const tall = Math.max(8, Math.round(height / FACADE_PIXEL_METRES));
  const data = new Uint8Array(wide * tall * 4);
  const bay = perimeter / Math.max(1, bays);
  // 一颗菱形的水平周期：绕环整数颗，所以接缝上那根撑是完整的一根。
  const diamonds = lattice ? Math.max(2, lattice.diamonds ?? 4) : 0;
  const diamond = diamonds ? perimeter / diamonds : 0;
  /** 到最近一条斜线的距离（米）。45° 的线上 `x+y` 走 1 米，垂直方向只走了 1/√2 米。 */
  const toLattice = (x, y) => {
    const wrapped = (value) => {
      const m = ((value % diamond) + diamond) % diamond;
      return Math.min(m, diamond - m);
    };
    return Math.min(wrapped(x + y), wrapped(x - y));
  };
  for (let row = 0; row < tall; row += 1) {
    const up = (row + 0.5) * FACADE_PIXEL_METRES;
    const share = up / height;
    const storeyIndex = Math.floor(up / storey);
    const inPaneY = (up - storeyIndex * storey) / storey < paneYShare;
    // 管径沿高度渐变：中建（施工方）写的是「直径由底部 1.8 米渐变为 0.7 米的大直径厚壁钢管柱」。撑是 45° 的线，
    // `toLattice` 给的是斜坐标上的距离，所以阈值乘 √2 才是点名的那个垂直宽度——全程用米，只有行列下标是像素。
    const ribHalf = lattice ? ((lattice.from ?? 1.8) + ((lattice.to ?? 0.7) - (lattice.from ?? 1.8)) * share) * Math.SQRT2 / 2 : 0;
    for (let column = 0; column < wide; column += 1) {
      const around = (column + 0.5) * FACADE_PIXEL_METRES;
      const bayIndex = Math.floor(around / bay);
      const inPaneX = (around - bayIndex * bay) / bay < paneXShare;
      let value = inPaneY && inPaneX ? FACADE_GLASS : FACADE_MULLION;
      // 省博那面"宝盒"的墙是**有洞的**：花岗石屏上开一个个几何凹孔，玻璃退在后面。所以洞里的格子
      // 比竖框暗、比玻璃还暗一档，读起来是石屏被掏空，而不是又多铺了一层窗。
      if (carve && !inPaneY && hash(bayIndex, storeyIndex) < carve.share) value = FACADE_CARVE;
      if (lattice && toLattice(around, up) <= ribHalf) value = FACADE_STRUCTURE;
      if (piers?.length) {
        // 柱子按绕环比例放，并且绕接缝复制一份：`u` 是环的分数，0 与 1 是同一条线。
        const reach = pierWidth / 2;
        for (const at of piers) {
          const centre = at * perimeter;
          const gap = Math.min(Math.abs(around - centre), perimeter - Math.abs(around - centre));
          if (gap <= reach) { value = FACADE_STRUCTURE; break; }
        }
      }
      if (bands?.length && bandHeight > 0) {
        for (const level of bands) if (Math.abs(up - level) <= bandHeight / 2) { value = FACADE_STRUCTURE; break; }
      }
      const byte = Math.round(255 * clamp01(value));
      const index = (row * wide + column) * 4;
      data[index] = byte;
      data[index + 1] = byte;
      data[index + 2] = byte;
      data[index + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, wide, tall, THREE.RGBAFormat);
  // 横向绕回（u 本来就是一个环），纵向夹住（塔顶之上没有东西可采样）。
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  // 壳体给的 uv 里 u 是绕环的分数、v 是**标高米数**（`loftGeometry`），所以这张图要自己报出比例：横轴一整趟就是一圈，
  // 纵轴一整趟就是这栋楼的总高。不写这一行，440 m 的塔在 v=1 处就夹到贴图最顶那一行，整根塔身读出来是一个色带。
  texture.repeat.set(1, 1 / height);
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  // 乘数，不是一种颜色。
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return { texture, wide, tall, diamond, diamonds, bay, perimeter, height, paneXShare, paneYShare, storey, lamps,
    lamp: lamps ? facadeLamps({ wide, tall, storey, height, bay, paneXShare, paneYShare,
      seed: lamps.seed, density: lamps.density, fins: lamps.fins, perimeter, wall: lamps.wall }) : null };
}

/** 一张立面图里最亮的那一层占多少像素——判据用它确认结构构件真的画上去了。 */
export function structureShare(atlas) {
  const { texture } = atlas;
  const data = texture.image.data;
  let bright = 0;
  for (let i = 0; i < data.length; i += 4) bright += data[i] === 255 ? 1 : 0;
  return bright / (atlas.wide * atlas.tall);
}
