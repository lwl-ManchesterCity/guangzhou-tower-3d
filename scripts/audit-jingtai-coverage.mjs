import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { SCENES } from '../src/scenes.js';
import { auditArtifact, assessAgainstReference, formatCoverageReport, COVERAGE_BANDS, NEAR_FIELD_METERS } from '../src/coverage-audit.js';

const root = new URL('../', import.meta.url);
const read = async (path) => JSON.parse(await readFile(new URL(path, root), 'utf8'));
const rawText = await readFile(new URL('data/jingtai-overpass.json', root), 'utf8');
const raw = JSON.parse(rawText);
const source = await read('data/jingtai-source.json');
if (source.sha256 !== createHash('sha256').update(rawText).digest('hex')) throw new Error('Raw snapshot checksum mismatch');

// The official snapshot now carries the second source, so the candidate row that used to shadow it is gone: an identical
// file audited twice would only double the column count, not the evidence.
const artifacts = { '正式快照（public/data，OSM＋东亚轮廓）': 'public/data/jingtai-buildings.geojson' };
if (existsSync(new URL('candidates/jingtai-p0/jingtai-buildings.geojson', root))) artifacts['候选版本（candidates/jingtai-p0，仅 OSM）'] = 'candidates/jingtai-p0/jingtai-buildings.geojson';
// One probe per artifact: the promoted snapshot has ids the P0 probe never saw, so sharing one render set would read as
// "these blocks exist but were never drawn" when they simply were not on screen when the other artifact was probed.
const renderFor = { '正式快照（public/data，OSM＋东亚轮廓）': 'docs/audits/jingtai-render-p1-live.json' };
const defaultRender = 'docs/audits/jingtai-render.json';
const renderProbe = {};
const renderEvidence = async (name, path) => {
  if (!existsSync(new URL(path, root))) return null;
  const file = await read(path);
  renderProbe[name] = { path, served: file.served ?? 'public/data/jingtai-buildings.geojson', capturedAt: file.capturedAt, cameras: file.cameras };
  return {
    ...file.cameras.near, layers: ['neighborhood-buildings', 'neighborhood-buildings-overview'],
    capturedAt: `${file.capturedAt} · ${file.app} · 渲染注入 ${renderProbe[name].served} · 1440×960 · ${path}`,
  };
};
const referencePath = 'docs/audits/jingtai-reference.json';
const reference = existsSync(new URL(referencePath, root)) ? await read(referencePath) : null;

const scene = SCENES.jingtai;
const audited = {};
for (const [name, path] of Object.entries(artifacts)) {
  const render = await renderEvidence(name, renderFor[name] ?? defaultRender);
  const file = await read(path);
  // Derived from the file itself, never typed in: the 原始要素 column cannot tell the two sources apart on its own.
  const added = file.features.filter((feature) => feature.properties.footprintSource).length;
  audited[name] = {
    path,
    note: added ? `产物列由两个来源组成：${file.features.length - added} 栋 OpenStreetMap 建筑（ODbL）＋${added} 个影像推导轮廓（Zenodo 8174931，CC BY 4.0，2023-04 成图，无高度、无名称与地址）。`
      + `原始要素、有效几何、转换缺失、半径剔除四列只统计 OSM 侧，所以产物栋数大于原始要素属第二来源，不表示 OSM 快照新增长度。` : null,
    audit: auditArtifact(raw, file, { center: scene.center, radius: scene.radius, bands: COVERAGE_BANDS, nearField: NEAR_FIELD_METERS, render }),
  };
}
const assessment = assessAgainstReference(reference, await read(artifacts['正式快照（public/data，OSM＋东亚轮廓）']), { center: scene.center });
const report = formatCoverageReport({ raw, source, artifacts: audited, reference: assessment });
if (process.argv.includes('--json')) console.log(JSON.stringify({ source: { sha256: source.sha256, endpoint: source.endpoint }, render: renderProbe, reference: assessment, artifacts: Object.fromEntries(Object.entries(audited).map(([name, value]) => [name, { path: value.path, ...value.audit }])) }, null, 2));
else {
  await writeFile(new URL('docs/audits/jingtai-coverage.md', root), report);
  console.log(report);
}
