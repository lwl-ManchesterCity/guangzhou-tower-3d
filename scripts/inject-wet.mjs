// 一次性：给"近岸湿线"这批新判据做缺陷注入（页面内第 5 项）。跑完就删，README 里记结果。
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const files = ['src/shadow-pads.js', 'src/near-field.js'];
const original = Object.fromEntries(files.map((file) => [file, readFileSync(file, 'utf8')]));
for (const [file, text] of Object.entries(original)) copyFileSync(file, `/tmp/${file.split('/').pop()}.wet.bak`);

const WET = 'src/shadow-pads.js';
const FIELD = 'src/near-field.js';
const cases = [
  ['偏移方向调头（外环爬到岸上、洲里涂黑）', WET, 'sense: index ? ringSense(points) : -ringSense(points), mitre: 1',
    'sense: index ? -ringSense(points) : ringSense(points), mitre: 1'],
  ['江心洲那一圈不画', WET, 'rings.forEach((points, index) => {', 'rings.slice(0, 1).forEach((points, index) => {'],
  ['宽度闸门拆掉（小水塘也涂）', WET, 'if (ringWidth(outer) < width * minWidth) {', 'if (false) {'],
  ['宽度闸门写反', WET, 'if (ringWidth(outer) < width * minWidth) {', 'if (ringWidth(outer) > width * minWidth) {'],
  ['斜接放回 2 倍', WET, 'mitre: 1 }));', 'mitre: 2 }));'],
  ['距离闸门拆掉', WET, 'if (!outer.some((point) => Math.hypot(point.dx, point.dy) <= maxDistance)) continue;', 'if (false) continue;'],
  ['抬升改到水面以下', WET, 'lift: PAD_LIFT_METRES, sense:', 'lift: 0.1, sense:'],
  ['衰减方向写反（岸边淡出、水里最深）', WET, 'uvs.push(corner[2], corner[3]);', 'uvs.push(1 - corner[2], corner[3]);'],
  ['翻面规则拆掉（顺时针那一半根本不画）', WET,
    'const flip = ((-(b.dy + bn.y * width) + a.dy) * (b.dx - a.dx) - (b.dx + bn.x * width - a.dx) * (-(b.dy) + a.dy)) < 0;',
    'const flip = false;'],
  ['湿线不进近场那三组', FIELD, 'groups: [traffic?.group, boats?.group, wet?.group].filter(Boolean),', 'groups: [traffic?.group, boats?.group].filter(Boolean),'],
  ['镜头门控没转发给湿线', FIELD, 'setZoom(zoom) { traffic?.setZoom(zoom); wet?.setZoom(zoom); }', 'setZoom(zoom) { traffic?.setZoom(zoom); }'],
  ['总开关漏了湿线', FIELD, '      wet?.setShown(on);\n', ''],
  ['读数里的湿线账交空', FIELD, 'shoreBand: wet?.report ?? null,', 'shoreBand: null,'],
  ['没有岸线时硬造一层', FIELD, 'const wet = shore.length ? createShoreBand({ features: shore, origin }) : null;',
    'const wet = createShoreBand({ features: shore, origin });'],
];

const rows = [];
for (const item of cases) {
  const [label, file] = item;
  const edit = item.length > 3 ? [item[2], item[3]] : item[2];
  const edits = Array.isArray(edit[0]) ? edit : [edit];
  const source = original[file];
  const misses = edits.filter(([from]) => source.split(from).length - 1 !== 1);
  if (misses.length) {
    rows.push({ label, mutated: false, note: `锚点在 ${file} 里没命中一次（${misses.map(([f]) => f.slice(0, 24)).join(' / ')}）` });
    continue;
  }
  writeFileSync(file, edits.reduce((text, [from, to]) => text.split(from).join(to), source));
  const changed = readFileSync(file, 'utf8') !== source;
  const run = spawnSync('node', ['--test', 'tests/shadow-pads.test.js', 'tests/near-field.test.js'], { encoding: 'utf8' });
  const out = `${run.stdout}${run.stderr}`;
  const failed = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
  const counts = /# pass (\d+)[\s\S]*?# fail (\d+)/.exec(out);
  writeFileSync(file, source);
  rows.push({ label, mutated: changed, pass: counts?.[1], fail: counts?.[2], failed });
}
for (const [file, text] of Object.entries(original)) writeFileSync(file, text);
console.log('两个文件已还原：', files.every((file) => readFileSync(file, 'utf8') === original[file]));
for (const row of rows) {
  console.log(`\n· ${row.label}`);
  console.log(`  改到了文件：${row.mutated}${row.note ? `（${row.note}）` : ''}`);
  if (row.fail !== undefined) console.log(`  pass ${row.pass} / fail ${row.fail} → ${row.failed.join(' | ') || '（全绿：这条注入没被抓到）'}`);
}
