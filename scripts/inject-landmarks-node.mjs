// 一次性：给 #190 那 8 项 Node 判据做缺陷注入（`tests/engine-landmarks.test.js`）。
// 每条先证明"文件真的被改了"，再跑那一册，跑完逐字还原；红线该落在哪一项写在期望里。
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const L = 'src/engine/landmarks.js';
const original = readFileSync(L, 'utf8');

const cases = [
  ['让位名单失效：壳体与盒子同时画', 'export const underShell = (feature) => FORM_OSM_IDS.includes(feature?.properties?.osmId);',
    'export const underShell = () => false;', '让位的名单变了'],
  ['塔身网格没挂进这一层', '  group.add(model, beam);', '  group.add(beam);', '广州塔那套网格没进这一层'],
  ['摘雾没做：场景的雾又打了一遍', '  for (const material of materials) material.fog = false;',
    '  for (const material of materials) material.fog = true;', '还吃着场景的雾'],
  ['落水带不看名单：省博也被塞了一条', '    if (!LANDMARK_FORMS[form.osmId]?.night?.spill) continue;',
    '    if (false) continue;', '该在江面上的那三条光不是这三条'],
  ['带子不看夜景权重：白昼也亮着', '      glow.material.opacity = glow.alpha * share;',
    '      glow.material.opacity = glow.alpha;', '白昼的落水带是亮的'],
  ['光柱不看夜景权重：白昼也开门', '    beam.visible = lit > 0;', '    beam.visible = true;', '白昼亮着光柱'],
  ['色相只进读数不进材质', '      paintTower();\n      forms.setBreath(hueMs);', '      forms.setBreath(hueMs);',
    '色相走了，塔身的自发光一个字没变'],
  ['停下不重画材质：读数归零了、颜色还停在半圈上', '      hueMs = 0;\n      hueShift = 0;\n      paintTower();',
    '      hueMs = 0;\n      hueShift = 0;', '停下没把出厂帧还回来'],
  ['皇冠呼吸没接到这一拍：两顶一起亮', '      forms.setBreath(hueMs);', '      forms.setBreath(0);',
    '两顶皇冠还是同一个亮度'],
  ['贴图没还：dispose 少了那一笔',
    '          for (const value of Object.values(material)) if (value && value.isTexture) value.dispose();\n', '',
    '还有没还的'],
  ['还了资源不摘节点', '      group.clear();\n', '', '组里还留着节点'],
];

for (const [label, from, to, want] of cases) {
  const hits = original.split(from).length - 1;
  if (hits !== 1) {
    console.log(`\n· ${label}\n  锚点命中 ${hits} 次（要正好 1 次）— 这条注入无效，先修锚点`);
    continue;
  }
  writeFileSync(L, original.split(from).join(to));
  const changed = readFileSync(L, 'utf8') !== original;
  const run = spawnSync('node', ['--test', 'tests/engine-landmarks.test.js'], { encoding: 'utf8', cwd: process.cwd() });
  const out = `${run.stdout}${run.stderr}`;
  const failed = Number(/# fail (\d+)/.exec(out)?.[1] ?? -1);
  const named = out.includes(want);
  writeFileSync(L, original);
  const restored = readFileSync(L, 'utf8') === original;
  console.log(`\n· ${label}`);
  console.log(`  改到了文件：${changed}｜还原：${restored}`);
  console.log(`  红了 ${failed} 项${failed > 0 ? ' ✓' : ' ✗ 没抓到'}｜点名「${want}」：${named ? '✓' : '✗'}`);
  if (!failed) console.log(`  ${out.split('\n').filter((line) => /# (pass|fail|tests)/.test(line)).join(' ')}`);
}
writeFileSync(L, original);
console.log('\n还原检查：', readFileSync(L, 'utf8') === original);
