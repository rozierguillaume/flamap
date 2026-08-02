import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getState,
  setCurrentTime,
  setLayerVisibility,
  setTimeline,
  subscribe,
} from '../../js/state.js';


test('le store publie des snapshots immuables sans capturer le temps', () => {
  const notifications = [];
  const unsubscribe = subscribe((next, previous) => notifications.push({ next, previous }));
  const source = [
    { ts: 1000, kind: 'sat', n: 1 },
    { ts: 2000, kind: 'sat', n: 2 },
    { ts: 3000, kind: 'wind', n: 0 },
  ];

  setTimeline(source, 1);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].previous.atLatest, true);
  assert.equal(notifications[0].next.lastObservedTime, 2000);
  source[0].ts = 0;
  source.push({ ts: 4000, kind: 'wind', n: 0 });
  assert.deepEqual(getState().steps.map(step => step.ts), [1000, 2000, 3000]);
  assert.equal(Object.isFrozen(getState()), true);
  assert.equal(Object.isFrozen(getState().steps), true);
  assert.equal(Object.isFrozen(getState().steps[0]), true);

  setCurrentTime(1500);
  assert.equal(getState().atLatest, false);
  setCurrentTime(2000);
  assert.equal(getState().atLatest, true);
  assert.equal(getState().currentTime, 2000);
  const afterCurrentTime = notifications.length;
  setCurrentTime(2000);
  assert.equal(notifications.length, afterCurrentTime);

  setLayerVisibility('VIIRS/NOAA-20', false);
  assert.equal(getState().layerVisibility.hotspots['VIIRS/NOAA-20'], false);
  assert.equal(Object.isFrozen(getState().layerVisibility.hotspots), true);
  assert.throws(() => setLayerVisibility('inconnue', true), RangeError);
  assert.throws(() => setLayerVisibility('toString', true), RangeError);

  unsubscribe();
  const count = notifications.length;
  setLayerVisibility('dated', false);
  assert.equal(notifications.length, count);
  assert.equal(getState().layerVisibility.dated, false);
});
