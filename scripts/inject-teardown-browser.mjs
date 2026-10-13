// 一次性：给 #177 那条浏览器判据做缺陷注入（`the new engine gives back every geometry, material and texture it made`）。
// 每条注入先证明"文件真的被改了"，再跑那一条测试；跑完逐字还原。
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const files = ['src/engine/scene.js', 'src/engine/boot.js', 'src/traffic-life.js', 'src/near-field.js', 'src/waterlife.js'];
const original = Object.fromEntries(files.map((file) => [file, readFileSync(file, 'utf8')]));
const E = 'src/engine/scene.js';
const B = 'src/engine/boot.js';
const T = 'src/traffic-life.js';
const N = 'src/near-field.js';

const cases = [
  ['引擎不喊近场的 dispose（#177 原本那一格）', E, '      nearField?.dispose();\n', ''],
  ['引擎不喊楼根接地带的 dispose', E, '      bases?.dispose?.();\n', ''],
  ['引擎不还那两份共用的灯火/光晕材质', E, '      for (const material of lampMaterials) material.dispose();\n', ''],
  ['引擎不还图集贴图（灯窗那张）', E, '      lampTexture.dispose();\n', ''],
  ['调用方不还车灯光晕贴图', B, '    sprite?.dispose();\n', ''],
  ['近场整组没挂进来（台账只量到引擎自己那几块）', B,
    "  const sprite = sceneId === 'canton' ? trafficSprite() : null;", '  const sprite = false ? trafficSprite() : null;'],
  ['装配器不喊船的 dispose', N, '      boats?.dispose();\n', ''],
  ['车那一组拆完不清空', T, '      props?.dispose();\n      group.clear();', '      props?.dispose();'],
  ['船那一组拆完不清空', 'src/waterlife.js', '      lights.material.dispose();\n      group.clear();', '      lights.material.dispose();'],
];

for (const [label, file, from, to] of cases) {
  const source = original[file];
  const hits = source.split(from).length - 1;
  if (hits < 1) { console.log(`\n· ${label}\n  锚点在 ${file} 里没命中（${hits} 次）— 这条注入无效，先修锚点`); continue; }
  writeFileSync(file, source.split(from).join(to));
  const changed = readFileSync(file, 'utf8') !== source;
  const run = spawnSync('npx', ['playwright', 'test', 'tests/engine.browser.spec.js', '-g',
    'gives back every geometry', '--reporter=list'], { encoding: 'utf8', cwd: process.cwd() });
  const out = `${run.stdout}${run.stderr}`;
  const red = /1 failed|Test timeout|Error:/.test(out) && !/1 passed/.test(out);
  const reason = [...out.matchAll(/^\s+(?:✘|×)\s*\d+ .$/gms)].length;
  const first = /AssertionError[^\n]*|expect\(received\)[^\n]*|\n\s*Error[^\n]*/.exec(out)?.[0]?.trim().slice(0, 220);
  writeFileSync(file, source);
  console.log(`\n· ${label}`);
  console.log(`  改到了文件：${changed}（命中 ${hits} 处）`);
  console.log(`  ${red ? '红 ✓ 被抓到' : '绿 ✗ 没抓到'}｜${(first ?? out.split('\n').filter((l) => /passed|failed/.test(l)).join(' ')).slice(0, 200)}`);
  void reason;
}
for (const [file, text] of Object.entries(original)) writeFileSync(file, text);
console.log('\n五个文件已还原：', files.every((file) => readFileSync(file, 'utf8') === original[file]));
