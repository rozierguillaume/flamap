import assert from 'node:assert/strict';
import test from 'node:test';

import {
  aircraftBearing,
  aircraftCurve,
  distanceKm,
  signed,
  unionBbox,
  zoneId,
} from '../../js/util/geo.js';


test('distanceKm conserve l’approximation géographique historique', () => {
  assert.equal(distanceKm([2, 46], [2, 46]), 0);
  assert.equal(distanceKm([2, 46], [3, 47]), 134.52701880588387);
  assert.equal(distanceKm([3, 47], [2, 46]), 134.52701880588387);
});

test('aircraftCurve conserve l’interpolation Catmull-Rom', () => {
  assert.deepEqual(
    aircraftCurve([0, 0], [1, 1], [2, 1], [3, 0], .5),
    [1.5, 1.125],
  );
  assert.deepEqual(
    aircraftCurve([0, 0], [1, 1], [2, 1], [3, 0], 0),
    [1, 1],
  );
});

test('aircraftBearing conserve le cap géographique', () => {
  assert.equal(aircraftBearing([2, 46], [3, 46]), 90);
  assert.equal(aircraftBearing([2, 46], [2, 45]), 180);
});

test('signed et zoneId conservent le nommage des cellules', () => {
  assert.equal(signed(5), '+05');
  assert.equal(signed(-3), '-03');
  assert.equal(signed(0), '+00');
  assert.equal(zoneId(5, -3), 'x+05_y-03');
});

test('unionBbox enveloppe les rectangles ibériques du manifeste', () => {
  const iberia = [[-9.8, 36.0, -1.5, 44.0], [-1.5, 37.4, 4.6, 43.0]];
  assert.deepEqual(unionBbox(iberia), [-9.8, 36.0, 4.6, 44.0]);
  assert.deepEqual(unionBbox([[-5.5, 41.0, 10.0, 51.5]]), [-5.5, 41.0, 10.0, 51.5]);
});
