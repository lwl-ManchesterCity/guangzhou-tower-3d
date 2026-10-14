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
import { Pass } from 'three/addons/postprocessing/Pass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// 满档强度、扩散半径、门槛（线性档），以及离屏缓冲的 MSAA 采样数。三个数都是扫出来的（2026-10-14，
// `scripts/probe-bloom-engine.mjs --sweep`，机位是出厂那一格夜景）：
// · 门槛 0.13 会把整幅底噪抬 8~15 个灰度（画面像蒙了一层灰），0.45 基本没东西起晕（亮窗 p999 才 231），
//   **0.30 ≈ 屏幕上 150/255** 那一档：只有灯芯、车灯与最亮那批窗起晕，底噪只抬 2 个灰度。
// · 半径 0.25 是"亮点外面套一圈硬边"，0.6 把同一份能量摊到看不见；**0.4** 那档摊得开又留得住灯芯。
// · 强度 0.9 开始有过曝（12~17 颗烧到 250），**0.75** 是"亮窗更亮、但没烧掉"的那一格（烧掉的 0 颗）。
// 地标那一层进来之后这三个数**一个都没动**，动的是"谁进这条链"（见下面 `exclude`）：广州塔的塔冠关着泛光就有
// 248/255（线性 ~0.94），比任何还能让灯芯起晕的门槛都亮——阈值抬到 0.5 灯芯就一颗都不晕了（实测那块 900×700
// 起晕的颗数 303 → 0），抬到 0.8 整幅一颗不晕；留在 0.3 则是塔把整条链的能量摊到全幅（中位 30→35.7、烧掉 575 颗，
// 塔腰的格子糊成一团白）。`scripts/probe-bloom-rescan.mjs` 扫了 16 格，两头的都对不上，所以这一格没有参数解。
// 采样数这一格不是审美，也不是越大越好：走合成器之后 `WebGLRenderer({ antialias: true })` 就不管事了
// （它只管默认帧缓冲），边线要靠渲染目标自己的 `samples`。但它在 2 倍屏上贵得离谱，两档都量过
// （1440×960 视口、动效开着、夜景走完整条链）：`samples: 4` 在 1 倍屏 60 fps / 16.7 ms，在 2 倍屏掉到
// **32.9 fps / 33.4 ms**；`samples: 0` 两档都是 60 fps / 16.8 ms（与白昼不走链那一格同一个数）。
// 2 倍屏本来就有一个 CSS 像素对两个设备像素的余量，所以采样按倍率给：1 倍屏留 MSAA，2 倍屏不付这笔钱。
export const BLOOM_SETTINGS = { strength: 0.75, radius: 0.4, threshold: 0.3, samples: 4, msaaMaxRatio: 1.5 };

/**
 * @param {{renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera,
 *   width: number, height: number, exclude?: object[]}} options 宽高用 CSS 像素，倍率从渲染器自己读
 *   （与 `setSize(w, h, false)` 同一口径）；`exclude` 是**不吃泛光**的那几块场景分支（地标那一层）
 */
export function createBloom({ renderer, scene, camera, width, height, exclude = [] }) {
  const samplesFor = (ratio) => (ratio > BLOOM_SETTINGS.msaaMaxRatio ? 0 : BLOOM_SETTINGS.samples);
  const target = new THREE.WebGLRenderTarget(Math.max(1, Math.round(width * renderer.getPixelRatio())),
    Math.max(1, Math.round(height * renderer.getPixelRatio())),
    { type: THREE.HalfFloatType, samples: samplesFor(renderer.getPixelRatio()) });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(width, height), BLOOM_SETTINGS.strength,
    BLOOM_SETTINGS.radius, BLOOM_SETTINGS.threshold);
  composer.addPass(bloom);
  // 地标那一层不进泛光的源，链走完再补画一遍。为什么不能给它一个阈值：塔冠关着泛光就有 248/255（线性 ~0.94），
  // 而灯芯要起晕就得把门槛压在 ~0.33 以下——两头没有能分开的数（16 格扫参在 `probe-bloom-rescan.mjs`）。
  // 现版那侧的塔本来就没有这条链，所以"地标不吃泛光"就是两边同一张画面，而不是新引擎少给了一份效果。
  // 补画这一遍留着颜色与深度：深度是主链那一次渲染留下的，塔身该被前面的楼挡住的部分就仍然被挡住。
  // 灯要留着：塔身是 `MeshStandardMaterial`，没有光的场景里它渲染成黑的。
  const overlay = new Pass();
  overlay.needsSwap = false;
  // 这一次渲染里"用户要它可见、但不吃泛光"的那几块：主链期间它们是藏着的，补画这一道才打开。
  // 走这一格而不是直接看 `exclude`，是为了让外面那句 `group.visible = false` 在夜景也真管用——
  // 判据量"摘掉这一层少了什么"靠的就是那一句，链里替它开门的话夜景那一档就量不到东西（实测 89→89 发、0 颗像素变）。
  let pending = [];
  overlay.render = (nextRenderer, _writeBuffer, readBuffer) => {
    const recorded = scene.children.map((node) => node.visible);
    for (const node of scene.children) node.visible = pending.includes(node) || node.isLight === true;
    const autoClear = nextRenderer.autoClear;
    const background = scene.background;
    // 天色必须临时摘掉：`scene.background` 是一个 Color 时 three 的 `WebGLBackground.render()` 会
    // `forceClear = true`，那一格不看 `autoClear` 的脸色（实测：不摘就把整幅合成结果擦成天空色，画面只剩地标）。
    scene.background = null;
    nextRenderer.autoClear = false;
    nextRenderer.setRenderTarget(readBuffer);
    nextRenderer.render(scene, camera);
    nextRenderer.setRenderTarget(null);
    nextRenderer.autoClear = autoClear;
    scene.background = background;
    scene.children.forEach((node, index) => { node.visible = recorded[index]; });
  };
  composer.addPass(overlay);
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
    // 主链那一次渲染里 `exclude` 必须整个不在（`RenderPass` 与 `UnrealBloomPass` 读的都是这一帧），
    // 补画那一道由 `overlay` 开门——所以这里包住整次 `composer.render()`，而不是在别处管可见性。
    // 只记"这一次因为泛光而藏起来的"那几块：外面本来就藏着的不替它开门。
    render: () => {
      pending = exclude.filter((node) => node.visible);
      for (const node of pending) node.visible = false;
      composer.render();
      for (const node of pending) node.visible = true;
      pending = [];
    },
    report() {
      return { share, strength: bloom.strength, base, radius: bloom.radius, threshold: bloom.threshold,
        samples: target.samples ?? 0, ratio: renderer.getPixelRatio(),
        // 缓冲是设备像素：这一格与画布的 drawing buffer 对不上，就说明整条链在半分辨率上跑。
        size: [Math.round(target.width), Math.round(target.height)],
        // 这一条报的是"有几个名字被挡在泛光的源外面"：判据要能分清"这一层没进画面"与"进了画面但不吃泛光"。
        excluded: exclude.map((node) => node.name) };
    },
    dispose() {
      composer.dispose();
      target.dispose();
    },
  };
}
