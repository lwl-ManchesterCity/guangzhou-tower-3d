import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as film from '../src/film.js';

function rig(module) {
  const pending = new Map(), draws = [], states = [];
  let id = 0, exits = 0;
  const player = module.createFilm({
    draw: (time) => draws.push(time), onChange: (state) => states.push(state), onExit: () => exits++,
    requestFrame: (callback) => { pending.set(++id, callback); return id; }, cancelFrame: (key) => pending.delete(key),
  });
  return { player, pending, draws, states, get exits() { return exits; },
    advance(now) {
      assert.equal(pending.size, 1);
      const [key, callback] = pending.entries().next().value;
      pending.delete(key);
      callback(now);
    },
  };
}
function checkClock(module) {
  const r = rig(module), p = r.player;
  p.toggle(); p.pause(); p.exit(); p.reduce(); p.reframe();
  assert.deepEqual(p.state, { active: false, playing: false, reduced: false, elapsed: 0 });
  assert.equal(r.draws.length, 0);
  p.start();
  assert.deepEqual(p.state, { active: true, playing: true, reduced: false, elapsed: 0 });
  assert.deepEqual(r.draws, [0]);
  p.start();
  assert.equal(r.pending.size, 1);
  assert.equal(r.draws.length, 1);
  r.advance(100000);
  assert.equal(p.state.elapsed, 0);
  r.advance(100500);
  assert.equal(p.state.elapsed, 500);
  const count = r.draws.length;
  p.reframe();
  assert.equal(r.draws.length, count + 1);
  assert.equal(r.draws.at(-1), 500);
  assert.equal(r.pending.size, 1);
  p.pause();
  assert.equal(p.state.playing, false);
  assert.equal(r.pending.size, 0);
  assert.equal(p.state.elapsed, 500);
  p.toggle();
  r.advance(900000);
  assert.equal(p.state.elapsed, 500);
  r.advance(900200);
  assert.equal(p.state.elapsed, 700);
  r.advance(947500);
  assert.equal(p.active, false);
  assert.equal(r.exits, 1);
  assert.equal(r.pending.size, 0);
  p.exit();
  assert.equal(r.exits, 1);
  p.start();
  assert.equal(p.state.elapsed, 0);
  const stale = r.pending.values().next().value;
  p.exit();
  const stoppedDraws = r.draws.length;
  stale(999000);
  assert.equal(r.pending.size, 0);
  assert.equal(r.draws.length, stoppedDraws);
  assert.equal(r.exits, 2);
  assert.equal(r.states.at(-1).active, false);
}
function checkReduced(module) {
  const r = rig(module), p = r.player;
  p.start(true);
  assert.deepEqual(p.state, { active: true, playing: false, reduced: true, elapsed: 0 });
  assert.equal(r.pending.size, 0);
  for (let i = 1; i < 6; i++) {
    p.toggle();
    assert.equal(p.state.elapsed, i * 8000);
    assert.equal(r.draws.at(-1), i * 8000);
    assert.equal(p.active, true);
    assert.equal(r.pending.size, 0);
  }
  p.toggle();
  assert.equal(p.active, false);
  assert.equal(r.exits, 1);
  p.start();
  r.advance(1000); r.advance(1250);
  p.reduce();
  assert.deepEqual(p.state, { active: true, playing: false, reduced: true, elapsed: 250 });
  assert.equal(r.pending.size, 0);
  p.toggle();
  assert.equal(p.state.elapsed, 8000);
  assert.equal(r.pending.size, 0);
}
function checkFrames(module) {
  assert.equal(module.FILM_DURATION, 48000);
  assert.equal(module.FILM_SHOTS.length, 6);
  assert.deepEqual(module.FILM_SHOTS.map((shot) => shot.mood), ['day', 'day', 'sunset', 'sunset', 'night', 'night']);
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 667, height: 375 }, { width: 320, height: 568 }]) {
    for (let i = 0; i < 6; i++) {
      const start = module.filmFrame(i * 8000, viewport);
      const middle = module.filmFrame(i * 8000 + 4000, viewport);
      const last = module.filmFrame(i * 8000 + 7999, viewport);
      assert.equal(start.index, i);
      assert.equal(last.index, i);
      assert.equal(start.progress, 0);
      assert.equal(middle.progress, 0.5);
      assert.deepEqual(start.camera.center, module.FILM_SHOTS[i].center);
      assert.equal(start.camera.pitch, start.shot.from[1]);
      assert.equal(middle.camera.bearing, (start.shot.from[2] + start.shot.to[2]) / 2);
      for (const view of [start, middle, last]) {
        assert.ok([view.camera.zoom, view.camera.pitch, view.camera.bearing, ...view.camera.center, ...Object.values(view.camera.padding)].every(Number.isFinite));
        assert.ok(view.camera.zoom >= 10 && view.camera.zoom <= 18.5);
        assert.ok(view.camera.pitch >= 0 && view.camera.pitch <= 70);
        assert.ok(view.bar >= 52 && view.bar * 2 < viewport.height);
        assert.ok(Object.values(view.camera.padding).every((value) => value >= 0));
      }
    }
    assert.equal(module.filmFrame(-100, viewport).time, 0);
    const end = module.filmFrame(50000, viewport);
    assert.equal(end.time, 48000);
    assert.equal(end.index, 5);
    assert.equal(end.progress, 1);
  }
  const desktop = module.filmFrame(0, { width: 1440, height: 900 });
  const phone = module.filmFrame(0, { width: 390, height: 844 });
  assert.ok(phone.camera.zoom < desktop.camera.zoom);
  for (const viewport of [{ width: 1440, height: 720 }, { width: 800, height: 1000 }])
    assert.ok(module.filmFrame(0, viewport).bar >= 80, 'desktop controls and credit need separate rows');
}

test('film clock starts, pauses, resumes, finishes and replays without leaking frames', () => checkClock(film));
test('reduced motion is manual and switching preferences cancels the running clock', () => checkReduced(film));
test('six geographic shots have bounded continuous camera values on all supported viewports', () => checkFrames(film));

const source = await readFile(new URL('../src/film.js', import.meta.url), 'utf8');
const cases = [
  ['duplicate start', 'if (active) return;', '', checkClock],
  ['clock advances on first frame', 'if (previous !== undefined) elapsed += now - previous;', 'elapsed += now - (previous ?? 0);', checkClock],
  ['paused callbacks remain scheduled', 'cancelFrame(frame); frame = undefined;', 'frame = undefined;', checkClock],
  ['resume counts paused wall time', 'else { playing = true; previous = undefined;', 'else { playing = true; previous = 0;', checkClock],
  ['end never exits', 'if (elapsed >= FILM_DURATION) { exit(); return; }', 'if (elapsed > FILM_DURATION + 1) { exit(); return; }', checkClock],
  ['replay keeps old time', '      elapsed = 0;', '      elapsed = 123;', checkClock],
  ['reframe does not draw', 'reframe() { if (active) render(); }', 'reframe() {}', checkClock],
  ['reduced motion flies anyway', 'playing = !still;', 'playing = true;', checkReduced],
  ['manual chapters do not advance', 'elapsed = (Math.floor(elapsed / FILM_SHOT_MS) + 1) * FILM_SHOT_MS;', 'elapsed = 0;', checkReduced],
  ['reduce leaves the clock running', '      this.pause();', '      publish();', checkReduced],
  ['chapter boundary rounds early', 'Math.floor(time / FILM_SHOT_MS)', 'Math.round(time / FILM_SHOT_MS)', checkFrames],
  ['unclamped duration', 'Math.max(0, Math.min(FILM_DURATION, elapsed))', 'Math.max(0, elapsed)', checkFrames],
  ['portrait forgets zoom compensation', 'zoom: zoom + Math.log2(Math.min(1, width / 1100, aperture / 620))', 'zoom', checkFrames],
  ['desktop footer clips controls', 'width <= 700 || height <= 500 ? 52 : 84', '52', checkFrames],
];
for (const [name, from, to, check] of cases) test(`film assertions reject injected defect: ${name}`, async () => {
  assert.equal(source.split(from).length - 1, 1, 'mutation must hit exactly once');
  const changed = source.replace(from, to).replace("'./landmarks.js'", JSON.stringify(new URL('../src/landmarks.js', import.meta.url).href));
  const broken = await import(`data:text/javascript;base64,${Buffer.from(changed).toString('base64')}`);
  assert.throws(() => check(broken), { code: 'ERR_ASSERTION' });
});
