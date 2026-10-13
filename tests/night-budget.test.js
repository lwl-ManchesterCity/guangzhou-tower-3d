import test from 'node:test';
import assert from 'node:assert/strict';
import { ATMOSPHERES } from '../src/atmosphere.js';
import { NIGHT_BANDS, bandOf, extrusionFloor, hexLuma, layerBands, predictedLuma } from '../src/night-budget.js';

const keys = NIGHT_BANDS.map((entry) => String(entry.band));

test('the budget table is the ten bands the brief names, plus the two rows the measurements forced', () => {
  assert.deepEqual(keys, ['1', '1.5', '2', '3', '4', '4b', '5', '6', '7', '8', '9', '10']);
  assert.equal(new Set(keys).size, keys.length, 'a band listed twice would be graded twice');
  // 1.5 and 4b are not in the document's table: the first is where V7 moved the two shafts, the second is the only
  // honest way to read "the lit windows" once a layer-attributed sample turns out to be mostly wall.
  assert.equal(bandOf('4b').sub, 4, 'the core row is a reading of band 4, not another set of layers');
  assert.equal(bandOf(1.5).label, '东西塔塔身主体');
});

test('every band carries a label, a usable range, and relations that point at bands that exist', () => {
  for (const entry of NIGHT_BANDS) {
    assert.ok(entry.label.length > 1, `band ${entry.band} has no name to print`);
    if (entry.range === null) {
      assert.deepEqual(entry.below, [], `band ${entry.band} is not graded, so it cannot rank against anything`);
      continue;
    }
    assert.equal(entry.range.length, 2, `band ${entry.band} needs both ends of its interval`);
    const [lo, hi] = entry.range;
    assert.ok(lo >= 0 && hi <= 255 && lo < hi, `band ${entry.band} range ${lo}~${hi} is not an interval of levels`);
    assert.ok(Array.isArray(entry.below), `band ${entry.band} needs its place in the hierarchy spelled out`);
    for (const target of entry.below) {
      assert.ok(bandOf(target), `band ${entry.band} claims to be darker than a band ${target} that is not in the table`);
      assert.notEqual(String(target), String(entry.band), `band ${entry.band} cannot be darker than itself`);
    }
  }
});

test('exactly the three bar-measured bands opt out of the gate, and no other band does', () => {
  // A band losing its range is a gate quietly going away, so the exception is a list rather than an absence.
  assert.deepEqual(NIGHT_BANDS.filter((entry) => entry.range === null).map((entry) => entry.band), [1, 2, 3]);
  assert.equal(NIGHT_BANDS.filter((entry) => entry.range).length, 9);
});

test('the darker-than relations do not contradict each other', () => {
  // "a below b" reads as a < b, so a cycle would make the table unsatisfiable and the meter would report a violation
  // no change can fix. Depth-first over the relation graph, one pass, no memo needed at this size.
  const walk = (band, trail) => {
    for (const target of bandOf(band).below) {
      if (trail.includes(String(target)))
        throw new Error(`${trail.join(' < ')} < ${target} closes a loop in the budget table`);
      walk(target, [...trail, String(target)]);
    }
  };
  for (const entry of NIGHT_BANDS) walk(entry.band, [String(entry.band)]);
  assert.ok(true);
});

test('the two dead standards the brief names are in the table, not only in prose', () => {
  // "塔身主体明度不得超过旁边普通楼的亮窗" and "绿地/水面不得比楼墙亮" are the two the document repeats.
  assert.ok(bandOf(1.5).below.includes('4b'), 'the shafts are no longer graded against the lit windows');
  for (const green of [9, 10]) assert.ok(bandOf(green).below.includes(7), `band ${green} is no longer graded against the walls`);
  // And the ordering the picture actually holds: the roads sit just above the walls, the traffic just under the windows.
  assert.ok(bandOf(7).below.includes(8), 'the road band is no longer above the wall band');
  assert.ok(bandOf(8).below.includes('4b'), 'the road is no longer graded under the lit windows');
  // The traffic is the one row the table deliberately does not rank: it is 52-57 at all three cameras and the lamp
  // cores are 51.9-68 depending on how far the windows are, so a per-camera ordering of the two is a property of the
  // camera. The brief lists 车流 among the three things that must survive the squint, so it is graded on its interval.
  assert.deepEqual(bandOf(5).below, [], 'the traffic has been given a ranking the brief does not ask for');
});

test('a rendered layer is claimed by exactly one band', () => {
  const map = layerBands();
  assert.ok(map.size >= 30, `only ${map.size} layers are bucketed, so a band has lost its sample points`);
  for (const layer of ['building-lights', 'building-glow', 'building-glow-breath-0', 'building-glow-breath-1',
    'traffic-band', 'bridge-parapets', 'neighborhood-buildings',
    'road_minor', 'park', 'landcover_wood', 'water', 'river-surface']) {
    assert.ok(map.has(layer), `${layer} is drawn in the night frame but buckets into nothing`);
  }
  assert.equal(map.get('building-glow'), 4, 'the halo layer is part of the window reading, not of its own band');
  // The two breathing halos are the same light on a seventh of the blocks: a band of their own would let the budget
  // be met by dimming them and would not be a reading of the frame.
  assert.equal(map.get('building-glow-breath-0'), 4, 'the breathing halo is graded with the windows it belongs to');
  assert.equal(map.get('building-glow-breath-1'), 4, 'and so is the other group\'s');
  assert.equal(map.get('river-surface'), 10, 'the sheen is the water band, which is what keeps V6-4 inside the budget');
});

test('the closed-form predictions are the ones that match the measured frames', () => {
  // Rec.709 on the hex itself, so a typo in the weights moves everything: #ffffff is 255 and #000000 is 0.
  assert.equal(hexLuma('#ffffff'), 255);
  assert.equal(hexLuma('#000000'), 0);
  assert.equal(hexLuma('#808080'), 128, 'the three weights sum to one, so grey is its own level');
  // The floor is the fact V7 measured: the same hex lands 1.55× brighter on a shell than on a wall.
  assert.equal(Math.round(1 / extrusionFloor() * 100) / 100, 1.61);
  const pick = (path) => path.split('.').reduce((value, part) => {
    assert.ok(value && part in value, `the budget names night.${path}, which the atmosphere no longer has`);
    return value[part];
  }, ATMOSPHERES.night);
  let gated = 0;
  for (const entry of NIGHT_BANDS) {
    for (const group of entry.sources ?? []) {
      assert.ok(['fill', 'extrusion'].includes(group.kind), `band ${entry.band} claims a ${group.kind} prediction`);
      for (const key of group.keys) {
        const got = predictedLuma(group.kind, pick(key));
        const [lo, hi] = entry.range;
        assert.ok(lo <= got && got <= hi,
          `night.${key} (${pick(key)}) lands at ${got}, outside band ${entry.band}'s ${lo}~${hi}`);
        gated++;
      }
    }
  }
  // The gate has to gate something: nine values is every flat fill and extruded wall the night palette names.
  assert.equal(gated, 9, 'the number of source-gated values moved, which is a change to what this test can catch');
});

test('a hex outside its band is what the gate is for', () => {
  // Not an assertion about the shipped palette - a proof that the check above can fail. The V7 brief's own worst case:
  // the water one step brighter than the walls it runs under.
  assert.ok(predictedLuma('fill', '#1a3d5c') > bandOf(10).range[1], 'a brighter river would still pass the gate');
  assert.ok(predictedLuma('extrusion', '#4a5f78') > bandOf(7).range[1], 'brighter walls would still pass the gate');
});
