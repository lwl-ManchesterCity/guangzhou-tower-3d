// P1-4～P1-6: merge the non-OSM near-field footprints into the 景泰 scene snapshot.
// Default output is a candidate directory so `public/data/` stays untouched until the merge is reviewed; `--out=public/data`
// promotes it and records the second source in `jingtai-metadata.json`.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { SCENES } from '../src/scenes.js';
import { distanceToGeometry } from '../src/buildings.js';
import { COVERAGE_BANDS, NEAR_FIELD_METERS } from '../src/coverage-audit.js';
import { EASTASIA_SOURCE, MERGE_RULES, REJECT_REASONS, normalizeFootprints, mergeJingtaiBuildings, validateMergedJingtai } from '../src/footprints.js';

const root = new URL('../', import.meta.url);
const arg = (name) => process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
const outName = (arg('--out') ?? 'candidates/jingtai-p1-merge').replace(/\/$/, '');
const outDir = `${outName}/`;
const promote = outName === 'public/data';
const osmPath = arg('--osm') ?? 'public/data/jingtai-buildings.geojson';
const groundsPath = arg('--grounds') ?? 'public/data/jingtai-grounds.geojson';
const footprintsPath = arg('--footprints') ?? 'data/jingtai-eastasia-footprints.geojson';
const metadataPath = arg('--metadata') ?? 'public/data/jingtai-metadata.json';
const reportPath = arg('--report') ?? 'docs/audits/jingtai-footprint-merge.md';
const read = async (path) => JSON.parse(await readFile(new URL(path, root), 'utf8'));
const sha = async (path) => createHash('sha256').update(await readFile(new URL(path, root))).digest('hex');
const { center, radius } = SCENES.jingtai;

const [readBuildings, grounds, collection] = await Promise.all([read(osmPath), read(groundsPath), read(footprintsPath)]);
// Re-promoting must be a full re-merge, not an append: any outline from a previous run is stripped first, so the OSM
// layer is the only base and the rule set stays the single source of truth for which footprints exist. The merge
// envelope (`properties.sources`) is dropped too, so the recorded base digest is the same whether the input was
// promoted already or not.
const osmBase = { type: readBuildings.type, features: readBuildings.features.filter((feature) => !feature.properties.footprintSource) };
const replacedFootprints = readBuildings.features.length - osmBase.features.length;
const campus = grounds.features.find((feature) => feature.properties.campus);
if (!campus) throw new Error('Campus ground feature missing — the merge must know which polygon to keep clear');
const campusGeometry = campus.geometry;

const started = Date.now();
const result = normalizeFootprints(collection, { center, radius, campusGeometry, osmFeatures: osmBase.features, ...MERGE_RULES });
const merged = mergeJingtaiBuildings(osmBase, result.features);
validateMergedJingtai(merged, osmBase, result, { center, radius, campusGeometry });
const elapsedMs = Date.now() - started;

const bandOf = (features) => COVERAGE_BANDS.map((band) => ({
  band, features: features.filter((feature) => distanceToGeometry(center, feature.geometry) <= band).length,
}));
const osmBands = bandOf(osmBase.features);
const mergedBands = bandOf(merged.features);
const nearAdded = result.features.filter((feature) => feature.properties.distance <= NEAR_FIELD_METERS).length;
const areaStats = (features) => {
  const areas = features.map((feature) => feature.properties.area).sort((a, b) => a - b);
  return { count: areas.length, min: areas[0] ?? 0, median: areas[Math.floor(areas.length / 2)] ?? 0, max: areas.at(-1) ?? 0, sum: areas.reduce((sum, area) => sum + area, 0) };
};
const within100 = result.features.filter((feature) => feature.properties.distance <= 100);
const heightsOf = (features) => features.reduce((counts, feature) => ({ ...counts, [feature.properties.heightSource]: (counts[feature.properties.heightSource] ?? 0) + 1 }), {});

const payload = {
  type: 'jingtai-footprint-merge', generatedAt: new Date().toISOString(), elapsedMs,
  center, radiusMeters: radius, nearFieldMeters: NEAR_FIELD_METERS,
  source: EASTASIA_SOURCE, rules: { ...MERGE_RULES, rejectReasons: REJECT_REASONS, policy: '面积阈值 → 重复合并 → 15 m 内以 OSM 为准 → 校园用地内一律剔除；新增轮廓只带示意高度，不进入名称检索' },
  osmBase: {
    path: osmPath, features: osmBase.features.length, strippedFromInput: replacedFootprints,
    sha256: createHash('sha256').update(`${JSON.stringify(osmBase)}\n`).digest('hex'),
  },
  inputs: { [osmPath]: await sha(osmPath), [groundsPath]: await sha(groundsPath), [footprintsPath]: await sha(footprintsPath) },
  counts: { osmBuildings: osmBase.features.length, addedFootprints: result.features.length, merged: merged.features.length, nearFieldAdded: nearAdded },
  stats: result.stats,
  bands: COVERAGE_BANDS.map((band, index) => ({ band, osm: osmBands[index].features, merged: mergedBands[index].features, added: mergedBands[index].features - osmBands[index].features })),
  addedAreaSquareMeters: areaStats(result.features), addedWithin100m: areaStats(within100),
};

const indexFile = 'public/data/jingtai-buildings-index.json';
const searchIndexFile = await read(indexFile);
const indexed = searchIndexFile.entries.filter((entry) => !entry.campus);
const mergedIds = new Set(merged.features.map((feature) => String(feature.properties.osmId)));
if (!indexed.every((entry) => mergedIds.has(String(entry.osmId)))) throw new Error(`${indexFile} points at a building the merged snapshot does not contain`);
if (indexed.some((entry) => String(entry.osmId).startsWith(EASTASIA_SOURCE.idPrefix))) throw new Error('Footprints must stay out of the name/address index');

const rows = payload.bands.map((row) => `| ${row.band} | ${row.osm} | ${row.added} | ${row.merged} |`).join('\n');
const rejects = Object.entries(result.stats.rejected).map(([reason, count]) => `- \`${reason}\`：${count}`).join('\n');
const report = `# 景泰小学近场轮廓合并${promote ? '（已升为正式数据）' : '（候选）'}

由 \`node scripts/merge-jingtai-footprints.mjs${promote ? ' --out=public/data' : ''}\` 生成；输入为本地文件，不发网络请求。${promote
  ? `已写入 \`public/data/jingtai-buildings.geojson\`（${merged.features.length} 栋）与 \`public/data/jingtai-metadata.json\` 的 \`footprintMerge\` 段；\`jingtai-buildings-index.json\`、\`jingtai-grounds.geojson\`、\`jingtai-pois.json\` 逐字节未动，撤销见 \`backup/pre-p1-merge/\`。`
  : `**只写 \`${outDir}\`，\`public/data/\` 未被改动。**`}

- 基线：从 \`${osmPath}\` 读出 ${readBuildings.features.length} 栋，先剥离上一轮并入的 ${replacedFootprints} 个轮廓，OSM 底为 ${osmBase.features.length} 栋。
- 建筑轮廓来源：${EASTASIA_SOURCE.name}，DOI \`${EASTASIA_SOURCE.doi}\`，发布 ${EASTASIA_SOURCE.published}，影像判读 ${EASTASIA_SOURCE.interpretedAt}，成员 \`${EASTASIA_SOURCE.member}\`（${EASTASIA_SOURCE.memberCrs} 反算为 WGS84），归档 md5 \`${EASTASIA_SOURCE.archiveMd5}\`。
- 许可：${EASTASIA_SOURCE.license}。${EASTASIA_SOURCE.licenseGap}。
- 规则：面积 < ${MERGE_RULES.minAreaSquareMeters} m² 丢弃；质心相距 < ${MERGE_RULES.duplicateMeters} m 的重复保留较大轮廓；与既有 OSM 轮廓间距 ≤ ${MERGE_RULES.osmPrecedenceMeters} m 以 OSM 为准；轮廓顶点落入校园用地面内一律剔除。
- 身份：新增要素 \`osmId = eastasia/<序号>\`、\`sourceId = eastasia/gz-<归档记录号>[#p<多边形号>]\`，不写 OSM 链接；\`heightSource\` 恒为 \`estimate\`（${EASTASIA_SOURCE.noHeight}）；\`category\` 恒为 \`unknown\`，无名称与地址字段（${EASTASIA_SOURCE.noNaming}）。
- 检索索引：\`${indexFile}\` 的 ${indexed.length} 条楼名/地址条目全部仍指向 OSM 建筑，新增轮廓 0 条进入索引。

| 分档(m) | OSM 快照 | 本次新增 | 合并后 |
| --- | --- | --- | --- |
${rows}

近场 ${NEAR_FIELD_METERS} m 内新增 ${nearAdded} 栋；100 m 档由 ${payload.bands[0].osm} 栋变为 ${payload.bands[0].merged} 栋。

输入 ${result.stats.inputFeatures} 条记录 → ${result.stats.inputParts} 个多边形部分 → 采用 ${result.stats.kept} 栋。剔除计数：

${rejects}

新增轮廓占地：中位 ${payload.addedAreaSquareMeters.median} m²，合计 ${payload.addedAreaSquareMeters.sum.toLocaleString('zh-CN')} m²；100 m 档 ${payload.addedWithin100m.count} 栋，中位 ${payload.addedWithin100m.median} m²。

高度来源分布：OSM 快照 ${JSON.stringify(heightsOf(osmBase.features))} → 合并后 ${JSON.stringify(heightsOf(merged.features))}。

\`validateMergedJingtai\` 通过：OSM 部分逐字节未变，新增部分无 OSM 身份、无高度与命名声明、全部落在 ${radius} m 内且不在校园面内、无 < ${MERGE_RULES.duplicateMeters} m 的重复。耗时 ${elapsedMs} ms。
`;

await mkdir(new URL(outDir, root), { recursive: true });
await mkdir(dirname(fileURLToPath(new URL(reportPath, root))), { recursive: true });
await writeFile(new URL(`${outDir}jingtai-buildings.geojson`, root), `${JSON.stringify(merged)}\n`);
if (promote) {
  const metadata = await read(metadataPath);
  metadata.footprintMerge = {
    mergedAt: payload.generatedAt, source: EASTASIA_SOURCE, rules: payload.rules,
    counts: payload.counts, rejected: result.stats.rejected, bands: payload.bands, osmBase: payload.osmBase, inputs: payload.inputs,
    osmOnlyHeights: heightsOf(osmBase.features), servedHeights: heightsOf(merged.features),
    indexEntries: searchIndexFile.entries.length, indexFile,
    note: 'report.buildings 与 report.heights 只统计 OSM 快照；正式产物在此基础上并入影像推导轮廓，这些轮廓无用途、无名称与地址、只有 9.6 m 示意高度，且不进入楼名与地址检索。',
  };
  await writeFile(new URL(metadataPath, root), `${JSON.stringify(metadata, null, 2)}\n`);
} else {
  await writeFile(new URL(`${outDir}jingtai-footprints.json`, root), `${JSON.stringify(payload, null, 2)}\n`);
}
await writeFile(new URL(reportPath, root), report);
console.log(JSON.stringify({ writtenTo: outDir, report: reportPath, metadata: promote ? metadataPath : null, osmBase: osmBase.features.length, replacedFootprints, counts: payload.counts, bands: payload.bands, rejected: result.stats.rejected, servedHeights: heightsOf(merged.features) }, null, 2));
