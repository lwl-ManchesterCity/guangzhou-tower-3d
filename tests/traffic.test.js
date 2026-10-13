import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MARCH_PHASES, TAIL_PHASES, TRAFFIC_ARTERIALS, TRAFFIC_BAND, TRAFFIC_BAND_ALPHA, TRAFFIC_CLASSES, TRAFFIC_DASH,
  TRAFFIC_DOT_ALPHA, TRAFFIC_FLOW, TRAFFIC_GAP, TRAFFIC_HEADLIGHT, TRAFFIC_STEP_MS, TRAFFIC_TAIL, TRAFFIC_TAIL_ALPHA,
  TRAFFIC_TAIL_DASH, TRAFFIC_TAIL_GAP, TRAFFIC_TAILLIGHT, marchDash, marchPair, trafficFilter, trafficLayers,
} from '../src/traffic.js';

const period = TRAFFIC_DASH + TRAFFIC_GAP;
const tailPeriod = TRAFFIC_TAIL_DASH + TRAFFIC_TAIL_GAP;

// Where a dash array puts its lit stretches, read straight off the cumulative sums rather than sampled.
const onRuns = (dash, span) => {
  const total = dash.reduce((sum, value) => sum + value, 0);
  const out = [];
  for (let repeat = 0; repeat * total < span; repeat += 1) {
    for (let index = 0; index < dash.length; index += 2) {
      const start = repeat * total + dash.slice(0, index).reduce((sum, value) => sum + value, 0);
      if (start < span) out.push({ start, length: dash[index] });
    }
  }
  return out.sort((left, right) => left.start - right.start);
};

test('a march phase is the shipped pattern read from part way into it', () => {
  for (const shift of MARCH_PHASES) {
    const dash = marchDash(shift);
    assert.equal(dash.length % 2, 0, `phase ${shift} must emit whole dash/gap pairs, got ${dash}`);
    assert.ok(dash.every((value) => value > 0), `MapLibre drops a pattern with a zero or negative entry: ${dash}`);
    const runs = onRuns(dash, period * 8);
    // A dash array cannot start with a gap, so a phase that begins inside one buys the leading gap with a sliver of
    // light. MapLibre charges that for having no dash offset; it is a hundredth of a line width, and it is the only
    // short run the pattern is allowed to contain.
    const slivers = runs.filter((run) => run.length < 0.02);
    assert.ok(slivers.length <= runs.length - slivers.length / 2, `phase ${shift} is mostly slivers: ${dash}`);
    const lights = runs.filter((run) => run.length >= 0.02);
    for (const light of lights) {
      assert.ok(Math.abs(light.length - TRAFFIC_DASH) < 1e-9, `phase ${shift} shortens a light to ${light.length}`);
    }
    for (let index = 1; index < lights.length; index += 1) {
      assert.equal(Math.round(lights[index].start - lights[index - 1].start), period,
        `phase ${shift} changes the spacing between lights ${index - 1} and ${index}`);
    }
    const offset = ((lights[0].start - shift) % period + period) % period;
    assert.ok(offset < 0.011 || offset > period - 0.011,
      `phase ${shift} puts its first light at ${lights[0].start}, which is not ${shift} into the pattern`);
  }
  assert.notDeepEqual(marchDash(MARCH_PHASES[0]), marchDash(MARCH_PHASES[1]), 'the two phases are different frames');
  assert.deepEqual(marchDash(0), marchDash(period), 'a full period is the same frame, so the counter can wrap');
  assert.deepEqual(marchDash(-period / 2), marchDash(period / 2), 'walking backwards lands on the same light');
});

test('the filter keeps a road that has no brunnel key at all', () => {
  const filter = trafficFilter();
  assert.equal(filter[0], 'all');
  assert.ok(!JSON.stringify(filter).includes('"[!="'),
    '`!=` on a missing property is false, which leaves only elevated bridges lit');
  const brunnel = filter.find((clause) => JSON.stringify(clause).includes('brunnel'));
  assert.deepEqual(brunnel, ['match', ['get', 'brunnel'], 'tunnel', false, true],
    'an absent brunnel has to fall through to the lit side, and a tunnel has not');
});

test('only roads carry traffic, and the classes are the ones the tiles actually use', () => {
  assert.deepEqual(TRAFFIC_ARTERIALS.filter((name) => !TRAFFIC_CLASSES.includes(name)), [], 'the wide tier is a subset');
  for (const absent of ['path', 'pier', 'rail', 'transit', 'service', 'track']) {
    assert.ok(!TRAFFIC_CLASSES.includes(absent), `${absent} is not a road a car drives on`);
  }
  const filter = JSON.stringify(trafficFilter());
  for (const name of TRAFFIC_CLASSES) assert.ok(filter.includes(`"${name}"`), `${name} must survive the filter`);
  const [band, tail, flow] = trafficLayers();
  assert.deepEqual([band.id, tail.id, flow.id], [TRAFFIC_BAND, TRAFFIC_TAIL, TRAFFIC_FLOW],
    'the band is the road, the tail sits on it and the headlights sit on top of both');
  assert.deepEqual(band.filter, trafficFilter(), 'the static band lights every class the tiles call a road');
  assert.deepEqual(flow.filter, trafficFilter(true), 'only the stepped layer is held to the arteries');
  assert.deepEqual(tail.filter, trafficFilter(true), 'and so is the other one: a stepped layer over side streets re-tessellates the whole grid twice a second');
  assert.ok(!JSON.stringify(flow.filter).includes('minor'), 'a side street never re-tessellates twice a second');
});

test('the zoom ramp stays at the top of the width expression', () => {
  for (const layer of trafficLayers()) {
    assert.ok([TRAFFIC_BAND, TRAFFIC_TAIL, TRAFFIC_FLOW].includes(layer.id));
    assert.equal(layer.layout.visibility, 'none', 'the streets start dark; the night theme turns them on');
    assert.equal(layer.source, 'openmaptiles', 'the light rides the roads the basemap already drew');
    const width = layer.paint['line-width'];
    assert.equal(width[0], 'interpolate');
    assert.deepEqual(width[2], ['zoom'], "['zoom'] is only legal as the input of the top-level interpolate");
    const stops = width.slice(3);
    assert.equal(stops.length % 2, 0, 'every stop is a zoom and a value');
    for (const [index, stop] of stops.entries()) {
      if (index % 2 === 0) { assert.equal(typeof stop, 'number', 'zoom stops are numbers'); continue; }
      // ['match', ['get','class'], LABELS, arterial, street] - the split lives in the stop value, never around the ramp.
      assert.equal(stop[0], 'match', `zoom ${stops[index - 1]} must split arterial from street without nesting a ramp`);
      assert.deepEqual(stop[1], ['get', 'class']);
      assert.deepEqual(stop[2], TRAFFIC_ARTERIALS, 'the arterial labels are the real ones');
      assert.equal(typeof stop[3], 'number');
      assert.equal(typeof stop[4], 'number');
      assert.equal(stop.length, 5, 'one label group, then the value and the fallback');
      assert.ok(stop[3] > stop[4], `arterials are the wider tier at zoom ${stops[index - 1]}`);
    }
    assert.ok(JSON.stringify(layer.paint).match(/"line-opacity"/), 'both layers fade in with zoom, not on/off');
  }
});

test('the band carries the street and the dots stay small enough to be what is driving on it', () => {
  const [band, tail, flow] = trafficLayers();
  const opacity = (ramp) => ramp.slice(3).filter((_, index) => index % 2 === 1);
  const arterial = (ramp) => opacity(ramp).map((stop) => stop[3]);
  // The ribbon is the road: it has to be the widest thing on the street at every zoom, and it is capped at an alpha
  // where it reads as a glow rather than as a painted line. V7's band 5 pulls that ceiling down to 0.10, because a
  // ribbon at 0.15 measured brighter on screen than the lit windows it runs past.
  assert.ok(Math.max(...opacity(band.paint['line-opacity'])) <= 0.1,
    `the band sits at ${Math.max(...opacity(band.paint['line-opacity']))}: band 5 of the night budget caps it at 0.10`);
  const dots = arterial(flow.paint['line-width']);
  const ribbons = arterial(band.paint['line-width']);
  for (const [index, dot] of dots.entries()) {
    assert.ok(ribbons[index] > dot * 2, `zoom ${[12, 14, 16, 18][index]}: a ${ribbons[index]} ribbon under a ${dot} dot is not a band with traffic on it`);
  }
  // Measured against the widths this shipped with, which is where "等大小、偏粉的圆点串" came from.
  const shipped = [1, 2.4, 4.8, 8.2];
  for (const [index, dot] of dots.entries()) {
    const share = dot / shipped[index];
    assert.ok(share <= 0.7 && share >= 0.55, `zoom ${[12, 14, 16, 18][index]}: the dot is ${share} of the shipped ${shipped[index]}, the brief asks for 60-70 %`);
  }
  assert.deepEqual(arterial(tail.paint['line-width']), dots, 'a tail-light that arrived a different size to a headlight would be a second pattern, not a second light');
  // V7's night budget puts band 5 (the ribbons and the dots) *under* band 4 (the lit windows it runs past), which the
  // V5-6 band did not: measured at the opening camera a band at 0.15 reached luma 66 against 43 for the windows, and
  // under the squint test the streets were the third most visible thing in the frame. So the ceiling moved down - the
  // dots stay inside 0.18-0.27, which is where they still read as light rather than as a grey smear.
  for (const [name, stops] of [['headlight', opacity(flow.paint['line-opacity'])], ['taillight', opacity(tail.paint['line-opacity'])]]) {
    assert.ok(Math.max(...stops) <= 0.27 && Math.min(...stops) >= 0.18, `${name} runs ${JSON.stringify(stops)}, outside the 0.18-0.27 band 5 allows`);
  }
  assert.ok(opacity(tail.paint['line-opacity']).every((stop, index) => stop <= opacity(flow.paint['line-opacity'])[index]),
    'a tail-light may never out-shine the headlight it stands behind');
  // Warm white and red, never pink: pink is what an orange dash at 0.92 composites to over a blue-black ground, and it
  // is the read the brief is about.
  const rgb = (value) => [1, 3, 5].map((at) => parseInt(value.slice(at, at + 2), 16));
  const [hr, hg, hb] = rgb(TRAFFIC_HEADLIGHT);
  assert.ok(hr > hg && hg > hb && hb > 0x50, `headlight ${TRAFFIC_HEADLIGHT} is not a warm white: red over green over blue, with enough blue left to read as light`);
  const [tr, tg, tb] = rgb(TRAFFIC_TAILLIGHT);
  assert.ok(tr - tg > 120 && tr - tb > 150, `taillight ${TRAFFIC_TAILLIGHT} is not red`);
  // And the two lattices never realign: 36 against 13 is not a multiple, so a tail-light lands wherever the last one
  // did not, which is the only thing here that breaks the regular spacing directly.
  assert.notEqual(tailPeriod % period, 0, 'a multiple period would sit every tail-light in a headlight\'s shadow');
  const ratio = tailPeriod / period;
  assert.ok(ratio > 2.5 && ratio < 3.5, `one tail-light for every ${ratio.toFixed(2)} headlights, and the brief asks for 3`);
  const [first, second] = marchPair(1);
  assert.notDeepEqual(first, marchPair(0)[0], 'the headlights march');
  assert.notDeepEqual(second, marchPair(0)[1], 'and so do the tail-lights, on their own period');
});

test('the march respects the two steps a second the motion rules set for stepped properties', () => {
  assert.ok(1000 / TRAFFIC_STEP_MS <= 2, `${TRAFFIC_STEP_MS} ms is ${1000 / TRAFFIC_STEP_MS} steps a second`);
  assert.equal(MARCH_PHASES.length, 2, 'two frames, alternating');
  assert.deepEqual(MARCH_PHASES, [0, period / 2], 'half a period is the largest step that still reads as the same lights');
});
