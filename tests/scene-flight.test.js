import test from 'node:test';
import assert from 'node:assert/strict';
import { VIEW_LIMITS } from '../src/config.js';
import { SCENES } from '../src/scenes.js';
import { DISC_PIXELS, HANDOFF_KEY, HANDOFF_TTL_MS, discPixelsOf, readHandoff, relayView, relayZoom, sceneGap, writeHandoff } from '../src/scene-flight.js';

const { canton, jingtai } = SCENES;
// 验收口径下的画面：浏览器那几项都跑在 1440×960 上，圆盘占多少短边是按这个数算的。
const FRAME = { width: 1440, height: 960 };

const storage = (fail = null) => {
  const box = new Map();
  return {
    box,
    getItem: (key) => { if (fail === 'get') throw new Error('denied'); return box.has(key) ? box.get(key) : null; },
    setItem: (key, value) => { if (fail === 'set') throw new Error('denied'); box.set(key, value); },
    removeItem: (key) => { if (fail === 'remove') throw new Error('denied'); box.delete(key); },
  };
};

test('两份快照之间空着一段谁都没画的距离，这就是转场必须换页的那笔账', () => {
  const gap = sceneGap(canton, jingtai);
  assert.ok(gap > 0, '两份快照若已经接上，同实例飞行就不再是需要解释的取舍');
  assert.ok(gap > 3600 && gap < 3900, `塔边 3 km 圈与景泰 2 km 圈之间实测 ${Math.round(gap)} m，与文档记的约 3.7 km 对不上`);
  // 圆与圆不相交是这条判据的全部意思：相交的那一段才有"飞过去"可画。
  assert.ok(gap > 1000, '留 1 km 以上才谈得上"这一半路程画面里没有任何街区"');
});

test('中继那一格把街区缩成一枚认不出来的圆盘，两侧一样大', () => {
  for (const scene of [canton, jingtai]) {
    const zoom = relayZoom(scene);
    assert.ok(Math.abs(discPixelsOf(scene, zoom) - DISC_PIXELS) < 1e-6, `${scene.id} 在中继级上不是 ${DISC_PIXELS} px`);
    assert.ok(zoom > VIEW_LIMITS.minZoom && zoom < VIEW_LIMITS.maxZoom, `${scene.id} 的中继级 ${zoom.toFixed(2)} 会被地图自己的缩放范围夹住，两侧就对不上了`);
    assert.ok(zoom < scene.camera.zoom, `${scene.id} 的中继级 ${zoom.toFixed(2)} 没有比开屏机位 ${scene.camera.zoom} 更远`);
    assert.ok(DISC_PIXELS <= FRAME.height * 0.2, `圆盘占掉短边的 ${(DISC_PIXELS / FRAME.height * 100).toFixed(0)} %，切页那一帧还剩能认的东西`);
  }
  // 切页两侧同一枚直径：半径差 1 km（3 km 对 2 km）就是靠这两档不同的缩放补掉的，共用一个 zoom 会露出 1.5 倍。
  const out = discPixelsOf(canton, relayZoom(canton)), inb = discPixelsOf(jingtai, relayZoom(jingtai));
  assert.ok(Math.abs(out - inb) < 1, `起飞那帧的街区是 ${out.toFixed(0)} px、落地那帧是 ${inb.toFixed(0)} px，切页看成缩放跳了一下`);
  assert.ok(Math.abs(relayZoom(jingtai) - relayZoom(canton)) > 0.4, '两档中继级若几乎相同，说明直径没有真的对齐');
});

test('中继机位是正着俯视自己那一块地，方位与俯仰都归零', () => {
  for (const scene of [canton, jingtai]) {
    const view = relayView(scene);
    assert.deepEqual([view.pitch, view.bearing], [0, 0], `${scene.id} 的中继机位带着角度，切页时那半圈会看得很清楚`);
    assert.deepEqual(view.center, scene.center, `${scene.id} 的圆盘要站在自己街区头上`);
  }
});

test('交接记录只管一次降落', () => {
  const store = storage();
  assert.equal(writeHandoff(store, { from: 'canton', to: 'jingtai', at: 1000 }), true);
  assert.equal(store.box.get(HANDOFF_KEY), JSON.stringify({ from: 'canton', to: 'jingtai', at: 1000 }));
  const read = readHandoff(store, 'jingtai', 1500);
  assert.deepEqual(read, { from: 'canton', to: 'jingtai', at: 1000 });
  assert.equal(readHandoff(store, 'jingtai', 1600), null, '读完必须销掉，否则每次刷新都要重降一遍');

  // 过期：对面那页没在 TTL 内落下来（网络卡住、用户改了地址），就按正常开页走。
  writeHandoff(store, { from: 'canton', to: 'jingtai', at: 1000 });
  assert.equal(readHandoff(store, 'jingtai', 1000 + HANDOFF_TTL_MS + 1), null);
  assert.equal(store.box.has(HANDOFF_KEY), false, '过期记录要一起吃掉，留着会弄飞下一次开页');

  // 对不上场景（用户在换页前自己按了回退）：同样吃掉而不是留着。
  writeHandoff(store, { from: 'canton', to: 'jingtai', at: 1000 });
  assert.equal(readHandoff(store, 'canton', 1200), null);
  assert.equal(store.box.has(HANDOFF_KEY), false);

  // 时间倒流（换机器、改系统时间）不算"刚交接"。
  writeHandoff(store, { from: 'canton', to: 'jingtai', at: 9000 });
  assert.equal(readHandoff(store, 'jingtai', 1000), null);
});

test('没有 sessionStorage 也要能换页，只是没有降落', () => {
  assert.equal(writeHandoff(undefined, { from: 'a', to: 'b', at: 1 }), false, '无痕模式里写不进去不是错');
  assert.equal(readHandoff(undefined, 'b'), null);
  const refused = storage('set');
  assert.equal(writeHandoff(refused, { from: 'a', to: 'b', at: 1 }), false);
  assert.equal(readHandoff(storage('get'), 'b', 2), null);
  // 脏数据（上一次别的版本留下的字符串）不能被当成交接。
  const dirty = storage();
  dirty.box.set(HANDOFF_KEY, 'not json');
  assert.equal(readHandoff(dirty, 'b', 2), null);
  const wrong = storage();
  writeHandoff(wrong, { from: 'a', to: 'b' });
  assert.equal(readHandoff(wrong, 'b', 2), null, '没有时刻的记录不算交接');
});
