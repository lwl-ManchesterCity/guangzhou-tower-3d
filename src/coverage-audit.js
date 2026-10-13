import { SCENES } from './scenes.js';
import { DEFAULT_BUILDING_HEIGHT } from './config.js';
import { distanceMeters } from './geo.js';
import { normalizeBuildings, distanceToGeometry, buildingHeight } from './buildings.js';
import { geometryFromElement } from './jingtai-data.js';

export const COVERAGE_BANDS = [100, 200, 300, 500, 1000, 2000];
export const NEAR_FIELD_METERS = 500;
export const GAP_CAUSES = ['not-in-source', 'lost-in-conversion', 'in-artifact-not-rendered', 'rendered-but-weak'];

const sourceId = (element) => `${element.type}/${element.id}`;
const featureKey = (feature) => feature.properties.sourceId ?? `way/${feature.id}`;
const outerRings = (geometry) => (geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates).map((rings) => rings[0]);
const vertexDistance = (center, geometry) => Math.min(...outerRings(geometry).flatMap((ring) => ring.map(([lng, lat]) => distanceMeters(center, { lat, lng }))));
const osmName = (element) => element.tags?.['name:zh'] || element.tags?.name || element.tags?.['name:en'] || '';

// Which step of the real pipeline dropped an element. Attribution calls the generator itself instead of restating its
// rules, so the audit cannot drift away from the code it audits.
function attribute(element, { center, radius, region }) {
  if (region > radius) return { cause: 'radius', detail: `最近边 ${Math.round(region)} m，半径 ${radius} m` };
  const { height, base } = buildingHeight(element.tags);
  if (element.tags.location === 'underground') return { cause: 'underground', detail: 'location=underground' };
  if (height <= base) return { cause: 'height-not-above-base', detail: `height ${height} / min_height ${base}` };
  if (Number(element.tags['building:levels']) < 0) return { cause: 'negative-levels', detail: `building:levels=${element.tags['building:levels']}` };
  if (element.type === 'relation') return null;
  if (normalizeBuildings([element], { center, radius, towerId: null }).features.length) return null;
  return { cause: 'rejected-by-rule', detail: JSON.stringify(element.tags) };
}

// One artifact against one raw snapshot: band counts, per-element cause, and the two stages only the browser can show.
export function auditArtifact(raw, artifact, options = {}) {
  const { center = SCENES.jingtai.center, radius = SCENES.jingtai.radius, bands = COVERAGE_BANDS, nearField = NEAR_FIELD_METERS, render = null } = options;
  const drawn = new Map((artifact?.features ?? []).map((feature) => [featureKey(feature), feature]));
  const rendered = render ? new Set(render.osmIds.map(String)) : null;
  const memberOfRelation = new Map();
  for (const relation of raw.elements.filter((e) => e.type === 'relation' && (e.tags?.building || e.tags?.['building:part']))) {
    for (const member of relation.members ?? []) if (member.type === 'way') memberOfRelation.set(member.ref, sourceId(relation));
  }
  const sources = [];
  for (const element of raw.elements) {
    if ((element.type !== 'way' && element.type !== 'relation') || !element.tags?.building && !element.tags?.['building:part']) continue;
    let geometry = null, geometryError = '';
    try { geometry = geometryFromElement(element); } catch (error) { geometryError = error.message; }
    const region = geometry ? distanceToGeometry(center, geometry) : null;
    const id = sourceId(element);
    const inArtifact = drawn.has(id);
    let cause = null;
    if (!inArtifact) {
      cause = geometryError ? { cause: 'invalid-geometry', detail: geometryError } : attribute(element, { center, radius, region });
      if (!cause) cause = memberOfRelation.has(element.id)
        ? { cause: 'merged-into-relation', detail: `并入 ${memberOfRelation.get(element.id)}，避免同一栋楼重复拉伸` }
        : { cause: 'conversion-gap', detail: '几何有效且单独通过生成规则，却不在产物中' };
    }
    sources.push({
      id, name: osmName(element), geometry: geometry?.type ?? null, regionDistance: region === null ? null : Math.round(region), regionExact: region,
      vertexDistance: geometry ? Math.round(vertexDistance(center, geometry)) : null, inArtifact, cause,
    });
  }
  const inBand = (band) => sources.filter((source) => source.regionDistance !== null && source.regionDistance <= band);
  const featuresInBand = (band) => [...drawn.values()].filter((feature) => distanceToGeometry(center, feature.geometry) <= band);
  const band = (limit) => {
    const within = inBand(limit), features = featuresInBand(limit);
    return {
      band: limit, sourceElements: within.length, validGeometry: within.filter((source) => source.geometry).length,
      artifactFeatures: features.length, estimatedHeight: features.filter((feature) => feature.properties.heightSource === 'estimate').length,
      lostInConversion: within.filter((source) => !source.inArtifact && source.cause.cause !== 'radius').length,
      radiusExcluded: within.filter((source) => !source.inArtifact && source.cause.cause === 'radius').length,
      // In the artifact but measured just outside the band: the artifact rings are rounded to 7 decimal degrees.
      rounding: within.filter((source) => source.inArtifact && distanceToGeometry(center, drawn.get(source.id).geometry) > limit).length,
      rendered: rendered ? features.filter((feature) => rendered.has(String(featureKey(feature)))).length : null,
    };
  };
  const near = inBand(nearField);
  const gaps = near.filter((source) => !source.inArtifact && source.cause.cause !== 'radius').map((source) => ({ ...source, stage: 'lost-in-conversion' }));
  const exclusions = {};
  // Only elements the scene actually claims to cover are auditable; a block 4 km away is not a coverage gap.
  for (const source of sources) if (!source.inArtifact && (source.regionExact === null || source.regionExact <= radius)) {
    (exclusions[source.cause.cause] ??= []).push({ id: source.id, name: source.name, regionDistance: source.regionDistance, vertexDistance: source.vertexDistance, detail: source.cause.detail });
  }
  const nearFeatures = featuresInBand(nearField);
  const notRendered = rendered ? nearFeatures.filter((feature) => !rendered.has(String(featureKey(feature))))
    .map((feature) => ({ id: featureKey(feature), name: feature.properties.name ?? '', regionDistance: Math.round(distanceToGeometry(center, feature.geometry)), stage: 'in-artifact-not-rendered' })) : null;
  const weak = nearFeatures.filter((feature) => feature.properties.heightSource === 'estimate')
    .map((feature) => ({ id: featureKey(feature), name: feature.properties.name ?? '', regionDistance: Math.round(distanceToGeometry(center, feature.geometry)), stage: 'rendered-but-weak', detail: `未知高度按 ${DEFAULT_BUILDING_HEIGHT} m 示意` }));
  return {
    bands: bands.map(band),
    boundaryRescued: sources.filter((source) => source.vertexDistance !== null && source.vertexDistance > radius && source.regionDistance <= radius)
      .map((source) => ({ id: source.id, name: source.name, regionDistance: source.regionDistance, vertexDistance: source.vertexDistance })),
    nearField: { meters: nearField, sourceElements: near.length, artifactFeatures: nearFeatures.length, artifactTotal: drawn.size, gaps, weak },
    lostInConversion: gaps,
    exclusions,
    inArtifactNotRendered: notRendered,
    renderStage: rendered ? { camera: render.camera ?? null, layers: render.layers ?? null, capturedAt: render.capturedAt ?? '' } : null,
  };
}

// Real-world completeness needs a source that is not the snapshot itself; OSM cannot certify its own coverage.
export function assessAgainstReference(reference, artifact, options = {}) {
  const { center = SCENES.jingtai.center, matchMeters = 25 } = options;
  if (!reference?.items?.length) {
    return { assessed: false, reason: `没有独立且具备合法使用权限的近场建筑核对清单，覆盖率尚不能评估；当前 OSM 快照不能自证完整，也不能把“原始来源不存在”当成“现实中没有楼”。`, items: [] };
  }
  const items = reference.items.map((item) => {
    const hit = (artifact?.features ?? []).map((feature) => ({ feature, distance: distanceToGeometry({ lat: item.lat, lng: item.lng }, feature.geometry) }))
      .sort((a, b) => a.distance - b.distance)[0];
    return { label: item.label ?? item.id, lat: item.lat, lng: item.lng, source: item.source ?? '', verifiedAt: item.verifiedAt ?? '', matched: Boolean(hit && hit.distance <= matchMeters), matchedId: hit && hit.distance <= matchMeters ? featureKey(hit.feature) : null, nearestMeters: hit ? Math.round(hit.distance) : null };
  });
  return { assessed: true, reference: reference.name ?? '', license: reference.license ?? '未记录', items, unmatched: items.filter((item) => !item.matched).map((item) => ({ ...item, stage: 'not-in-source' })) };
}

const row = (cells) => `| ${cells.join(' | ')} |\n`;
const percent = (part, total) => total ? `${Math.round(part * 100 / total)}%` : '—';

export function formatCoverageReport({ raw, source, artifacts, reference }) {
  const out = [];
  out.push('# 景泰小学近场建筑覆盖审计\n\n');
  out.push('本文件由 `node scripts/audit-jingtai-coverage.mjs` 生成，输入只有本地原始快照与产物，不发网络请求。\n\n');
  out.push(`- 原始快照：\`data/jingtai-overpass.json\`，SHA-256 \`${source?.sha256 ?? '未记录'}\`，OSM 时间戳 ${raw.osm3s?.timestamp_osm_base ?? '未记录'}。\n`);
  out.push(`- 中心：${SCENES.jingtai.center.lat}, ${SCENES.jingtai.center.lng}；半径 ${SCENES.jingtai.radius} m；近场阈值 ${NEAR_FIELD_METERS} m。\n`);
  out.push(`- 判定规则：建筑入图条件为几何与中心圆相交，即 \`distanceToGeometry(center, geometry) <= radius\`，100 m 一档的分区统计用同一条规则。\n\n`);
  for (const [name, artifact] of Object.entries(artifacts)) {
    const audit = artifact.audit;
    out.push(`## ${name}\n\n产物 \`jingtai-buildings.geojson\` 共 ${audit.nearField.artifactTotal} 栋（2 公里内），近场 ${audit.nearField.meters} m 内产物 ${audit.nearField.artifactFeatures} 栋、原始来源 ${audit.nearField.sourceElements} 处、转换缺失 ${audit.lostInConversion.length} 处。\n\n`);
    // The 原始要素 column only ever counts OSM elements, so a merged artifact needs its second source spelled out here
    // or the row reads as coverage the OSM snapshot gained.
    if (artifact.note) out.push(`${artifact.note}\n\n`);
    out.push(row(['分区(m)', '原始要素', '有效几何', '产物栋数', '转换缺失', '半径剔除', '示意高度', '示意占比', '同镜头已渲染']));
    out.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n');
    for (const band of audit.bands) out.push(row([band.band, band.sourceElements, band.validGeometry, band.artifactFeatures, band.lostInConversion, band.radiusExcluded, band.estimatedHeight, percent(band.estimatedHeight, band.artifactFeatures), band.rendered ?? '未探测']));
    const rounded = audit.bands.filter((band) => band.rounding).map((band) => `${band.band} m 档 ${band.rounding} 栋`);
    if (rounded.length) out.push(`\n注：产物列小于原始要素列而转换缺失为 0 的分区，差值是产物环坐标已四舍五入到 7 位小数、按产物几何重算时刚好越过分界线：${rounded.join('、')}；这些楼仍在产物内。\n`);
    out.push('\n边界规则差异（顶点判定会漏、几何相交判定会收）：' + (audit.boundaryRescued.length ? `${audit.boundaryRescued.length} 处\n\n` : '0 处；本数据集里半径边界不是近场缺楼的原因。\n\n'));
    for (const item of audit.boundaryRescued) out.push(`- \`${item.id}\` ${item.name || '（未命名）'}：最近边 ${item.regionDistance} m，最近顶点 ${item.vertexDistance} m。\n`);
    out.push(`\n近场 ${audit.nearField.meters} m 内缺失清单：\n\n`);
    if (!audit.nearField.sourceElements) out.push(`- 原始快照在近场 ${audit.nearField.meters} m 内没有任何建筑要素，因此这一层不存在可归因的“转换丢失”；缺口发生在数据源之前，属 P1 待补范围，不代表现实中没有楼。\n`);
    else if (!audit.lostInConversion.length) out.push(`- 近场 ${audit.nearField.sourceElements} 处原始建筑要素全部进入产物，本层无转换丢失。\n`);
    for (const gap of audit.lostInConversion) out.push(`- \`${gap.id}\` ${gap.name || '（未命名）'}：最近边 ${gap.regionDistance} m／最近顶点 ${gap.vertexDistance} m，判定 \`${gap.cause.cause}\`，证据 ${gap.cause.detail}。\n`);
    out.push(`\n近场已入图但只有示意高度的建筑（已显示但视觉辨识不足）：${audit.nearField.weak.length} 栋。\n\n`);
    for (const weak of audit.nearField.weak.slice(0, 12)) out.push(`- \`${weak.id}\` ${weak.name || '（未命名）'}：最近边 ${weak.regionDistance} m，${weak.detail}。\n`);
    if (audit.nearField.weak.length > 12) out.push(`- 其余 ${audit.nearField.weak.length - 12} 栋同类，明细见 \`scripts/audit-jingtai-coverage.mjs --json\`。\n`);
    if (audit.renderStage) out.push(`\n产物存在但未渲染：${audit.inArtifactNotRendered.length} 栋；渲染证据来自 ${audit.renderStage.capturedAt ?? '浏览器探测'}。\n`);
    for (const item of (audit.inArtifactNotRendered ?? []).slice(0, 12)) out.push(`- \`${item.id}\` ${item.name || '（未命名）'}：最近边 ${item.regionDistance} m。\n`);
    out.push(`\n2 公里内原始要素未入图的判定分布：\n\n`);
    out.push(row(['判定', '数量', '证据']));
    out.push('| --- | --- | --- |\n');
    const causes = Object.entries(audit.exclusions).sort((a, b) => b[1].length - a[1].length);
    if (!causes.length) out.push(row(['—', 0, '原始建筑要素全部进入产物']));
    for (const [cause, items] of causes) out.push(row([`\`${cause}\``, items.length, items.slice(0, 3).map((item) => `\`${item.id}\` ${item.name || '（未命名）'}：${item.detail}`).join('；')]));
    out.push('\n');
  }
  out.push('## 覆盖率结论\n\n');
  out.push(`- ${reference.assessed ? `已按独立清单核对 ${reference.items.length} 项，未匹配 ${reference.unmatched.length} 项（清单：${reference.reference}，许可：${reference.license}）。` : `**${reference.reason}** 核对清单放入 \`docs/audits/jingtai-reference.json\`（每项含位置、来源、核验日期、许可）后，本审计会自动逐项比对。`}\n`);
  out.push('- 四类归因含义：`原始来源不存在`需外部合法资料核对；`原始存在但转换丢失`由上表逐条给出判定；`产物存在但未显示`需同镜头渲染证据；`已显示但视觉辨识不足`指未知高度按 ' + DEFAULT_BUILDING_HEIGHT + ' m 平面块绘制。\n');
  out.push('- 不能以要素总数、测试通过率或本审计中“原始要素为 0”推断现实中没有建筑。\n');
  out.push('- 渲染列只统计探测镜头内可判定的栋数；镜头外或地平线外的建筑记为“无法判定”，不算缺失。\n');
  return out.join('');
}
