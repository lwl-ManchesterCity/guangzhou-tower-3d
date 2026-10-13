import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { SCENES } from '../src/scenes.js';
import { distanceToGeometry } from '../src/buildings.js';
import { geometryFromElement } from '../src/jingtai-data.js';

// Compares two raw Overpass snapshots by content, not by totals: an identical element count says nothing about whether
// the near field gained a building. Overpass `out geom` carries no version, so tags and geometry are compared directly.
const [baselinePath, candidatePath, ...flags] = process.argv.slice(2);
if (!baselinePath || !candidatePath) throw new Error('usage: node scripts/diff-jingtai-source.mjs <baseline.json> <candidate.json> [--json] [--out=report.md]');
const { center, radius } = SCENES.jingtai;
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const key = (element) => `${element.type}/${element.id}`;
const buildings = (raw) => new Map(raw.elements.filter((e) => (e.type === 'way' || e.type === 'relation') && (e.tags?.building || e.tags?.['building:part'])).map((e) => [key(e), e]));
const tagText = (element) => `${element.tags?.name ?? '（未命名）'} ${element.tags?.building ?? element.tags?.['building:part'] ?? ''} ${element.tags?.height ? `height=${element.tags.height}` : ''} ${element.tags?.['building:levels'] ? `levels=${element.tags['building:levels']}` : ''}`.trim();

function regionDistance(element) {
  try { return Math.round(distanceToGeometry(center, geometryFromElement(element))); } catch { return null; }
}

const [baseText, candText] = await Promise.all([readFile(baselinePath, 'utf8'), readFile(candidatePath, 'utf8')]);
const base = JSON.parse(baseText), cand = JSON.parse(candText);
const baseAll = new Map(base.elements.map((e) => [key(e), e])), candAll = new Map(cand.elements.map((e) => [key(e), e]));
const baseB = buildings(base), candB = buildings(cand);
const added = [...candB.keys()].filter((k) => !baseB.has(k));
const removed = [...baseB.keys()].filter((k) => !candB.has(k));
const tagChanged = [...baseB.keys()].filter((k) => candB.has(k) && JSON.stringify(baseB.get(k).tags) !== JSON.stringify(candB.get(k).tags));
const geometryChanged = [...baseB.keys()].filter((k) => candB.has(k) && JSON.stringify(baseB.get(k).geometry ?? baseB.get(k).nodes) !== JSON.stringify(candB.get(k).geometry ?? candB.get(k).nodes));
const band = (map) => [100, 200, 300, 500, 1000, 2000].map((limit) => ({ band: limit, count: [...map.values()].filter((e) => { const d = regionDistance(e); return d !== null && d <= limit; }).length }));
const [baseCounts, candCounts] = [band(baseB), band(candB)];
const bands = baseCounts.map((row, index) => ({ ...row, candidate: candCounts[index].count }));
const detail = (keys, get) => keys.map((k) => { const element = get(k); return { id: k, distance: regionDistance(element), label: tagText(element) }; }).sort((a, b) => (a.distance ?? 1e9) - (b.distance ?? 1e9));
const result = {
  baseline: { path: baselinePath, sha256: sha256(baseText), osmTimestamp: base.osm3s?.timestamp_osm_base, elements: base.elements.length, buildingElements: baseB.size },
  candidate: { path: candidatePath, sha256: sha256(candText), osmTimestamp: cand.osm3s?.timestamp_osm_base, elements: cand.elements.length, buildingElements: candB.size },
  nonBuildingAdded: [...candAll.keys()].filter((k) => !baseAll.has(k) && !candB.has(k)).length,
  nonBuildingRemoved: [...baseAll.keys()].filter((k) => !candAll.has(k) && !baseB.has(k)).length,
  added: detail(added, (k) => candB.get(k)), removed: detail(removed, (k) => baseB.get(k)),
  tagChanged: detail(tagChanged, (k) => candB.get(k)), geometryChanged: detail(geometryChanged, (k) => candB.get(k)),
  bands, radius,
};
result.nearFieldDelta = result.added.filter((i) => i.distance <= 500).length - result.removed.filter((i) => i.distance <= 500).length;

if (flags.includes('--json')) console.log(JSON.stringify(result, null, 2));
else {
  const line = (cells) => `| ${cells.join(' | ')} |\n`;
  const list = (title, items) => `\n${title}：${items.length} 项\n\n${items.length ? items.slice(0, 25).map((i) => `- \`${i.id}\` ${i.label}：最近边 ${i.distance ?? '无法判定'} m`).join('\n') : '- 无'}\n`;
  const out = [
    '# 景泰小学 OSM 快照差异核对\n\n',
    '本文件由 `node scripts/diff-jingtai-source.mjs data/jingtai-overpass.json candidates/jingtai-p1/jingtai-overpass.json --out=docs/audits/jingtai-source-diff.md` 生成，只读本地两份原始快照，不发网络请求。\n\n',
    line(['快照', 'OSM 时间戳', '要素总数', '建筑要素数', 'SHA-256']),
    '| --- | --- | --- | --- | --- |\n',
    line(['基准 `data/`', result.baseline.osmTimestamp, result.baseline.elements, result.baseline.buildingElements, `\`${result.baseline.sha256.slice(0, 12)}…\``]),
    line(['候选 `candidates/jingtai-p1/`', result.candidate.osmTimestamp, result.candidate.elements, result.candidate.buildingElements, `\`${result.candidate.sha256.slice(0, 12)}…\``]),
    '\n按内容逐要素比对（Overpass `out geom` 不含 version，故直接比 tags 与 geometry）：\n\n',
    line(['变化类型', '建筑要素', '非建筑要素']),
    '| --- | --- | --- |\n',
    line(['新增', result.added.length, result.nonBuildingAdded]),
    line(['删除', result.removed.length, result.nonBuildingRemoved]),
    line(['标签变化', result.tagChanged.length, '未统计']),
    line(['几何变化', result.geometryChanged.length, '未统计']),
    '\n分区建筑要素数（同一相交规则，基准 → 候选）：\n\n',
    line(['分区(m)', '基准', '候选', '差值']),
    '| --- | --- | --- | --- |\n',
    ...bands.map((row) => line([row.band, row.count, row.candidate, row.candidate - row.count])),
    list('新增建筑明细', result.added), list('删除建筑明细', result.removed), list('标签变化明细', result.tagChanged), list('几何变化明细', result.geometryChanged),
    `\n## 结论\n\n- 近场 500 m 内建筑要素净变化 **${result.nearFieldDelta >= 0 ? '+' : ''}${result.nearFieldDelta} 栋**；100 m 档候选 ${bands[0].candidate} 栋（基准 ${bands[0].count} 栋）。\n`,
    `- ${result.added.length + result.removed.length + result.tagChanged.length + result.geometryChanged.length === 0 ? '两份快照的建筑内容完全一致：本次重新抓取没有带来任何新建筑、新标签或新轮廓，**记录为「无改善」**，不把反复请求本身当作补全。' : '存在建筑内容差异，逐条明细见上，需按 P1 核验流程确认来源身份后再融合。'}\n`,
    '- 原始基准快照及其校验和未被本轮改动；候选快照独立存放，验收前不替换正式数据。\n',
  ].join('');
  const target = flags.find((f) => f.startsWith('--out='))?.slice(6);
  if (target) await writeFile(new URL(`../${target}`, import.meta.url), out);
  else console.log(out);
}
