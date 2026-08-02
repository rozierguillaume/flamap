import assert from 'node:assert/strict';
import test from 'node:test';

import { loadInlineFunction, plain } from './inline-function-loader.js';


const buildSteps = loadInlineFunction('buildSteps', '/* Les crans à venir.');
const activityMovingAverage = loadInlineFunction(
  'activityMovingAverage',
  'const countLabel',
  'const activityValue = step => step.n;',
);
const activityScale = loadInlineFunction(
  'activityScale',
  'function activityTickLabel',
);
const psfdfUpdatedTimestamp = loadInlineFunction(
  'psfdfUpdatedTimestamp',
  'function currentPsfdf',
  'Date.now = () => new Date(2026, 7, 2, 12, 0, 0).getTime();',
);


const feature = (ts, source, frp) => ({
  properties: { ts, source, frp },
});


test('buildSteps conserve les rafales par source et borne EFFIS', () => {
  const hotspots = { features: [
    feature(1000, 'A', 1.11),
    feature(1200, 'B', 4),
    feature(2499, 'A', 2.22),
    feature(4000, 'A', 8),
  ] };
  const dated = { features: [
    { properties: { lu: 900 } },
    { properties: { lu: 2600 } },
    { properties: { lu: 2600 } },
    { properties: { lu: 4200 } },
  ] };

  const result = plain(buildSteps(hotspots, dated));

  assert.deepEqual(result.map(step => step.ts), [1000, 1200, 2600, 4000, 4200]);
  assert.deepEqual(result[0], {
    ts: 1000, kind: 'sat', label: 'A', n: 2, frp: 3.33,
  });
  assert.deepEqual(result[2], {
    ts: 2600, kind: 'effis', label: 'EFFIS', n: 0,
  });
});

test('activityMovingAverage utilise une fenêtre temporelle centrée', () => {
  const passes = [
    { ts: 0, n: 2 },
    { ts: 10, n: 4 },
    { ts: 30, n: 8 },
  ];

  assert.deepEqual(plain(activityMovingAverage(passes, 20)), [
    { ts: 0, value: 3 },
    { ts: 10, value: 3 },
    { ts: 30, value: 8 },
  ]);
});

test('activityScale garde les graduations 1-2-5 et les comptes entiers', () => {
  assert.deepEqual(plain(activityScale(17, 'count')), {
    max: 20,
    ticks: [0, 5, 10, 15, 20],
  });
  assert.deepEqual(plain(activityScale(0.7, 'frp')), {
    max: 0.8,
    ticks: [0, 0.2, 0.4, 0.6000000000000001, 0.8],
  });
});

test('psfdfUpdatedTimestamp reconnaît les deux ordres de date PSFDF', () => {
  const french = new Date(psfdfUpdatedTimestamp('01/08/2026 à 14:30:05'));
  const american = new Date(psfdfUpdatedTimestamp('8/1/2026 15:45'));

  assert.deepEqual(
    [french.getFullYear(), french.getMonth() + 1, french.getDate(), french.getHours()],
    [2026, 8, 1, 14],
  );
  assert.deepEqual(
    [american.getFullYear(), american.getMonth() + 1, american.getDate(), american.getHours()],
    [2026, 8, 1, 15],
  );
  assert.equal(Number.isNaN(psfdfUpdatedTimestamp('31/31/2026')), true);
});
