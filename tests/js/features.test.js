import assert from 'node:assert/strict';
import test from 'node:test';

import { burntPaintAt, createBurntController } from '../../js/features/burnt.js';
import {
  createAgeRamps,
  createFiresController,
  MAX_AGE,
  rampAfter,
  rampAt,
  zoomScaleFor,
} from '../../js/features/fires.js';


const colors = { front: '#1', hot: '#2', recent: '#3', old: '#4' };

test('les rampes de foyers conservent leurs bornes et interpolations', () => {
  const desktop = createAgeRamps({ mobile: false, ...colors });
  const mobile = createAgeRamps({ mobile: true, ...colors });

  assert.equal(rampAt(desktop.AGE_SIZE, -1), 4.4);
  assert.equal(rampAt(desktop.AGE_SIZE, 3 * 3600), 4.15);
  assert.equal(rampAt(desktop.AGE_OPACITY, MAX_AGE), .16);
  assert.equal(rampAt(desktop.AGE_OPACITY, MAX_AGE + 1), 0);
  assert.equal(rampAt(desktop.AGE_OPACITY, MAX_AGE + 2), 0);
  assert.equal(mobile.AGE_SIZE[0][1], 4);
  assert.deepEqual(rampAfter([[0, 2], [10, 3], [20, 4]], 10, 2), [20, 8]);
});

test('les expressions de foyers figent le vieillissement au dernier instant observé', () => {
  const ramps = createAgeRamps({ mobile: false, ...colors });
  const calls = ts => {
    const output = [];
    const map = {
      getLayer: () => true,
      setPaintProperty: (...args) => output.push(args),
    };
    createFiresController({ map, ramps, zoomScale: zoomScaleFor(false), value: () => '' })
      .setTime(ts, 1_000, 600);
    return output;
  };
  const atLast = calls(1_000);
  const forecast = calls(2_000);

  assert.deepEqual(forecast, atLast);
  assert.deepEqual(atLast[0][2].slice(0, 3),
    ['interpolate', ['linear'], ['-', 1_000, ['get', 'ts']]]);
  assert.equal(atLast.at(-1)[2].at(-1), 0);
});

test('les surfaces brûlées basculent exactement au dernier instant observé', () => {
  assert.deepEqual(burntPaintAt(999, 1_000), {
    fill: 0, nrtFill: 0, line: 0, nrtLine: 0,
  });
  assert.deepEqual(burntPaintAt(1_000, 1_000), {
    fill: .70, nrtFill: .30, line: .95, nrtLine: .55,
  });
  assert.deepEqual(burntPaintAt(1_001, 1_000), {
    fill: .70, nrtFill: .30, line: .95, nrtLine: .55,
  });
});

test('les contrôleurs installent les couches dans l’ordre historique', () => {
  const layers = [];
  const map = {
    addLayer: layer => layers.push(layer),
    getLayer: () => false,
  };
  const value = name => name;
  const manifest = { detail_zoom: 9, legacy: false };
  const burnt = createBurntController({
    map, value,
    getState: () => ({ atLatest: true, layerVisibility: { dated: true, nrt: true } }),
  });
  const fires = createFiresController({
    map, value,
    ramps: createAgeRamps({ mobile: false, ...colors }),
    zoomScale: zoomScaleFor(false),
  });

  burnt.install(manifest);
  fires.install(manifest);
  assert.deepEqual(layers.map(layer => layer.id), [
    'nrt-fill', 'recent-fill', 'recent-line', 'burnt-fill', 'burnt-line', 'nrt-line',
    'hotspots-overview', 'hotspots',
  ]);
});
