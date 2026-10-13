// 一次性：给"路口信号灯 / 停止线 / 排队"这批新判据做缺陷注入（页面内第 6 项）。跑完就删，README 里记结果。
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const files = ['src/junctions.js', 'src/signals.js', 'src/traffic-life.js', 'src/near-field.js'];
const original = Object.fromEntries(files.map((file) => [file, readFileSync(file, 'utf8')]));
const J = 'src/junctions.js';
const S = 'src/signals.js';
const T = 'src/traffic-life.js';
const N = 'src/near-field.js';

const cases = [
  ['排队间距归零（一整队叠在停止线上）', J, 'export const SIGNAL_QUEUE_PITCH_METRES = 8;', 'export const SIGNAL_QUEUE_PITCH_METRES = 0;'],
  ['放行间隔归零（一起弹出去）', J, 'export const SIGNAL_HEADWAY_SECONDS = 2.6;', 'export const SIGNAL_HEADWAY_SECONDS = 0;'],
  ['到线秒数不按行进符号取', J, 'const reach = mod((stop - agent.at) * agent.sign, line.length) / agent.speed;', 'const reach = mod(stop - agent.at, line.length) / agent.speed;'],
  ['等灯期间不钉住，只把放行时刻往后挪', J, '    if (seconds < release) return lost + (seconds - hold);', '    if (false) return lost + (seconds - hold);'],
  ['一轴路口也按两轴平分绿灯', J, 'axes: axes.size > 1 ? 2 : 1,', 'axes: 2,'],
  ['主路长绿拆回 40 秒', J, 'const SIGNAL_MAJOR_GREEN_SECONDS = 80;', 'const SIGNAL_MAJOR_GREEN_SECONDS = 40;'],
  ['停止线落点闸门拆掉（对截的车流被分到对头的队里）', J, '              > STOP_LINE_SETBACK_METRES + JUNCTION_TOLERANCE_METRES + 4) continue;', '                > 1e9) continue;'],
  ['同一条 way 的两端也算路口', J, 'if (ways.size < minWays) continue;', 'if (false) continue;'],
  ['小区路交口也给灯', J, 'if (lit.length < minWays) continue;', 'if (false) continue;'],
  ['隧道那一头也算进口道', J, "    if (feature.properties?.brunnel === 'tunnel') continue;", '    if (false) continue;'],
  ['黄灯那一档去掉', J, '  if (t >= start + green && t < start + green + SIGNAL_AMBER_SECONDS) return \'amber\';', '  if (false) return \'amber\';'],
  ['停止线朝向镜像（顺到行车方向）', S, 'spin.setFromAxisAngle(up, Math.atan2(ry, rx));', 'spin.setFromAxisAngle(up, Math.atan2(-ry, rx));'],
  ['停止线抬高压到路面板以下', S, 'export const STOP_LINE_LIFT_METRES = 0.34;', 'export const STOP_LINE_LIFT_METRES = 0.1;'],
  ['停止线回到中心线（不压这一侧车道）', S, 'position.set(lx, STOP_LINE_LIFT_METRES, -ly);', 'position.set(x, STOP_LINE_LIFT_METRES, -y);'],
  ['停止面绕序调头（FrontSide 画零个像素）', S, 'geometry.rotateX(-Math.PI / 2);', 'geometry.rotateX(Math.PI / 2);'],
  ['灯壳不并进杆（顶上一根光棍）', S, 'const parts = [post, head];', 'const parts = [post];'],
  ['灯珠颜色写死成绿（相位不进缓冲）', S, 'colour.set(LENS_COLOURS[state]).multiplyScalar(share);', 'colour.set(LENS_COLOURS.green).multiplyScalar(share);'],
  ['灯的账报假数', S, 'report: { approaches: rows.length, poles: poles.count, lines: lines.count },', 'report: { approaches: 0, poles: 0, lines: 0 },'],
  ['灯不进车那一组', T, '  if (props) group.add(props.group);', ''],
  ['advance 没转发到灯', T, '    props?.advance(seconds);', ''],
  ['夜景开关没转发到灯', T, '    props?.setLit(lit);', ''],
  ['车的位置不扣白等的秒数', T, 'agents.map((agent) => agentPosition(agent, seconds - signalLost(agent.signal, seconds)))', 'agents.map((agent) => agentPosition(agent, seconds))'],
  ['装配器不派生路口', N, 'const junctions = streets.length && withJunctions', 'const junctions = false && streets.length && withJunctions'],
];

const rows = [];
for (const [label, file, from, to] of cases) {
  const source = original[file];
  const hits = source.split(from).length - 1;
  if (hits !== 1) {
    rows.push({ label, mutated: false, note: `锚点在 ${file} 里命中 ${hits} 次` });
    continue;
  }
  writeFileSync(file, source.split(from).join(to));
  const changed = readFileSync(file, 'utf8') !== source;
  const run = spawnSync('node', ['--test', 'tests/junctions.test.js', 'tests/signals.test.js', 'tests/near-field.test.js'],
    { encoding: 'utf8' });
  const out = `${run.stdout}${run.stderr}`;
  const failed = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
  const counts = /# pass (\d+)[\s\S]*?# fail (\d+)/.exec(out);
  writeFileSync(file, source);
  rows.push({ label, mutated: changed, pass: counts?.[1], fail: counts?.[2], failed });
}
for (const [file, text] of Object.entries(original)) writeFileSync(file, text);
console.log('四个文件已还原：', files.every((file) => readFileSync(file, 'utf8') === original[file]));
for (const row of rows) {
  console.log(`\n· ${row.label}`);
  console.log(`  改到了文件：${row.mutated}${row.note ? `（${row.note}）` : ''}`);
  if (row.fail !== undefined) {
    console.log(`  pass ${row.pass} / fail ${row.fail} → ${row.failed.join(' | ') || '（全绿：这条注入没被抓到）'}`);
  }
}
