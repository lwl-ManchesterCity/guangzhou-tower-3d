// 一次性：给 #177 那两条 teardown 判据做缺陷注入。跑完就删，README 里记结果。
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const files = ['src/traffic-life.js', 'src/waterlife.js', 'src/shadow-pads.js', 'src/near-field.js', 'src/signals.js'];
const original = Object.fromEntries(files.map((file) => [file, readFileSync(file, 'utf8')]));
const T = 'src/traffic-life.js';
const W = 'src/waterlife.js';
const S = 'src/shadow-pads.js';
const N = 'src/near-field.js';
const G = 'src/signals.js';

const cases = [
  ['影贴片没还', T, '      pads.dispose();\n', ''],
  ['光点材质没还', T, '      glow.material.dispose();\n', ''],
  ['光点几何没还', T, '      glowGeometry.dispose();\n', ''],
  ['灯那三层没还', T, '      props?.dispose();\n', ''],
  ['车那一组拆完不清空', T, '      props?.dispose();\n      group.clear();', '      props?.dispose();'],
  ['船上两层几何没还', W, '      hull.dispose();\n      strip.dispose();\n', ''],
  ['船的材质没还', W, '      hulls.material.dispose();\n', ''],
  ['船拆完不清空', W, '      lights.material.dispose();\n      group.clear();', '      lights.material.dispose();'],
  // 湿线与楼根带那两段 dispose 逐字相同（同一套写法），所以这一条只能"两处一起改"，
  // 由近场那一项抓到湿线、由 `shadow-pads.test.js` 那两项抓到楼根带。
  ['贴片/带的贴图没还（两处一起）', S, '      map.dispose();\n', ''],
  ['灯杆几何没还', G, '      poles.geometry.dispose();\n', ''],
  ['停止线材质没还', G, '      lineMaterial.dispose();\n', ''],
  ['装配器不喊船的 dispose', N, '      boats?.dispose();\n', ''],
  ['装配器不喊湿线的 dispose', N, '      wet?.dispose();\n', ''],
  // 装配器自己不再清组（各组由自己的 dispose 清空），所以这一格改成注入「不喊车那组」：
  // 三条 dispose 口令各管一组，少喊哪一条都要被同一份判据抓到，不然就是只测了一组。
  ['装配器不喊车的 dispose', N, '      traffic?.dispose();\n', ''],
];

const rows = [];
for (const [label, file, from, to] of cases) {
  const source = original[file];
  const hits = source.split(from).length - 1;
  if (hits < 1) {
    rows.push({ label, mutated: false, note: `锚点在 ${file} 里没命中` });
    continue;
  }
  writeFileSync(file, source.split(from).join(to));
  const changed = readFileSync(file, 'utf8') !== source;
  const run = spawnSync('node', ['--test', 'tests/near-field.test.js'], { encoding: 'utf8' });
  const out = `${run.stdout}${run.stderr}`;
  const failed = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
  const counts = /# pass (\d+)[\s\S]*?# fail (\d+)/.exec(out);
  writeFileSync(file, source);
  rows.push({ label, mutated: changed, pass: counts?.[1], fail: counts?.[2], failed });
}
for (const [file, text] of Object.entries(original)) writeFileSync(file, text);
console.log('五个文件已还原：', files.every((file) => readFileSync(file, 'utf8') === original[file]));
for (const row of rows) {
  console.log(`\n· ${row.label}`);
  console.log(`  改到了文件：${row.mutated}${row.note ? `（${row.note}）` : ''}`);
  if (row.fail !== undefined) {
    console.log(`  pass ${row.pass} / fail ${row.fail} → ${row.failed.join(' | ') || '（全绿：这条注入没被抓到）'}`);
  }
}
