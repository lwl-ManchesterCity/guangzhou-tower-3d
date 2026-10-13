// 一次性：给"两档尺度"这批新判据做缺陷注入（页面内第 3 项）。跑完就删，README 里记结果。
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const target = 'src/traffic-life.js';
const original = readFileSync(target, 'utf8');
copyFileSync(target, '/tmp/traffic-life-bus-inject.bak');

const cases = [
  ['名单给了 0 % 公交', 'export const BUS_SHARE = 0.1;', 'export const BUS_SHARE = 0;'],
  ['名单给到九成', 'export const BUS_SHARE = 0.1;', 'export const BUS_SHARE = 0.9;'],
  ['公交那一档改成 6.5 m', 'export const BUS_LENGTH_METRES = 10.5;', 'export const BUS_LENGTH_METRES = 6.5;'],
  ['居民路也进公交名单', "export const BUS_CLASSES = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary'];",
    "export const BUS_CLASSES = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential'];"],
  ['谁都是公交', 'export const isBusAgent = (agent, index) => BUS_CLASSES.includes(agent.class)\n  && scatter(Math.abs(Number(agent.osmId) || 0) * 131 + index * 17) < BUS_SHARE;',
    'export const isBusAgent = () => true;'],
  ['谁都不是公交', 'export const isBusAgent = (agent, index) => BUS_CLASSES.includes(agent.class)\n  && scatter(Math.abs(Number(agent.osmId) || 0) * 131 + index * 17) < BUS_SHARE;',
    'export const isBusAgent = () => false;'],
  ['掷骰丢掉序号（一条路要么全公交要么全无）', 'scatter(Math.abs(Number(agent.osmId) || 0) * 131 + index * 17)', 'scatter(Math.abs(Number(agent.osmId) || 0) * 131)'],
  ['实例 scale 丢掉这一档', 'scale.set(size * (shape?.x ?? 1), size * (shape?.y ?? 1), size * (shape?.z ?? 1));', 'scale.set(size, size, size);'],
  ['影子按轿车那辆给', 'radiusX: shapes[index].length / 2 * spread, radiusY: shapes[index].width / 2 * spread,',
    'radiusX: CAR_LENGTH_METRES / 2 * spread, radiusY: CAR_WIDTH_METRES / 2 * spread,'],
  ['灯珠按轿车那辆外移', 'const end = (toward >= 0 ? 1 : -1) * (shapes[index].length / 2 + 0.3);',
    'const end = (toward >= 0 ? 1 : -1) * (CAR_LENGTH_METRES / 2 + 0.3);'],
  ['灯珠高度按轿车那辆给', 'buffer.setXYZ(index, where.x + where.dir.x * end, (shapes[index].height + 0.15) * boost + CAR_LAMP_METRES + carDecks[index],',
    'buffer.setXYZ(index, where.x + where.dir.x * end, (CAR_HEIGHT_METRES + 0.15) * boost + CAR_LAMP_METRES + carDecks[index],'],
  ['公交退回轿车的色', 'const palette = isBusAgent(agent, index) ? BUS_COLOURS : CAR_COLOURS;', 'const palette = CAR_COLOURS;'],
  ['读数里的公交数写死 0', 'buses: shapes.reduce((sum, shape) => sum + (shape.bus ? 1 : 0), 0),', 'buses: 0,'],
  ['形状表不交给判据', 'vehicles.userData.shapes = shapes;', 'vehicles.userData.shapes = [];'],
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
  const run = spawnSync('node', ['--test', 'tests/traffic-life.test.js'], { encoding: 'utf8' });
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
