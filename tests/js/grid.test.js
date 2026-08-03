import assert from 'node:assert/strict';
import test from 'node:test';

import { gridAt, gridBilinear, windAtGrid } from '../../js/util/grid.js';


const geometry = { bbox: [0, 0, 1, 1], nx: 2, ny: 2 };

test('gridBilinear conserve les coins, le centre et les replis invalides', () => {
  const values = [0, 10, 20, 30];
  assert.equal(gridBilinear(geometry, values, 0, 0), 0);
  assert.equal(gridBilinear(geometry, values, .5, .5), 15);
  assert.equal(gridBilinear(geometry, values, 1, 1), 30);
  assert.equal(gridBilinear(geometry, values, -1, .5), null);
  assert.equal(gridBilinear(geometry, [0, 10, NaN, 30], .5, .5), null);
  assert.equal(gridBilinear(null, values, .5, .5), null);
});

test('gridAt conserve l’interpolation spatiale et temporelle', () => {
  const grid = {
    ...geometry,
    t0: 100,
    dt: 10,
    temperature: [[0, 10, 20, 30], [10, 20, 30, 40]],
  };
  assert.equal(gridAt(grid, 'temperature', .5, .5, 100), 15);
  assert.equal(gridAt(grid, 'temperature', .5, .5, 105), 20);
  assert.equal(gridAt(grid, 'temperature', .5, .5, 110), 25);
  assert.equal(gridAt(grid, 'temperature', .5, .5, 99), null);
  assert.equal(gridAt(grid, 'missing', .5, .5, 100), null);
});

test('windAtGrid conserve le booléen de couverture et remplit la sortie', () => {
  const wind = {
    u: [0, 2, 4, 6],
    v: [10, 12, 14, 16],
    gust: [20, 22, 24, 26],
  };
  const out = {};
  assert.equal(windAtGrid(geometry, wind, .5, .5, out), true);
  assert.deepEqual(out, { u: 3, v: 13, g: 23 });
  assert.equal(windAtGrid(geometry, wind, 2, .5, {}), false);
  assert.equal(windAtGrid(null, wind, .5, .5, {}), false);
});
