// 路口的灯与停止线。灯头、杆子、周期全是画的（OSM 这一公里里没有信号杆要素，见 `junctions.js` 开头那段），
// 位置一个都不手摆：进口道就是那条 way 自己的端点与切线，停止线就在端点前 `STOP_LINE_SETBACK_METRES` 米。
//
// 三张网格都挂在 `traffic-life` 那一组里（`createTrafficLife` 负责 add），所以：
// 高度透视镜的 `setVisible` 一并收走它们，浏览器那几条"读像素之前先藏近场"的门槛自动覆盖，
// 而夜景那条数发数的判据会跟着多三发——那三发就是杆、灯、停止线。
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { signalState } from './junctions.js';

export const POLE_METRES = 3.2;
export const POLE_RADIUS_METRES = 0.075;
// 杆子与停止线的抬升：新引擎那侧路面板在 `GROUND_LAYERS.road = 0.3`，低于它会被自己那条路挡住。
export const POLE_LIFT_METRES = 0.32;
export const STOP_LINE_LIFT_METRES = 0.34;
// 灯头挑到路心上方一点：贴在杆顶上会从行车道那一侧看不到，而司机看的正是"我这方向亮什么"。
export const LENS_METRES = 0.42;
// 灯头在杆顶之上再高这一格（灯壳顶到灯珠中心），以及朝来车一侧挑出去的米数。
export const LENS_TOP_METRES = 0.25;
export const LENS_REACH_METRES = 0.25;
// 杆在路缘那一侧：车道中心外 `LANE_OFFSET = 3.2` m、车道半宽约 0.9 m，所以 5.4 m 才是"车外面的杆"而不是隔离墩。
export const POLE_KERB_OFFSET_METRES = 5.4;
// 停止线：横跨一条车道、顺着行车方向 0.5 m 厚。
export const STOP_LINE_METRES = 3.6;
export const STOP_LINE_THICKNESS_METRES = 0.5;
export const STOP_LINE_OPACITY = 0.6;
// 中灰而不是马路牙子白：这一场的路面在白天是接近白的浅灰、在夜里是深蓝，
// 白色那条实测只改得动 9 个像素（等于没画），中灰在两档里都比路面亮/暗出上百级。
export const STOP_LINE_COLOUR = '#8d939b';
export const POLE_COLOUR = '#4b5158';
// 三色的灯与"这一相位此刻不亮"的暗壳。白昼那一档不写全亮：不写的话 702 个亮点会把夜景的账带进白天。
export const LENS_COLOURS = { red: '#ff2d1a', amber: '#ffb020', green: '#2fd66b', off: '#22262a' };
export const LENS_DAY_SHARE = 0.55;

/** 一根杆加一个灯头：两段合成一份几何，所以 702 根杆是一个 draw call。 */
export function poleGeometry() {
  const post = new THREE.CylinderGeometry(POLE_RADIUS_METRES, POLE_RADIUS_METRES * 1.35, POLE_METRES, 6, 1);
  post.translate(0, POLE_METRES / 2, 0);
  const head = new THREE.BoxGeometry(0.26, 0.5, 0.2);
  head.translate(0, POLE_METRES - 0.1, 0);
  const parts = [post, head];
  const merged = mergeGeometries(parts, false);
  for (const part of parts) part.dispose();
  merged.computeVertexNormals();
  return merged;
}

/** 一片躺平的停止线（单位方形，实例的 scale 就是它的长与厚）。 */
export function stopLineGeometry() {
  const geometry = new THREE.PlaneGeometry(1, 1);
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

/**
 * 把路口里"真的接上了车流进口道"的那些端点挑出来：没有车的进口道不配一根杆。
 * `assignSignals` 会把 `stop` 记回 approach 上，这一格就是它的读数。
 */
export function signalPositions(junctions = []) {
  const rows = [];
  for (const junction of junctions) {
    for (const approach of junction.approaches) {
      if (!approach.lit || !approach.stop) continue;
      rows.push({ junction, approach });
    }
  }
  return rows;
}

/**
 * 灯杆、灯头、停止线这三层几何。
 *
 * `advance(seconds)` 每拍重排一次灯头颜色：一条 `signalLost` 之外的第二处"跟着绝对秒走"的写，
 * 所以它与车流共用同一个秒表，镜头停下、动效关掉都回到出厂那一帧。
 */
export function createSignalProps({ junctions = [] } = {}) {
  const group = new THREE.Group();
  group.name = 'traffic-signals';
  const rows = signalPositions(junctions);
  const poleMaterial = new THREE.MeshStandardMaterial({ color: POLE_COLOUR, roughness: 0.62, metalness: 0.35 });
  const lensMaterial = new THREE.MeshBasicMaterial({ color: '#ffffff' });
  const lineMaterial = new THREE.MeshBasicMaterial({
    color: STOP_LINE_COLOUR, transparent: true, opacity: STOP_LINE_OPACITY, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const poles = new THREE.InstancedMesh(poleGeometry(), poleMaterial, Math.max(1, rows.length));
  poles.name = 'signal-poles';
  const lenses = new THREE.InstancedMesh(new THREE.SphereGeometry(LENS_METRES / 2, 8, 6), lensMaterial, Math.max(1, rows.length));
  lenses.name = 'signal-lenses';
  const lines = new THREE.InstancedMesh(stopLineGeometry(), lineMaterial, Math.max(1, rows.length));
  lines.name = 'signal-stop-lines';
  for (const mesh of [poles, lenses, lines]) {
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    mesh.count = rows.length;
    group.add(mesh);
  }
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const spin = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  rows.forEach((row, index) => {
    const { x, y, hx, hy, rx, ry, lx, ly } = row.approach.stop;
    // 杆立在进口道那一侧的路缘上（车道外沿之外），灯头在杆顶、朝来车那一侧挑出一点。
    position.set(x + rx * POLE_KERB_OFFSET_METRES, POLE_LIFT_METRES, -(y + ry * POLE_KERB_OFFSET_METRES));
    spin.setFromAxisAngle(up, Math.atan2(hy, hx));
    scale.setScalar(1);
    matrix.compose(position, spin, scale);
    poles.setMatrixAt(index, matrix);
    // 局部 +x 转到 `(hx, hy)`、局部 +y 转到世界 `-z`（也就是平面里的 `-y`），所以灯头朝来车偏 `LENS_REACH` 就是
    // 沿行进方向负向：`compose` 之后再按世界坐标减掉那一截，比再算一次转角省事。
    position.set(x + rx * POLE_KERB_OFFSET_METRES - hx * LENS_REACH_METRES,
      POLE_LIFT_METRES + POLE_METRES + LENS_TOP_METRES, -(y + ry * POLE_KERB_OFFSET_METRES - hy * LENS_REACH_METRES));
    scale.setScalar(1);
    matrix.compose(position, spin, scale);
    lenses.setMatrixAt(index, matrix);
    position.set(lx, STOP_LINE_LIFT_METRES, -ly);
    scale.set(STOP_LINE_METRES, 1, STOP_LINE_THICKNESS_METRES);
    // 停止线的长轴要横跨车道，也就是压在"这一侧的法线"方向上：局部 +x → 平面 `(rx, ry)`。
    spin.setFromAxisAngle(up, Math.atan2(ry, rx));
    matrix.compose(position, spin, scale);
    lines.setMatrixAt(index, matrix);
  });
  poles.instanceMatrix.needsUpdate = true;
  lenses.instanceMatrix.needsUpdate = true;
  lines.instanceMatrix.needsUpdate = true;
  const colour = new THREE.Color();
  let clock = 0;
  let lit = 0;
  // 记下每一盏此刻实际涂上去的颜色：判据读的是"涂了什么"，不是"按公式应该是什么"。
  const painted = rows.map(() => 'red');
  const paint = () => {
    rows.forEach((row, index) => {
      const state = signalState(row.junction, row.approach.phase, clock);
      painted[index] = state;
      // 白昼只写半亮：灯该在场，但不该在白天当发光体。
      const share = LENS_DAY_SHARE + (1 - LENS_DAY_SHARE) * lit;
      colour.set(LENS_COLOURS[state]).multiplyScalar(share);
      lenses.setColorAt(index, colour);
    });
    if (lenses.instanceColor) lenses.instanceColor.needsUpdate = true;
  };
  paint();
  return {
    group,
    report: { approaches: rows.length, poles: poles.count, lines: lines.count },
    advance(seconds) {
      clock = seconds;
      paint();
    },
    /** 夜景那一档：0 是白昼的半亮，1 是全亮。 */
    setLit(share) {
      lit = Number.isFinite(share) ? Math.min(1, Math.max(0, share)) : (share ? 1 : 0);
      paint();
    },
    /** 给判据看的一眼：此刻每个相位各涂了什么颜色，以及白昼/夜景那一档的亮度落在第几级。 */
    parts() {
      return {
        approaches: rows.length,
        // 挂在谁里面：`createTrafficLife` 忘了 `group.add` 时这一格是 null，判据当场红。
        parent: group.parent?.name ?? null,
        clock,
        lit,
        states: painted.reduce((tally, state) => ({ ...tally, [state]: (tally[state] ?? 0) + 1 }), {}),
        first: painted[0] ?? null,
      };
    },
    /**
     * 前 `n` 个灯头**真正写进实例缓冲**的 RGB，连同这一颗该报的相位。
     * `setColorAt` 走错材质时会静默不生效，而颜色与相位必须逐颗对得上：判据读的是缓冲里的数，不是公式的数。
     */
    lensColours(n = 3) {
      if (!lenses.instanceColor) return [];
      const out = [];
      for (let index = 0; index < Math.min(n, rows.length); index += 1) {
        out.push({ state: painted[index], rgb: [0, 1, 2].map((k) => lenses.instanceColor.array[index * 3 + k]) });
      }
      return out;
    },
    dispose() {
      poles.geometry.dispose();
      lenses.geometry.dispose();
      lines.geometry.dispose();
      poleMaterial.dispose();
      lensMaterial.dispose();
      lineMaterial.dispose();
      group.clear();
    },
  };
}
