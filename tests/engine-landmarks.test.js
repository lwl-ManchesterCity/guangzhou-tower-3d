import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { SCENE } from '../src/config.js';
import { FORM_OSM_IDS } from '../src/landmark-forms.js';
import { SHELL_SPILL_ALPHA } from '../src/tower.js';
import { TOWER_CYCLE_MS, createLandmarks, underShell } from '../src/engine/landmarks.js';

const snapshot = async (name) => (await JSON.parse(
  await readFile(new URL(`../public/data/${name}`, import.meta.url), 'utf8'))).features;
const buildings = await snapshot('canton-buildings.geojson');
const bridge = await snapshot('haixin-bridge.geojson');
const river = await snapshot('canton-river.geojson');
const origin = SCENE.center;
const features = [...buildings, ...bridge];

const build = (options = {}) => createLandmarks({ features, river, origin, ...options });
const byName = (group, name) => {
  let found = null;
  group.traverse((object) => { if (object.name === name) found = object; });
  return found;
};
const crownsOf = (landmarks, osmId) => landmarks.forms.forms
  .find((form) => form.osmId === osmId).shells.filter((shell) => shell.part === 'crown');

test('有壳体站着的那几块地，盒子必须先让位——名单与现版样式里那条 formFilter 同一批', () => {
  const shelved = buildings.filter(underShell);
  // 快照里真找得到的只有三栋：海心桥那条是桥面轮廓，不在建筑快照里，所以它不是"少画的盒子"。
  assert.deepEqual(shelved.map((feature) => feature.properties.osmId).sort(), [240896442, 511404889, 184738716].sort(),
    `让位的名单变了：${JSON.stringify(shelved.map((f) => f.properties.osmId))}`);
  assert.equal(FORM_OSM_IDS.length, 4, '壳体名单与让位名单差的那一格必须是桥面');
  // 认不出 osmId 的东西（近场、街道线）不许被误当成壳体收掉。
  assert.equal(underShell(undefined), false);
  assert.equal(underShell({ properties: {} }), false);
  assert.equal(underShell(river[0]), false, '珠江中心线不该被当成壳体底下的盒子');
});

test('壳体名单来自同一批快照，一座塔一片皮，塔身站在自己的脚点上', () => {
  const landmarks = build();
  assert.deepEqual(landmarks.report().ids.slice().sort(), FORM_OSM_IDS.slice().sort(),
    '引擎里立起来的壳体与现版不是同一批');
  assert.equal(landmarks.report().shells, 4, '壳体片数与名单对不上');
  const model = byName(landmarks.group, 'tower-model');
  assert.ok(model, '广州塔那套网格没进这一层');
  const box = new THREE.Box3().setFromObject(model);
  assert.ok(Math.abs(box.min.x) < 60 && Math.abs(box.max.x) < 60, `塔身横向跑到 ${box.min.x}~${box.max.x} m 了`);
  assert.ok(Math.abs(box.min.z) < 60 && Math.abs(box.max.z) < 60, `塔身纵向跑到 ${box.min.z}~${box.max.z} m 了`);
  // 塔脚站在地上，允许 2 m 的余量：最下面那圈立柱是斜的，1.35 m 的圆柱端面因此会垂到脚平面之下几十厘米——
  // 这不是"塔沉下去了"，但沉到一米以下就一定不是这件事了。
  assert.ok(box.min.y > -2 && box.min.y < 1, `塔脚不在地上：最低点 ${box.min.y} m`);
  assert.equal(Math.round(box.max.y), 600, `塔顶不在 600 m：${Math.round(box.max.y)}`);
  assert.ok(landmarks.report().vertices > 90000, `这一层只交了 ${landmarks.report().vertices} 个顶点`);
  landmarks.dispose();
});

test('这一层不许被场景的雾打第二遍：壳体的斜坡烘在自己颜色里，塔身本来就没雾', () => {
  const landmarks = build();
  const fogged = [];
  landmarks.group.traverse((object) => {
    for (const material of [].concat(object.material ?? [])) {
      if (material && material.fog !== false) fogged.push(`${object.name}/${material.name ?? material.type}`);
    }
  });
  assert.deepEqual(fogged, [], `这些材质还吃着场景的雾：${JSON.stringify([...new Set(fogged)])}`);
  assert.ok(landmarks.report().materials > 20, `材质账只有 ${landmarks.report().materials} 份，遍历大概没走到位`);
  landmarks.dispose();
});

test('三条落水带量自珠江中心线：省博不戴皇冠也不投光，把中心线抽掉就没有带子', () => {
  const landmarks = build();
  assert.deepEqual(landmarks.report().bands, ['river-glow', '184738716:spill', '511404889:spill'],
    '该在江面上的那三条光不是这三条');
  for (const name of landmarks.report().bands) {
    const mesh = byName(landmarks.group, name);
    assert.ok(mesh, `${name} 报出来了却没挂进场景`);
    // 带子的位置是烘进几何的（`createGlowBand` 那句 `geometry.translate`），所以量包围盒中心而不是 `mesh.position`。
    const centre = new THREE.Box3().setFromObject(mesh).getCenter(new THREE.Vector3());
    assert.ok(Math.abs(centre.y - 1.5) < 0.6, `${name} 不在水面上那 1.5 m 那一档：${Math.round(centre.y)}`);
    assert.ok(Math.hypot(centre.x, centre.z) > 100, `${name} 的中心离塔脚只有 ${Math.round(Math.hypot(centre.x, centre.z))} m——那不是量出来的位置`);
  }
  const centres = landmarks.report().bands.map((name) =>
    new THREE.Box3().setFromObject(byName(landmarks.group, name)).getCenter(new THREE.Vector3()));
  for (let i = 1; i < centres.length; i++) {
    assert.ok(centres[i].distanceTo(centres[0]) > 100, `第 ${i + 1} 条带子与第一条只相距 ${Math.round(centres[i].distanceTo(centres[0]))} m`);
  }
  const dry = build({ river: [] });
  assert.deepEqual(dry.report().bands, [], '没有中心线的时候不该硬造一条带子');
  assert.ok(dry.report().shells === 4, '抽掉中心线不该把壳体一起抽掉');
  landmarks.dispose();
  dry.dispose();
});

test('夜景闸门：光柱与三条带只跟夜景走，并且每帧都重读——动效关着也得亮', () => {
  const landmarks = build();
  landmarks.update(SCENE.camera.zoom);
  assert.equal(landmarks.report().night, 0, '白昼的夜景权重不是 0');
  assert.equal(landmarks.report().beam, false, '白昼亮着光柱');
  assert.deepEqual(landmarks.spillState().map((row) => row.opacity), [0, 0, 0], '白昼的落水带是亮的');
  landmarks.setAtmosphere('night');
  landmarks.update(SCENE.camera.zoom);
  assert.equal(landmarks.report().night, 1, `切到夜景之后权重停在 ${landmarks.report().night}`);
  assert.equal(landmarks.report().beam, true, '夜景没点亮光柱');
  assert.deepEqual(landmarks.spillState().map((row) => row.visible), [true, true, true]);
  // 塔自己那条 0.55、两塔各 0.24——这个比例是 V7 的账，搬一层皮不该动它。
  assert.deepEqual(landmarks.spillState().map((row) => row.opacity), [0.55, SHELL_SPILL_ALPHA, SHELL_SPILL_ALPHA]);
  landmarks.setAtmosphere('day');
  landmarks.update(SCENE.camera.zoom);
  assert.deepEqual(landmarks.spillState().map((row) => row.opacity), [0, 0, 0], '切回白昼没把带子收掉');
  landmarks.dispose();
});

test('色相是一个环：40 s 转一圈、绕回出厂那一格，停下必须逐字还回出厂帧', () => {
  const landmarks = build({ mode: 'night' });
  landmarks.update(SCENE.camera.zoom);
  let material = null;
  byName(landmarks.group, 'tower-model').traverse((object) => {
    for (const each of [].concat(object.material ?? [])) if (each.name === 'silver') material = each;
  });
  assert.ok(material, '塔身那批立柱的材质找不到了（`silver`）');
  const shipped = { emissive: material.emissive.getHexString(), color: material.color.getHexString(),
    intensity: material.emissiveIntensity };
  assert.equal(landmarks.advance(TOWER_CYCLE_MS / 2).hue, 0.5, '转半圈不该停在 0.5');
  assert.notEqual(material.emissive.getHexString(), shipped.emissive, '色相走了，塔身的自发光一个字没变');
  assert.equal(landmarks.advance(TOWER_CYCLE_MS / 2).hue, 0, `走完一整圈没绕回出厂那一格：${landmarks.report().hue}`);
  const read = () => ({ emissive: material.emissive.getHexString(), color: material.color.getHexString(),
    intensity: material.emissiveIntensity });
  assert.deepEqual(read(), shipped, '绕回出厂那一格时颜色不是原来那一份');
  landmarks.advance(4000);
  assert.ok(landmarks.report().hue > 0);
  assert.notDeepEqual(read(), shipped, '走开 4 s 之后颜色还和出厂一样，那一格根本没在动');
  landmarks.reset();
  assert.deepEqual(read(), shipped, '停下没把出厂帧还回来');
  landmarks.dispose();
});

test('两顶皇冠骑 7 s 与 8 s 两个周期，同一时刻不是同一个亮度', () => {
  const landmarks = build({ mode: 'night' });
  landmarks.update(SCENE.camera.zoom);
  const west = crownsOf(landmarks, 184738716);
  const east = crownsOf(landmarks, 511404889);
  assert.equal(west.length, 1, '西塔的皇冠不是一片');
  assert.equal(east.length, 1, '东塔的皇冠不是一片');
  const pair = () => [west[0].material.emissiveIntensity, east[0].material.emissiveIntensity];
  const shipped = pair();
  assert.ok(shipped[0] > 0 && shipped[1] > 0, '夜景的皇冠一开页就是灭的');
  landmarks.advance(3500);
  const [w35, e35] = pair();
  // 两顶从同一个时钟起步（现版那侧也是这一条），所以错开完全来自周期差。
  assert.ok(Math.abs(w35 - e35) > 1e-6, `3.5 s 上两顶皇冠还是同一个亮度（${w35}）——周期没生效`);
  landmarks.advance(3500);
  const [w70, e70] = pair();
  assert.ok(w70 > 0 && e70 > 0, '走到 7 s 有皇冠灭了');
  landmarks.reset();
  assert.deepEqual(pair(), shipped, '停下没把两顶皇冠放回第 0 毫秒那一格');
  landmarks.dispose();
});

test('拆场景时这一层的几何、材质与贴图都还掉，组里节点摘干净（与 #177 同一口径）', () => {
  const landmarks = build();
  const owned = new Set();
  const fired = new Set();
  landmarks.group.traverse((object) => {
    const watch = (item, label) => {
      if (!item || owned.has(label)) return;
      owned.add(label);
      item.addEventListener('dispose', () => fired.add(label));
    };
    watch(object.geometry, `geometry:${object.name}`);
    for (const material of [].concat(object.material ?? [])) {
      watch(material, `material:${object.name}:${material.name ?? material.type}`);
      for (const value of Object.values(material)) {
        if (value && value.isTexture) watch(value, `texture:${object.name}:${value.name || value.type}`);
      }
    }
  });
  assert.ok(owned.size > 40, `台账只有 ${owned.size} 样，这一层交得出的东西比预期少`);
  assert.ok([...owned].some((label) => label.startsWith('texture:')), '这一层没有贴图，那台账量不到"贴图归造它的一方"这一格');
  landmarks.dispose();
  assert.deepEqual([...owned].filter((label) => !fired.has(label)), [], `还有没还的：${JSON.stringify([...owned].filter((l) => !fired.has(l)))}`);
  assert.equal(landmarks.group.children.length, 0, 'dispose 之后组里还留着节点');
});
