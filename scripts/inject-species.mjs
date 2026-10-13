// 一次性：给"三种树"这批新判据做缺陷注入。跑完就删（README 的撤销那节不引它）。
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const target = 'src/vegetation.js';
const original = readFileSync(target, 'utf8');
copyFileSync(target, '/tmp/vegetation-species-inject.bak');

const cases = [
  ['榕换成香樟的身形', 'banyan: { trunk: { girth: 1.7, height: 0.8 }, crown: { radius: 1.15, rise: 0.5, sink: 0.4, lobes: 3, lobeShare: 0.62 } },',
    'banyan: { trunk: { girth: 1.05, height: 1 }, crown: { radius: 0.95, rise: 1.15, sink: 0.4 } },'],
  ['榕的三块穹顶退回一整顶', 'if (!crown.lobes) return crownBuffer([domeVertices(radius, rise)], floor);',
    'if (crown.lobes) return crownBuffer([domeVertices(radius, rise)], floor);'],
  ['冠改成悬在干顶之上', 'const floor = top - crown.sink;', 'const floor = top + crown.sink;'],
  ['主种改成逐株随机', 'scatter((tree.patch ?? tree.seed) * 3 + 11)', 'scatter(tree.seed + 7331)'],
  ['林地名单放进棕榈', 'wood: { banyan: 0.5, camphor: 0.5, palm: 0 },', 'wood: { banyan: 0.4, camphor: 0.4, palm: 0.2 },'],
  ['林地名单加起来不是 1', 'wood: { banyan: 0.5, camphor: 0.5, palm: 0 },', 'wood: { banyan: 0.5, camphor: 0.5, palm: 0.1 },'],
  ['影子半径不再跟着这一种的冠径', 'SPECIES_SHAPE[planted[index]].crown.radius', '1'],
  ['整株改成不等比缩放', 'scale.setScalar(sizes[index]);', 'scale.set(sizes[index], sizes[index] * 1.2, sizes[index]);'],
  ['叶圈少画一片', 'for (let index = 0; index < fronds; index += 1) {', 'for (let index = 0; index < fronds - 1; index += 1) {'],
  ['分桶漏掉第一株', '(name === species ? [...all, index] : all)', '(index > 0 && name === species ? [...all, index] : all)'],
  ['冠比干少装一株', 'mesh.count = slot.indices.length;', 'mesh.count = slot.indices.length - (mesh === crowns ? 1 : 0);'],
  ['影子配到前一株的冠径', 'SPECIES_SHAPE[planted[index]]', 'SPECIES_SHAPE[planted[Math.max(0, index - 1)]]'],
  ['颜色退回一个色号', 'colour.set(CANOPY_COLOURS[tree.kind] ?? CANOPY_COLOURS.park)', 'colour.set(CANOPY_COLOURS.park)'],
];

const rows = [];
for (const [label, from, to] of cases) {
  const hits = original.split(from).length - 1;
  if (hits !== 1) {
    rows.push({ label, mutated: false, note: `锚点命中 ${hits} 次，不是 1` });
    continue;
  }
  writeFileSync(target, original.split(from).join(to));
  const changed = readFileSync(target, 'utf8') !== original;
  const run = spawnSync('node', ['--test', 'tests/vegetation.test.js'], { encoding: 'utf8' });
  const out = `${run.stdout}${run.stderr}`;
  const failed = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
  const counts = /# pass (\d+)[\s\S]*?# fail (\d+)/.exec(out);
  writeFileSync(target, original);
  rows.push({ label, mutated: changed, pass: counts?.[1], fail: counts?.[2], failed });
}
writeFileSync(target, original);
const restored = readFileSync(target, 'utf8') === original;

console.log('文件已还原：', restored);
for (const row of rows) {
  console.log(`\n· ${row.label}`);
  console.log(`  改到了文件：${row.mutated}${row.note ? `（${row.note}）` : ''}`);
  if (row.fail !== undefined) console.log(`  pass ${row.pass} / fail ${row.fail} → ${row.failed.join(' | ') || '（全绿：这条注入没被抓到）'}`);
}
