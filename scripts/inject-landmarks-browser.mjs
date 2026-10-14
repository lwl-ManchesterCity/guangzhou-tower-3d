// 一次性：给 #190 那两条浏览器判据做缺陷注入（`stands the three landmark shells …`、泛光那一项的"地标不吃链"
// 与 teardown 台账）。每条先证明"文件真的被改了"，再跑那一条测试，跑完逐字还原；红线该落在哪一句写在期望里。
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const L = 'src/engine/landmarks.js';
const S = 'src/engine/scene.js';
const B = 'src/engine/bloom.js';
const files = [L, S, B];
const original = Object.fromEntries(files.map((file) => [file, readFileSync(file, 'utf8')]));

const layer = ['stands the three landmark shells'];
const mount = ['mounts behind the switch'];
const bloom = ['blooms its night lamps'];
const census = ['gives back every geometry'];

const cases = [
  ['壳体底下的盒子没让位：一栋塔两套皮', S,
    '  const bucketFeatures = (data.buildings ?? []).filter((feature) =>\n    !shellFeatures.length || !underShell(feature));',
    '  const bucketFeatures = (data.buildings ?? []);', mount, '楼块'],
  ['面板不报壳体片数：进了画面不上账', S, '壳体 ${landmarks?.report().shells ?? 0} 片', '壳体 0 片',
    layer, '面板没把壳体报出来'],
  ['墙色不跟镜头：那条距离斜坡冻在开屏那一档', S, 'landmarks?.update(view.zoom);', 'landmarks?.update(15.5);',
    layer, '壳体的墙色一格没变'],
  ['地标又进泛光的源：塔把整条链的能量摊到全幅', S,
    '        exclude: landmarks ? [landmarks.group] : [] });', '      });', bloom, '没把地标那一层挡在源外面'],
  ['补画那一道不画地标：夜里塔直接消失', B,
    '    for (const node of scene.children) node.visible = pending.includes(node) || node.isLight === true;',
    '    for (const node of scene.children) node.visible = node.isLight === true;', layer, '夜景摘掉这一层的差'],
  ['摘雾没做：引擎的雾又打了一遍', L, '  for (const material of materials) material.fog = false;',
    '  for (const material of materials) material.fog = true;', layer, '还在吃引擎的雾'],
  ['色相只进读数不进材质：塔身不动色', L,
    '      paintTower();\n      forms.setBreath(hueMs);\n      return { hue:',
    '      forms.setBreath(hueMs);\n      return { hue:', layer, '没进材质'],
  ['停动效不重画材质：读数归零了、颜色还停在半圈上', L,
    '      hueMs = 0;\n      hueShift = 0;\n      paintTower();', '      hueMs = 0;\n      hueShift = 0;',
    layer, '没交回出厂那一帧'],
  ['落水带不看夜景权重：白昼也亮着', L,
    '      glow.material.opacity = glow.alpha * share;\n      glow.mesh.visible = share > 0;',
    '      glow.material.opacity = glow.alpha;\n      glow.mesh.visible = true;', layer, '白昼的光柱或落水带亮着'],
  ['光柱不看夜景权重：白昼也开门', L, '    beam.visible = lit > 0;', '    beam.visible = true;',
    layer, '白昼的光柱或落水带亮着'],
  ['贴图没还：dispose 少了那一笔', L,
    '          for (const value of Object.values(material)) if (value && value.isTexture) value.dispose();\n', '',
    census, 'dispose 没还掉'],
  ['还了资源不摘节点：组里留着那一整块', L, '      group.clear();\n', '', census, '还留着节点'],
];

for (const [label, file, from, to, groups, want] of cases) {
  const source = original[file];
  const hits = source.split(from).length - 1;
  if (hits !== 1) {
    console.log(`\n· ${label}\n  锚点在 ${file} 里命中 ${hits} 次（要正好 1 次）— 这条注入无效，先修锚点`);
    continue;
  }
  writeFileSync(file, source.split(from).join(to));
  const changed = readFileSync(file, 'utf8') !== source;
  const run = spawnSync('npx', ['playwright', 'test', 'tests/engine.browser.spec.js', '-g', groups[0],
    '--reporter=list'], { encoding: 'utf8', cwd: process.cwd() });
  const out = `${run.stdout}${run.stderr}`;
  const red = /1 failed/.test(out) && !/1 passed/.test(out);
  const first = /Error:[^\n]*/.exec(out)?.[0]?.slice(0, 150);
  writeFileSync(file, source);
  const restored = readFileSync(file, 'utf8') === source;
  console.log(`\n· ${label}`);
  console.log(`  改到了文件：${changed}｜还原：${restored}`);
  console.log(`  ${red ? `红 ✓ 被抓到（${first ?? ''}）` : `绿 ✗ 没抓到｜${out.split('\n').filter((line) => /passed|failed/.test(line)).join(' ')}`}｜期望点名「${want}」`);
}

for (const [file, text] of Object.entries(original)) writeFileSync(file, text);
console.log('\n还原检查：', files.every((file) => readFileSync(file, 'utf8') === original[file]));
