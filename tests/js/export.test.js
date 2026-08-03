import assert from 'node:assert/strict';
import test from 'node:test';

import { restoreExportEffects } from '../../js/export/map-export.js';

test('la restauration d’export relance la fumée même si le vent échoue', () => {
  const calls = [];
  const snapshot = { wind: { running: true }, smoke: { running: true } };
  const wind = {
    restoreExport(value) {
      calls.push(['wind', value]);
      throw new Error('vent indisponible');
    },
  };
  const smoke = {
    restoreExport(value) {
      calls.push(['smoke', value]);
    },
  };

  assert.throws(
    () => restoreExportEffects(snapshot, wind, smoke),
    /vent indisponible/,
  );
  assert.deepEqual(calls, [
    ['wind', snapshot.wind],
    ['smoke', snapshot.smoke],
  ]);
});
