// 夜景那一层泛光（bloom）。只做在新引擎这一侧：现版那侧的楼与塔是 MapLibre 自己画的，我们的自定义层是
// **借它的 GL 上下文、在它当前那块帧缓冲上**补一层（`tower.js` 的 `render()`：`autoClear = false` +
// `renderer.render(scene, camera)`）。泛光要读的是**整幅画面**的亮度，而合成器第一步就是把场景画进自己的一块
// 离屏缓冲、最后再把结果贴回画布——那一贴会把 MapLibre 已经画好的底图、路网、光带一起盖掉，
// 也没有任何入口能把 MapLibre 的画面当成纹理喂进来。所以现版这一侧做不了真泛光，能做的只有"每个发光体自己
// 带一圈晕"，而那已经是现状（`building-glow-*`、车灯加色点、壳体落水带）。
//
// 这一层的三个数（strength / radius / threshold）都是量出来的，写在 `BLOOM_SETTINGS` 里；门槛那格要按
// **线性**档读：合成器的中间缓冲是 HalfFloat 的线性图，sRGB 转换发生在最后一道 `OutputPass`，
// 所以线性 0.13 才相当于屏幕上的 100/255（亮窗灯芯那一档以上）。
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// 满档强度、扩散半径、门槛（线性档），以及离屏缓冲的 MSAA 采样数。三个数都是扫出来的（2026-10-14，
// `scripts/probe-bloom-engine.mjs --sweep`，机位是出厂那一格夜景）：
// · 门槛 0.13 会把整幅底噪抬 8~15 个灰度（画面像蒙了一层灰），0.45 基本没东西起晕（亮窗 p999 才 231），
//   **0.30 ≈ 屏幕上 150/255** 那一档：只有灯芯、车灯与最亮那批窗起晕，底噪只抬 2 个灰度。
// · 半径 0.25 是"亮点外面套一圈硬边"，0.6 把同一份能量摊到看不见；**0.4** 那档摊得开又留得住灯芯。
// · 强度 0.9 开始有过曝（12~17 颗烧到 250），**0.75** 是"亮窗更亮、但没烧掉"的那一格（烧掉的 0 颗）。
// 采样数这一格不是审美，也不是越大越好：走合成器之后 `WebGLRenderer({ antialias: true })` 就不管事了
// （它只管默认帧缓冲），边线要靠渲染目标自己的 `samples`。但它在 2 倍屏上贵得离谱，两档都量过
// （1440×960 视口、动效开着、夜景走完整条链）：`samples: 4` 在 1 倍屏 60 fps / 16.7 ms，在 2 倍屏掉到
// **32.9 fps / 33.4 ms**；`samples: 0` 两档都是 60 fps / 16.8 ms（与白昼不走链那一格同一个数）。
// 2 倍屏本来就有一个 CSS 像素对两个设备像素的余量，所以采样按倍率给：1 倍屏留 MSAA，2 倍屏不付这笔钱。
export const BLOOM_SETTINGS = { strength: 0.75, radius: 0.4, threshold: 0.3, samples: 4, msaaMaxRatio: 1.5 };

/**
 * @param {{renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera,
 *   width: number, height: number}} options 宽高用 CSS 像素，倍率从渲染器自己读（与 `setSize(w, h, false)` 同一口径）
 */
export function createBloom({ renderer, scene, camera, width, height }) {
  const samplesFor = (ratio) => (ratio > BLOOM_SETTINGS.msaaMaxRatio ? 0 : BLOOM_SETTINGS.samples);
  const target = new THREE.WebGLRenderTarget(Math.max(1, Math.round(width * renderer.getPixelRatio())),
    Math.max(1, Math.round(height * renderer.getPixelRatio())),
    { type: THREE.HalfFloatType, samples: samplesFor(renderer.getPixelRatio()) });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(width, height), BLOOM_SETTINGS.strength,
    BLOOM_SETTINGS.radius, BLOOM_SETTINGS.threshold);
  composer.addPass(bloom);
  // 最后一道负责"线性 → sRGB"，所以白昼那一档不挂合成器时 `outputColorSpace` 的换算与挂了之后是同一份。
  composer.addPass(new OutputPass());
  // 倍率以渲染器当下这一格为准：构造器读到的那份缓存不保证与后面一致（2 倍屏上读成 1 的话，
  // 整条链就在半分辨率上跑，最后贴回画布会把夜景那一帧整体糊掉——判据钉 `size` 就是钉这件事）。
  const sync = (nextWidth, nextHeight) => {
    const ratio = renderer.getPixelRatio();
    // 窗口拖到另一块屏上（倍率变了）时，采样数跟着倍率走：`samples` 是 `setRenderTarget` 时才读的普通格子。
    target.samples = samplesFor(ratio);
    composer.setPixelRatio(ratio);
    composer.setSize(nextWidth, nextHeight);
  };
  sync(width, height);
  let share = 0;
  // 满档强度单独存一格（`bloom.strength` 是这一帧实际生效的那一个数）：档位与强度分开，
  // 判据才能问"夜景给的是不是满档"，而不被扫参数的取证脚本改到基准。
  let base = BLOOM_SETTINGS.strength;
  const setShare = (next) => {
    share = Math.min(1, Math.max(0, Number(next) || 0));
    // 强度写 0 而不是把这一道 pass 从链里摘掉：摘掉之后"这一帧提交了几次"会跟着强度变，
    // 同一档氛围里两次读数就对不上（引擎那几条数发数的判据读的是差值，差值必须只由被审的那几层贡献）。
    bloom.strength = base * share;
    return share;
  };
  setShare(0);
  return {
    composer,
    bloom,
    get share() {
      return share;
    },
    setShare,
    /** 逐格改那三个数（取证脚本扫参数用）。不给的格子保持原值。 */
    setTune({ strength, radius, threshold } = {}) {
      if (Number.isFinite(strength)) base = strength;
      if (Number.isFinite(radius)) bloom.radius = radius;
      if (Number.isFinite(threshold)) bloom.threshold = threshold;
      setShare(share);
      return share;
    },
    setSize: (nextWidth, nextHeight) => sync(nextWidth, nextHeight),
    render: () => composer.render(),
    report() {
      return { share, strength: bloom.strength, base, radius: bloom.radius, threshold: bloom.threshold,
        samples: target.samples ?? 0, ratio: renderer.getPixelRatio(),
        // 缓冲是设备像素：这一格与画布的 drawing buffer 对不上，就说明整条链在半分辨率上跑。
        size: [Math.round(target.width), Math.round(target.height)] };
    },
    dispose() {
      composer.dispose();
      target.dispose();
    },
  };
}
