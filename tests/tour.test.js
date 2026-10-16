import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import * as tourModule from '../src/tour.js';
import { DEFAULT_CENTER, RADIUS_METERS, TOWER_OSM_ID } from '../src/config.js';
import { distanceMeters } from '../src/geo.js';
import { LANDMARKS } from '../src/landmarks.js';

const DWELL = 7000; // Deliberately independent of the implementation's exported delay.
const localIndex = JSON.parse(readFileSync(new URL('../public/data/canton-buildings-index.json', import.meta.url), 'utf8'));

// The two bridge files the scene draws: a stop standing on a deck has to name one of their rows, not a coordinate
// someone typed. 100 m is the ceiling for "this stop is on the element it names": the closest two elements any two
// stops name are the library and the museum 165 m apart, so a stop that lands on its neighbour's anchor fails here.
const STOP_ANCHOR_TOLERANCE = 100;
const bridgeParts = JSON.parse(readFileSync(new URL('../public/data/canton-bridges.geojson', import.meta.url), 'utf8')).features;
const haixinBridge = JSON.parse(readFileSync(new URL('../public/data/haixin-bridge.geojson', import.meta.url), 'utf8')).features;

const bboxCentre = (features) => {
  const points = features.flatMap((feature) => feature.geometry.coordinates[0] ?? feature.geometry.coordinates);
  const lngs = points.map(([lng]) => lng), lats = points.map(([, lat]) => lat);
  return [(Math.min(...lngs) + Math.max(...lngs)) / 2, (Math.min(...lats) + Math.max(...lats)) / 2];
};

// Where each element the scene ships says it is. The landmark table wins over the building index because that is the
// row the nameplate, the card and 飞过去 read, and a stop is a camera pointed at exactly that building.
const shippedAnchors = new Map();
for (const entry of localIndex.entries) shippedAnchors.set(entry.osmId, { source: 'canton-buildings-index.json', centre: [entry.lng, entry.lat] });
for (const feature of haixinBridge) shippedAnchors.set(feature.properties.osmId, { source: 'haixin-bridge.geojson', centre: bboxCentre([feature]) });
for (const osmId of new Set(bridgeParts.map((feature) => feature.properties.osmId))) {
  shippedAnchors.set(osmId, { source: 'canton-bridges.geojson', centre: bboxCentre(bridgeParts.filter((feature) => feature.properties.osmId === osmId)) });
}
for (const landmark of LANDMARKS) shippedAnchors.set(landmark.osmId, { source: 'src/landmarks.js', centre: landmark.center });

class MapStub extends EventEmitter {
  flights = [];
  stops = [];
  moving = false;

  flyTo(options) {
    this.flights.push(options);
    this.moving = true;
    return this;
  }

  stop() {
    this.stops.push({ moving: this.moving, listeners: this.listenerCount('moveend') });
    // MapLibre can emit moveend synchronously while stopping an interrupted flight.
    if (this.moving) {
      this.moving = false;
      this.emit('moveend', { target: this, stopped: true });
    }
    return this;
  }

  arrive() {
    assert.equal(this.moving, true, 'arrival requires a pending flight');
    this.moving = false;
    this.emit('moveend', { target: this });
  }
}

function fixture(t, implementation) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = new Set();
  const fakeSetTimeout = globalThis.setTimeout;
  const fakeClearTimeout = globalThis.clearTimeout;
  const timeout = t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    const id = fakeSetTimeout(() => {
      pending.delete(id);
      callback(...args);
    }, delay);
    pending.add(id);
    return id;
  });
  t.mock.method(globalThis, 'clearTimeout', (id) => {
    pending.delete(id);
    return fakeClearTimeout(id);
  });
  const map = new MapStub();
  const states = [], cameraInputs = [], cameraOutputs = [];
  let padding = 24;
  const tour = implementation.createTour(map, {
    camera(stop) {
      cameraInputs.push(stop);
      const options = { center: [...stop.center], zoom: stop.zoom, pitch: stop.pitch, bearing: stop.bearing, padding, duration: 2300 };
      cameraOutputs.push(options);
      return options;
    },
    onChange(state) { states.push({ ...state }); },
  });
  t.after(() => map.removeAllListeners()); // Node restores each test's mocked functions and clock.
  return {
    tour, map, states, cameraInputs, cameraOutputs, pending, timeout,
    tick: (ms) => t.mock.timers.tick(ms),
    setPadding: (value) => { padding = value; },
  };
}

function state(f, index, playing, travelling) {
  assert.deepEqual(f.states.at(-1), { index, playing, travelling });
  assert.equal(f.tour.active, index >= 0);
}

function quiet(f, ms = DWELL * 10) {
  const before = { states: [...f.states], flights: [...f.map.flights], stops: [...f.map.stops] };
  const listeners = f.map.listenerCount('moveend');
  const timers = f.pending.size;
  f.tick(ms);
  assert.deepEqual({ states: f.states, flights: f.map.flights, stops: f.map.stops }, before, 'no unsolicited transition');
  assert.equal(f.map.listenerCount('moveend'), listeners);
  assert.equal(f.pending.size, timers);
}

function cancelledBeforeStop(f) {
  assert.ok(f.map.stops.length > 0);
  assert.ok(f.map.stops.every((stop) => stop.listeners === 0), 'remove the old moveend listener before map.stop()');
}

function dwellThenNext(f, index) {
  assert.equal(f.pending.size, 1, 'exactly one dwell timer');
  quiet(f, DWELL - 1);
  f.tick(1);
  state(f, index, true, true);
  assert.equal(f.pending.size, 0);
  assert.equal(f.map.listenerCount('moveend'), 1);
}

const behaviors = {
  stops(t, implementation) {
    const { TOUR_STOPS: stops, TOUR_DWELL_MS } = implementation;
    assert.equal(TOUR_DWELL_MS, DWELL);
    assert.equal(stops.length, 8);
    assert.deepEqual(stops.map(({ name, bank, osmId }) => ({ name, bank, osmId })), [
      { name: '广州塔', bank: '南岸', osmId: TOWER_OSM_ID },
      { name: '海心桥', bank: '江上', osmId: 1313608038 },
      { name: '花城广场', bank: '北岸', osmId: 243319596 },
      { name: '广州图书馆', bank: '北岸', osmId: 240896441 },
      { name: '广东省博物馆', bank: '北岸', osmId: 240896442 },
      { name: '广州西塔', bank: '北岸', osmId: 184738716 },
      { name: '广州东塔', bank: '北岸', osmId: 511404889 },
      { name: '猎德大桥', bank: '江上', osmId: 233809684 },
    ]);
    assert.equal(new Set(stops.map((stop) => stop.name)).size, stops.length, '站名不许重复');
    assert.equal(new Set(stops.map((stop) => stop.osmId)).size, stops.length, '同一栋楼不许站两次');
    for (const stop of stops) {
      assert.equal(stop.center.length, 2);
      const [lng, lat] = stop.center;
      assert.ok(Number.isFinite(lng) && Number.isFinite(lat));
      assert.ok(distanceMeters(DEFAULT_CENTER, { lng, lat }) <= RADIUS_METERS, `${stop.name} must be inside the local scene`);
      assert.ok(stop.description.trim().length > 0);
      assert.ok(stop.zoom >= 10 && stop.zoom <= 18.5);
      assert.ok(stop.pitch >= 0 && stop.pitch <= 70);
      assert.ok(Number.isFinite(stop.bearing));
      // 每一站都得点名一份仓库真发布过的要素，而且落在它自己身上：落点漂到邻站那栋楼上，这里必须当场红。
      const anchor = shippedAnchors.get(stop.osmId);
      assert.ok(anchor, `${stop.name} 的 osmId ${stop.osmId} 在仓库数据里点不到名字`);
      const gap = distanceMeters({ lng: anchor.centre[0], lat: anchor.centre[1] }, { lng, lat });
      assert.ok(gap <= STOP_ANCHOR_TOLERANCE, `${stop.name} 离它点名的 ${anchor.source} 那一格 ${gap.toFixed(1)} m，超过 ${STOP_ANCHOR_TOLERANCE} m`);
    }
    // 旧四站的值照旧冻结，连相机角度与措辞一起。
    assert.deepEqual(stops[0].center, [DEFAULT_CENTER.lng, DEFAULT_CENTER.lat]);
    assert.deepEqual(stops[1].center, [113.314334, 23.1110888]);
    assert.deepEqual(stops[2].center, [113.319181, 23.122579]);
    const libraries = localIndex.entries.filter((entry) => entry.osmId === stops[3].osmId);
    assert.equal(libraries.length, 1, 'the library must resolve to one shipped index entry');
    assert.equal(libraries[0].name, stops[3].name);
    assert.deepEqual(stops[3].center, [libraries[0].lng, libraries[0].lat], 'use the actual library anchor, not its nearby plaza');
    // 新四站与地标表逐位读同一个落点：这是"同一张表"那一条，手打一个数就会断。
    const linked = stops.filter((stop) => LANDMARKS.some((landmark) => landmark.osmId === stop.osmId));
    assert.equal(linked.length, 7, '除图书馆外的七站都该有地标行');
    for (const stop of linked) {
      const landmark = LANDMARKS.find((entry) => entry.osmId === stop.osmId);
      assert.deepEqual(stop.center, landmark.center, `${stop.name} 的落点必须与地标表逐位相同`);
      assert.ok(landmark.name.includes(stop.name), `${stop.name} 必须就是地标表那一栋的名字（表里写作 ${landmark.name}）`);
    }
  },

  inactive(t, implementation) {
    const f = fixture(t, implementation);
    assert.equal(f.tour.active, false);
    f.tour.exit();
    f.tour.exit();
    f.tour.step(1);
    f.tour.step(-1);
    f.tour.toggle();
    f.tour.reframe();
    assert.deepEqual(f.states, []);
    assert.deepEqual(f.map.flights, []);
    assert.deepEqual(f.map.stops, []);
    assert.equal(f.pending.size, 0);
    assert.equal(f.map.listenerCount('moveend'), 0);
    quiet(f);
  },

  arrival(t, implementation) {
    const f = fixture(t, implementation);
    f.tour.start();
    state(f, 0, true, true);
    assert.equal(f.map.listenerCount('moveend'), 1);
    assert.equal(f.pending.size, 0);
    assert.equal(f.timeout.mock.callCount(), 0, 'never arm dwell during the flight');
    assert.strictEqual(f.cameraInputs[0], implementation.TOUR_STOPS[0]);
    assert.strictEqual(f.map.flights[0], f.cameraOutputs[0], 'pass the injected camera result through unchanged');
    quiet(f);
    f.map.arrive();
    state(f, 0, true, false);
    assert.equal(f.map.listenerCount('moveend'), 0);
    assert.equal(f.timeout.mock.callCount(), 1);
    assert.equal(f.timeout.mock.calls[0].arguments[1], DWELL);
    dwellThenNext(f, 1);
    quiet(f); // Even a very long second flight must not skip its stop.
    assert.equal(f.map.flights.length, 2);
  },

  complete(t, implementation) {
    const f = fixture(t, implementation);
    const count = implementation.TOUR_STOPS.length;
    f.tour.start();
    const expectedStates = [];
    for (let index = 0; index < count; index++) {
      state(f, index, true, true);
      expectedStates.push({ index, playing: true, travelling: true });
      assert.strictEqual(f.cameraInputs[index], implementation.TOUR_STOPS[index]);
      quiet(f, DWELL * 2);
      f.map.arrive();
      state(f, index, true, false);
      expectedStates.push({ index, playing: true, travelling: false });
      assert.equal(f.pending.size, 1);
      quiet(f, DWELL - 1);
      f.tick(1);
    }
    expectedStates.push({ index: -1, playing: false, travelling: false });
    assert.deepEqual(f.states, expectedStates);
    state(f, -1, false, false);
    assert.equal(f.map.flights.length, count, 'do not wrap to the tower after the last stop');
    assert.equal(f.pending.size, 0);
    assert.equal(f.map.listenerCount('moveend'), 0);
    quiet(f);
  },

  pauseTravelling(t, implementation) {
    const f = fixture(t, implementation);
    f.tour.start();
    f.tick(2300);
    f.tour.toggle();
    state(f, 0, false, true); // Pausing is not an arrival.
    assert.equal(f.map.moving, false);
    assert.equal(f.map.listenerCount('moveend'), 0);
    assert.equal(f.pending.size, 0);
    assert.equal(f.timeout.mock.callCount(), 0);
    assert.equal(f.states.length, 2, 'stop must not publish a spurious arrival');
    cancelledBeforeStop(f);
    f.map.emit('moveend');
    assert.equal(f.states.length, 2);
    quiet(f);
    f.tour.toggle();
    state(f, 0, true, true);
    assert.deepEqual(f.cameraInputs, [implementation.TOUR_STOPS[0], implementation.TOUR_STOPS[0]]);
    assert.equal(f.map.listenerCount('moveend'), 1);
    quiet(f);
    f.map.arrive();
    dwellThenNext(f, 1);
  },

  pauseArrived(t, implementation) {
    const f = fixture(t, implementation);
    f.tour.start();
    f.map.arrive();
    f.tick(2600);
    f.tour.toggle();
    state(f, 0, false, false);
    assert.equal(f.pending.size, 0);
    assert.equal(f.map.listenerCount('moveend'), 0);
    quiet(f);
    for (let repeat = 0; repeat < 3; repeat++) {
      f.tour.toggle();
      state(f, 0, true, false);
      assert.equal(f.map.flights.length, 1, 'resume at an arrived stop without a second flight');
      assert.equal(f.pending.size, 1);
      if (repeat < 2) {
        f.tick(1000);
        f.tour.toggle();
        state(f, 0, false, false);
        assert.equal(f.pending.size, 0);
        quiet(f);
      }
    }
    dwellThenNext(f, 1); // Resume grants a full dwell, not the previous remainder.
  },

  navigation(t, implementation) {
    const count = implementation.TOUR_STOPS.length;
    const f = fixture(t, implementation);
    f.tour.start();
    f.tour.step(-1);
    assert.equal(f.map.flights.length, 1);
    assert.equal(f.states.length, 1);
    let index = 0;
    for (const delta of [1, 1, -1, -1, 2, 1]) {
      index += delta;
      f.tour.step(delta);
      state(f, index, true, true);
      assert.strictEqual(f.cameraInputs.at(-1), implementation.TOUR_STOPS[index]);
      assert.equal(f.map.listenerCount('moveend'), 1);
      assert.equal(f.pending.size, 0);
    }
    assert.equal(f.states.length, 7, 'interrupting flights must not publish arrivals');
    // 一直往前走到最后一站，再往外走一步必须退出，不许回卷到塔。
    while (index < count - 1) {
      index += 1;
      f.tour.step(1);
      state(f, index, true, true);
      assert.strictEqual(f.cameraInputs.at(-1), implementation.TOUR_STOPS[index]);
    }
    cancelledBeforeStop(f);
    assert.equal(f.timeout.mock.callCount(), 0, 'stop-triggered moveend must not arm a timer for the cancelled stop');
    f.tour.step(1);
    state(f, -1, false, false);
    assert.equal(f.map.flights.length, count + 3);
    assert.equal(f.map.listenerCount('moveend'), 0);
    assert.equal(f.pending.size, 0);
    f.tour.step(-1);
    state(f, -1, false, false);
    quiet(f);
  },

  rapidSteps(t, implementation) {
    const f = fixture(t, implementation);
    f.tour.start();
    f.map.arrive();
    f.tick(DWELL - 100);
    for (const [delta, index] of [[1, 1], [1, 2], [-1, 1], [1, 2], [-1, 1]]) {
      f.tour.step(delta);
      state(f, index, true, true);
      assert.equal(f.map.listenerCount('moveend'), 1);
      assert.equal(f.pending.size, 0, 'manual navigation cancels the previous dwell');
    }
    cancelledBeforeStop(f);
    quiet(f); // Cross both the old dwell deadline and any accidental replacement deadlines.
    f.map.arrive();
    state(f, 1, true, false);
    assert.equal(f.pending.size, 1);
    const changes = f.states.length;
    const scheduled = f.timeout.mock.callCount();
    f.tick(3500);
    f.map.emit('moveend');
    f.map.emit('moveend');
    assert.equal(f.states.length, changes, 'arrival is a one-shot event');
    assert.equal(f.timeout.mock.callCount(), scheduled, 'duplicate moveend must not reset or duplicate dwell');
    assert.equal(f.map.listenerCount('moveend'), 0);
    quiet(f, 3499);
    f.tick(1);
    state(f, 2, true, true);
    assert.equal(f.map.flights.length, 7, 'one automatic advance after all rapid manual clicks');
    quiet(f);
  },

  exitTravelling(t, implementation) {
    const f = fixture(t, implementation);
    f.tour.start();
    f.tour.exit();
    state(f, -1, false, false);
    assert.deepEqual(f.states, [
      { index: 0, playing: true, travelling: true },
      { index: -1, playing: false, travelling: false },
    ]);
    assert.equal(f.map.moving, false);
    assert.equal(f.map.listenerCount('moveend'), 0);
    assert.equal(f.pending.size, 0);
    cancelledBeforeStop(f);
    f.map.emit('moveend');
    f.tour.exit();
    assert.equal(f.states.length, 2);
    assert.equal(f.map.stops.length, 2, 'exit is idempotent');
    quiet(f);
    f.tour.start();
    state(f, 0, true, true);
    assert.equal(f.map.listenerCount('moveend'), 1);
    quiet(f);
    f.map.arrive();
    dwellThenNext(f, 1);
  },

  exitArrived(t, implementation) {
    const f = fixture(t, implementation);
    f.tour.start();
    f.map.arrive();
    f.tick(DWELL - 100);
    f.tour.exit();
    state(f, -1, false, false);
    assert.equal(f.pending.size, 0);
    assert.equal(f.map.listenerCount('moveend'), 0);
    quiet(f);
    f.tour.start();
    f.map.arrive();
    dwellThenNext(f, 1);
  },

  restart(t, implementation) {
    const f = fixture(t, implementation);
    f.tour.start();
    f.tour.step(2);
    for (let repeat = 0; repeat < 3; repeat++) {
      f.tour.start();
      state(f, 0, true, true);
      assert.equal(f.map.listenerCount('moveend'), 1);
      assert.equal(f.pending.size, 0);
    }
    assert.equal(f.states.length, 5);
    assert.equal(f.timeout.mock.callCount(), 0);
    cancelledBeforeStop(f);
    f.map.arrive();
    f.tick(DWELL - 100);
    f.tour.start(); // Starting again must also cancel an already-running dwell.
    state(f, 0, true, true);
    assert.equal(f.pending.size, 0);
    assert.equal(f.map.listenerCount('moveend'), 1);
    quiet(f);
    f.map.arrive();
    dwellThenNext(f, 1);
  },

  reframeTravelling(t, implementation) {
    const f = fixture(t, implementation);
    f.tour.start();
    f.tour.step(1);
    f.tick(3000);
    f.setPadding(180);
    f.tour.reframe();
    state(f, 1, true, true);
    assert.equal(f.states.length, 3, 'reframing an interrupted flight is not an arrival');
    assert.deepEqual(f.cameraInputs, [implementation.TOUR_STOPS[0], implementation.TOUR_STOPS[1], implementation.TOUR_STOPS[1]]);
    assert.equal(f.map.flights.at(-1).padding, 180, 'recompute camera framing for the current viewport');
    assert.strictEqual(f.map.flights.at(-1), f.cameraOutputs.at(-1));
    assert.equal(f.map.listenerCount('moveend'), 1);
    assert.equal(f.pending.size, 0);
    cancelledBeforeStop(f);
    quiet(f);
    f.map.arrive();
    dwellThenNext(f, 2);
  },

  reframeArrived(t, implementation) {
    const f = fixture(t, implementation);
    f.tour.start();
    f.map.arrive();
    f.tick(DWELL - 100);
    f.tour.reframe();
    state(f, 0, true, true);
    assert.equal(f.map.flights.length, 2);
    assert.equal(f.pending.size, 0);
    assert.equal(f.map.listenerCount('moveend'), 1);
    quiet(f);
    f.map.arrive();
    dwellThenNext(f, 1);
  },

  manual(t, implementation) {
    const f = fixture(t, implementation);
    f.tour.start(false);
    state(f, 0, false, true);
    quiet(f);
    f.map.arrive();
    state(f, 0, false, false);
    quiet(f);
    f.setPadding(120);
    f.tour.reframe();
    state(f, 0, false, true);
    assert.equal(f.map.flights.at(-1).padding, 120);
    f.map.arrive();
    state(f, 0, false, false);
    quiet(f);
    for (let index = 1; index < implementation.TOUR_STOPS.length; index++) {
      f.tour.step(1);
      state(f, index, false, true);
      quiet(f);
      f.map.arrive();
      state(f, index, false, false);
      assert.equal(f.pending.size, 0);
      assert.equal(f.map.listenerCount('moveend'), 0);
      quiet(f);
    }
    assert.equal(f.map.flights.length, implementation.TOUR_STOPS.length + 1);
    assert.equal(f.timeout.mock.callCount(), 0, 'manual visits, including the last stop, never schedule autoplay');
    f.tour.step(1);
    state(f, -1, false, false);
    quiet(f);
  },
};

const cases = [
  ['stops', 'all eight real stops keep their order, local radius, shipped anchors and indexed library anchor'],
  ['inactive', 'inactive controls are harmless and active starts false'],
  ['arrival', 'a flight does not consume dwell; moveend starts exactly 7000 ms'],
  ['complete', 'autoplay visits all eight stops once and exits after the final full dwell'],
  ['pauseTravelling', 'pause preserves travelling and resume flies to the same stop'],
  ['pauseArrived', 'pause cancels dwell; repeated resumes grant one full dwell without reflying'],
  ['navigation', 'previous/next obey boundaries and cancel listeners before stopping flights'],
  ['rapidSteps', 'rapid manual steps and duplicate moveend events cannot multiply advances'],
  ['exitTravelling', 'exit during a flight removes listeners, stops safely and permits clean restart'],
  ['exitArrived', 'exit during dwell cancels its timer before a fresh run'],
  ['restart', 'repeated start replaces both in-flight listeners and arrived dwell timers'],
  ['reframeTravelling', 'reframe recomputes the same in-flight stop without a false arrival'],
  ['reframeArrived', 'reframe cancels existing dwell and waits for the new arrival'],
  ['manual', 'autoplay=false remains manual through arrival, reframe and every stop'],
];

for (const [key, title] of cases) test(title, (t) => behaviors[key](t, tourModule));

// Mutants run the exact same behavioral assertions against data-URL modules.
// No source file, isolated copy, or temporary artifact is written to disk.
const mutations = [
  ['stop order', 'stops', '];\n\nexport const TOUR_DWELL_MS', '].reverse();\n\nexport const TOUR_DWELL_MS'],
  ['out-of-radius coordinate', 'stops', '[113.314334, 23.1110888]', '[114.314334, 23.1110888]'],
  ['wrong library anchor', 'stops', '[113.3206608, 23.1189093]', '[113.319181, 23.122579]'],
  ['stop names an element the repository does not ship', 'stops', 'osmId: 511404889', 'osmId: 1'],
  ['stop lands off its own element', 'stops', '[113.320579, 23.12026]', '[113.3214187, 23.1174173]'],
  ['stop centre drifts off the landmark row', 'stops', '[113.320579, 23.12026]', '[113.3205851, 23.1202087]'],
  ['short dwell', 'stops', 'TOUR_DWELL_MS = 7000', 'TOUR_DWELL_MS = 6000'],
  ['inactive reports active', 'inactive', 'get active() { return index >= 0; }', 'get active() { return true; }'],
  ['dwell starts before arrival', 'arrival', "map.flyTo(camera(TOUR_STOPS[index]));", "map.flyTo(camera(TOUR_STOPS[index])); schedule();"],
  ['arrival never schedules dwell', 'arrival', '      schedule();', '      // Missing arrival schedule.'],
  ['runtime dwell off by one', 'arrival', '}, TOUR_DWELL_MS);', '}, TOUR_DWELL_MS - 1);'],
  ['camera result ignored', 'arrival', 'map.flyTo(camera(TOUR_STOPS[index]));', 'map.flyTo(TOUR_STOPS[index]);'],
  ['wrap after final stop', 'complete', 'if (index === TOUR_STOPS.length - 1) exit();', 'if (index === TOUR_STOPS.length - 1) visit(0);'],
  ['exit before library', 'complete', 'if (index === TOUR_STOPS.length - 1) exit();', 'if (index === TOUR_STOPS.length - 2) exit();'],
  ['pause loses travelling', 'pauseTravelling', 'if (!playing) { cancel(); map.stop(); publish(); }', 'if (!playing) { cancel(); map.stop(); travelling = false; publish(); }'],
  ['resume advances instead of completing the flight', 'pauseTravelling', 'else if (travelling) visit(index);', 'else if (travelling) visit(index + 1);'],
  ['pause does not stop the flight', 'pauseTravelling', 'if (!playing) { cancel(); map.stop(); publish(); }', 'if (!playing) { cancel(); publish(); }'],
  ['arrived resume does not arm dwell', 'pauseArrived', 'else { publish(); schedule(); }', 'else { publish(); }'],
  ['arrived resume unnecessarily reflys', 'pauseArrived', 'else { publish(); schedule(); }', 'else { visit(index); }'],
  ['step ignores delta', 'navigation', 'const next = index + delta;', 'const next = index + 1;'],
  ['last manual next wraps', 'navigation', 'if (next >= TOUR_STOPS.length) exit();', 'if (next >= TOUR_STOPS.length) visit(0);'],
  ['stop before cancelling listener', 'navigation', '    cancel();\n    map.stop();\n    index = next;', '    map.stop();\n    cancel();\n    index = next;'],
  ['persistent arrival listener', 'rapidSteps', "map.once('moveend', arrival);", "map.on('moveend', arrival);"],
  ['cancel leaves old timers', 'rapidSteps', 'function cancel() {\n    clearTimeout(timer);', 'function cancel() {\n    // Missing timer cancellation.'],
  ['cancel leaves old listeners', 'restart', "if (arrival) map.off('moveend', arrival);", '// Missing listener cancellation.'],
  ['exit skips cancellation', 'exitArrived', 'if (index < 0) return;\n    cancel();', 'if (index < 0) return;\n    // Missing exit cancellation.'],
  ['exit stops before removing listener', 'exitTravelling', 'if (index < 0) return;\n    cancel();', 'if (index < 0) return;\n    map.stop();\n    cancel();'],
  ['restart is ignored while active', 'restart', 'start(autoplay = true) { playing = autoplay; visit(0); }', 'start(autoplay = true) { if (index >= 0) return; playing = autoplay; visit(0); }'],
  ['reframe advances a stop', 'reframeTravelling', 'reframe() { if (index >= 0) visit(index); }', 'reframe() { if (index >= 0) visit(index + 1); }'],
  ['reframe is a no-op', 'reframeArrived', 'reframe() { if (index >= 0) visit(index); }', 'reframe() {}'],
  ['manual mode ignored', 'manual', 'playing = autoplay; visit(0);', 'playing = true; visit(0);'],
  ['manual arrival arms autoplay', 'manual', 'if (playing) timer = setTimeout', 'timer = setTimeout'],
  ['manual reframe resumes autoplay', 'manual', 'reframe() { if (index >= 0) visit(index); }', 'reframe() { if (index >= 0) { playing = true; visit(index); } }'],
];

function replaceOnce(source, from, to) {
  assert.equal(source.split(from).length, 2, `mutation must have exactly one source target: ${from}`);
  return source.replace(from, to);
}

test('in-memory defect injection: each key behavior rejects a broken implementation', async (t) => {
  const source = readFileSync(new URL('../src/tour.js', import.meta.url), 'utf8');
  const portable = replaceOnce(source, "'./config.js'", JSON.stringify(new URL('../src/config.js', import.meta.url).href));
  for (const [name, behavior, from, to] of mutations) {
    await t.test(name, async (t) => {
      const mutantSource = replaceOnce(portable, from, to);
      // Import/parse failures are outside assert.throws: only a behavioral assertion kills a mutant.
      const mutant = await import(`data:text/javascript;base64,${Buffer.from(mutantSource).toString('base64')}`);
      assert.throws(() => behaviors[behavior](t, mutant), { name: 'AssertionError', code: 'ERR_ASSERTION' }, `surviving mutant: ${name}`);
    });
  }
});

const tourSource = readFileSync(new URL('../src/tour.js', import.meta.url), 'utf8');

// A fresh worker evaluates the REAL config after setting its own location. Neither
// the parent globals/module cache nor another test process ever sees that location.
// Portability changes only the relative config import, not SCENE or the stop data.
function snapshotInScene(source, search) {
  const portable = replaceOnce(source, "'./config.js'", JSON.stringify(new URL('../src/config.js', import.meta.url).href));
  return new Promise((resolve, reject) => {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      globalThis.location = { search: workerData.search };
      import(workerData.url).then(({ TOUR_STOPS, TOUR_DWELL_MS }) => {
        parentPort.postMessage({ TOUR_STOPS, TOUR_DWELL_MS });
      });
    `, { eval: true, workerData: { search, url: `data:text/javascript;base64,${Buffer.from(portable).toString('base64')}` } });
    let snapshot;
    worker.once('message', (value) => { snapshot = value; });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code === 0 && snapshot) resolve(snapshot);
      else reject(new Error(`scene worker exited without a snapshot (code ${code})`));
    });
  });
}

// Every stop value, including camera angles and wording, remains contractual.
// 广州图书馆那一句 2026-10-16 改过一次：它不再是最后一站，原文"结束这程两岸眺望"当场就不成立了。
// 广州东塔那一句同一天删去"这条 way 没有 building 值"半句：320 px 上它因此多折一行，播放条 192.7 px 破了 180 的上限。
const cantonStops = [
  { name: '广州塔', bank: '南岸', center: [113.31913, 23.109], zoom: 15.4, pitch: 58, bearing: -25, osmId: 584204634,
    description: '从珠江南岸出发，隔江望向珠江新城。' },
  { name: '海心桥', bank: '江上', center: [113.314334, 23.1110888], zoom: 16, pitch: 45, bearing: 35, osmId: 1313608038,
    description: '步行拱桥横跨珠江；桥面按 OSM 的闭合轮廓立起，拱肋与吊杆沿轮廓内量出的跨径线起拱，净空与厚度是示意。' },
  { name: '花城广场', bank: '北岸', center: [113.319181, 23.122579], zoom: 15.7, pitch: 40, bearing: 180, osmId: 243319596,
    description: '沿花城广场向南望，绿地串起珠江新城的中轴线。' },
  { name: '广州图书馆', bank: '北岸', center: [113.3206608, 23.1189093], zoom: 17, pitch: 48, bearing: 35, osmId: 240896441,
    description: '在花城广场东侧的广州图书馆；从这里向北，是中轴两侧的两座塔。' },
  { name: '广东省博物馆', bank: '北岸', center: [113.321145, 23.117494], zoom: 16.8, pitch: 50, bearing: 20, osmId: 240896442,
    description: '珠江东路 2 号，与图书馆相邻；快照标 5 层，按每层 3.2 m 换算作 16 m 示意厚度。' },
  { name: '广州西塔', bank: '北岸', center: [113.317861, 23.120317], zoom: 15.6, pitch: 60, bearing: 270, osmId: 184738716,
    description: '花城广场西侧，与东塔隔广场相望；OSM 标注 440.2 m 与 103 层，自宽脚向圆头收分的曲线是示意。' },
  { name: '广州东塔', bank: '北岸', center: [113.320579, 23.12026], zoom: 15.6, pitch: 60, bearing: 90, osmId: 511404889,
    description: '花城广场东侧；OSM 标注 530 m 与 111 层。它只标了 building:part，所以按"未分类"上色。' },
  { name: '猎德大桥', bank: '江上', center: [113.328447, 23.113333], zoom: 15.2, pitch: 45, bearing: 80, osmId: 233809684,
    description: '塔脚东北 1.07 km；画面里是 OSM 那两条各 17 m 宽的车行面，净空与厚度是示意，斜拉塔与索 OSM 没有。' },
];

function literal(value) {
  if (Array.isArray(value)) return `[${value.join(', ')}]`;
  return typeof value === 'string' ? `'${value}'` : String(value);
}

// Pair every field assertion with its own source mutation; no earlier assertion
// can accidentally kill the mutant in place of the assertion being exercised.
function stopContracts(expectedStops) {
  const broken = { name: "'错误站点'", bank: "'错误区域'", center: '[0, 0]', zoom: '0', pitch: '-1', bearing: 'NaN', osmId: '0', sourceId: "'way/0'", description: "''" };
  return expectedStops.flatMap((stop, index) => Object.entries(stop).map(([field, value]) => ({
    name: `${stop.name}: ${field}`,
    check: ({ TOUR_STOPS }) => assert.deepEqual(TOUR_STOPS[index][field], value),
    mutate(source) {
      const original = field === 'center' && index === 0 ? '[DEFAULT_CENTER.lng, DEFAULT_CENTER.lat]'
        : field === 'osmId' && stop.name === '广州塔' ? 'TOWER_OSM_ID' : literal(value);
      const from = `${field}: ${original}`, to = `${field}: ${broken[field]}`;
      if (field === 'description') return replaceOnce(source, from, to);
      // Scope shared values (e.g. zoom 17.5 or DEFAULT_CENTER) to this stop only.
      const line = source.split('\n').find((line) => line.includes(`name: '${stop.name}'`));
      return replaceOnce(source, line, replaceOnce(line, from, to));
    },
  })));
}

const cantonContracts = stopContracts(cantonStops);

test('the tower tour is the only tour: default, explicit and stale scene queries all keep every stop value', async () => {
  // `?scene=jingtai` 还活在别人收藏的旧链接里，它现在只能落到塔这一侧。
  for (const search of ['', '?scene=canton', '?scene=jingtai']) {
    const implementation = await snapshotInScene(tourSource, search);
    assert.equal(implementation.TOUR_STOPS.length, cantonStops.length, search);
    assert.equal(implementation.TOUR_STOPS.length, 8, search);
    assert.equal(implementation.TOUR_DWELL_MS, DWELL, search);
    for (const { check } of cantonContracts) check(implementation);
  }
});

test('in-memory tour defects: every contract assertion rejects its own mutant', async (t) => {
  for (const { name, check, mutate } of cantonContracts) {
    await t.test(name, async () => {
      // Import failures are NOT assertion kills. Only the same contract used above
      // may reject the successfully evaluated in-memory source mutant.
      const implementation = await snapshotInScene(mutate(tourSource), '?scene=canton');
      assert.throws(() => check(implementation), { name: 'AssertionError', code: 'ERR_ASSERTION' }, `surviving mutant: ${name}`);
    });
  }
});
