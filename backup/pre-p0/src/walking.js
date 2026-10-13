import { distanceMeters } from './geo.js';

const forbidden = new Set(['no', 'private', 'use_sidepath']);
const affirmative = new Set(['yes', 'designated', 'permissive', 'official']);
const walkable = new Set(['footway', 'pedestrian', 'path', 'steps', 'living_street', 'residential', 'service', 'unclassified', 'tertiary', 'tertiary_link', 'secondary', 'secondary_link', 'primary', 'primary_link', 'road', 'track']);

// Specific pedestrian access takes precedence over general vehicle/access restrictions.
// Conditional access is deliberately not guessed by an offline, timeless snapshot.
export function footAccess(tags = {}, { node = false } = {}) {
  if (tags['foot:conditional'] || tags['access:conditional'] || tags['foot:forward:conditional'] || tags['foot:backward:conditional'] || tags['oneway:foot:conditional']) return false;
  if (tags.foot && !affirmative.has(tags.foot)) return false;
  if (!affirmative.has(tags.foot) && tags.access && !affirmative.has(tags.access)) return false;
  if (tags.highway === 'construction' || tags.highway === 'proposed' || tags.area === 'yes') return false;
  if (node) return !['wall', 'fence', 'retaining_wall', 'hedge', 'block'].includes(tags.barrier) || affirmative.has(tags.foot);
  return affirmative.has(tags.foot) || walkable.has(tags.highway);
}

export function footDirections(tags = {}) {
  const one = tags['oneway:foot'];
  return {
    forward: one !== '-1' && !forbidden.has(tags['foot:forward']),
    backward: !['yes', '1', 'true'].includes(one) && !forbidden.has(tags['foot:backward']),
  };
}

export function buildWalkingGraph(elements) {
  const nodes = new Map();
  const edges = new Map();
  const exclusions = [];
  const blocked = new Set(elements.filter((e) => e.type === 'node' && !footAccess(e.tags, { node: true })).map((e) => e.id));
  const addEdge = (from, to, wayId) => {
    if (!edges.has(from)) edges.set(from, []);
    edges.get(from).push({ to, wayId, distance: distanceMeters(nodes.get(from), nodes.get(to)) });
  };
  for (const way of elements) {
    if (way.type !== 'way' || !way.tags?.highway) continue;
    if (!footAccess(way.tags)) { exclusions.push({ id: `way/${way.id}`, reason: 'foot/access forbidden, conditional, non-walkable highway or area' }); continue; }
    if (!way.nodes || way.nodes.length !== way.geometry?.length) { exclusions.push({ id: `way/${way.id}`, reason: 'missing aligned node IDs and geometry' }); continue; }
    const directions = footDirections(way.tags);
    for (let i = 0; i < way.nodes.length; i++) {
      const point = way.geometry[i];
      if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lon)) continue;
      nodes.set(way.nodes[i], { lat: point.lat, lng: point.lon });
    }
    for (let i = 1; i < way.nodes.length; i++) {
      const a = way.nodes[i - 1], b = way.nodes[i];
      if (!nodes.has(a) || !nodes.has(b) || blocked.has(a) || blocked.has(b)) continue;
      if (directions.forward) addEdge(a, b, way.id);
      if (directions.backward) addEdge(b, a, way.id);
    }
  }
  const connected = new Set([...edges].flatMap(([from, links]) => [from, ...links.map((link) => link.to)]));
  for (const id of nodes.keys()) if (!connected.has(id)) nodes.delete(id);
  return { nodes, edges, exclusions, blocked };
}

class Heap {
  values = [];
  push(value) {
    let i = this.values.length;
    this.values.push(value);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.values[parent].distance <= value.distance) break;
      this.values[i] = this.values[parent]; i = parent;
    }
    this.values[i] = value;
  }
  pop() {
    const first = this.values[0], last = this.values.pop();
    if (this.values.length) {
      let i = 0;
      while (i * 2 + 1 < this.values.length) {
        let child = i * 2 + 1;
        if (child + 1 < this.values.length && this.values[child + 1].distance < this.values[child].distance) child++;
        if (last.distance <= this.values[child].distance) break;
        this.values[i] = this.values[child]; i = child;
      }
      this.values[i] = last;
    }
    return first;
  }
}

// No straight-line snapping, inferred intersections, or cross-component fallback.
export function shortestWalk(graph, originId, destinationIds) {
  if (!graph.nodes.has(originId)) return null;
  const targets = new Set(destinationIds);
  const costs = new Map([[originId, 0]]), previous = new Map(), queue = new Heap();
  queue.push({ id: originId, distance: 0 });
  while (queue.values.length) {
    const current = queue.pop();
    if (current.distance !== costs.get(current.id)) continue;
    if (targets.has(current.id)) {
      const nodeIds = [current.id], wayIds = [];
      let cursor = current.id;
      while (previous.has(cursor)) {
        const prev = previous.get(cursor);
        wayIds.push(prev.wayId); nodeIds.push(prev.from); cursor = prev.from;
      }
      nodeIds.reverse(); wayIds.reverse();
      return { distance: current.distance, nodeIds, wayIds, geometry: { type: 'LineString', coordinates: nodeIds.map((id) => { const p = graph.nodes.get(id); return [p.lng, p.lat]; }) } };
    }
    for (const edge of graph.edges.get(current.id) ?? []) {
      const next = current.distance + edge.distance;
      if (next >= (costs.get(edge.to) ?? Infinity)) continue;
      costs.set(edge.to, next); previous.set(edge.to, { from: current.id, wayId: edge.wayId });
      queue.push({ id: edge.to, distance: next });
    }
  }
  return null;
}

export function nearestGraphNodes(graph, point, maximumDistance = 30) {
  return [...graph.nodes].map(([id, coordinate]) => ({ id, ...coordinate, distance: distanceMeters(point, coordinate) }))
    .filter((candidate) => candidate.distance <= maximumDistance).sort((a, b) => a.distance - b.distance || a.id - b.id);
}
