import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { loadInlineContext, plain } from './inline-function-loader.js';


const appSource = fs.readFileSync(
  new URL('../../js/app.js', import.meta.url),
  'utf8',
);

const historyPayload = {
  now: 1_800_000,
  aircraft: [{
    hex: 'abc123',
    latest: { hex: 'abc123', flight: 'TEST' },
    points: [
      { ts: 1_792_000, lon: 2.1, lat: 46.1 },
      { ts: 1_796_000, lon: 2.2, lat: 46.2 },
    ],
  }],
};

const setup = `
  const AIRCRAFT_HISTORY_URL = 'fixture';
  const AIRCRAFT_HISTORY_TIMEOUT_MS = 4000;
  const AIRCRAFT_HISTORY_MAX_POINTS = 500;
  const AIRCRAFT_TRACK_KEEP_MS = 30 * 60 * 1000;
  const AIRCRAFT_TRAIL_GAP_MS = 90 * 1000;
  const AIRCRAFT_ICAO = ['abc123'];
  const A = {
    on: true, historyLoaded: false, historyLoading: false,
    tracks: new Map(), features: [],
  };
  globalThis.testAircraftState = A;
  let atLatest = true;
  const document = { hidden: false };
  const AbortController = class { constructor() { this.signal = {}; } abort() {} };
  const setTimeout = () => 1;
  const clearTimeout = () => {};
  Date.now = () => historyPayload.now;
  const fetch = async () => ({ ok: true, json: async () => historyPayload });
  const aircraftLoop = () => {};
`;

const loaded = loadInlineContext(
  'loadAircraftHistory',
  'function aircraftCurve',
  setup,
  { historyPayload },
);


test('la conservation couvre toute la trace de trente minutes', () => {
  assert.match(
    appSource,
    /const AIRCRAFT_TRACK_KEEP_MS = AIRCRAFT_TRAIL_MS;/,
  );
  assert.match(
    appSource,
    /const AIRCRAFT_HISTORY_MAX_POINTS = 500;/,
  );
});

test('l’historique amorce le cache de traces', async () => {
  await loaded.callable();

  const state = loaded.context.testAircraftState;
  assert.equal(state.historyLoaded, true);
  assert.deepEqual(plain(state.tracks.get('abc123')), [
    { coordinates: [2.1, 46.1], ts: 1_792_000 },
    { coordinates: [2.2, 46.2], ts: 1_796_000 },
  ]);
  assert.deepEqual(plain(state.features), []);
});

const frameSetup = `
  const AIRCRAFT_FRAME_MS = 50;
  const AIRCRAFT_DELAY_MS = 0;
  const AIRCRAFT_POINT_STALE_MS = 90 * 1000;
  const A = {
    on: true, raf: null, lastFrame: 0, clockOffset: 0, features: [],
    tracks: new Map([['abc123', [
      { coordinates: [2.1, 46.1], ts: 1_792_000 },
      { coordinates: [2.2, 46.2], ts: 1_796_000 },
    ]]]),
  };
  globalThis.testFrameState = A;
  let atLatest = true;
  const document = { hidden: false };
  Date.now = () => 1_800_000;
  const aircraftPose = () => null;
  const aircraftTrailCoordinates = track => track.map(point => point.coordinates);
  const aircraftSource = data => { globalThis.renderedAircraft = data; };
  const aircraftTrailsSource = data => { globalThis.renderedTrails = data; };
  const requestAnimationFrame = () => 1;
`;

const loadedFrame = loadInlineContext(
  'aircraftFrame',
  'function aircraftLoop',
  frameSetup,
);

test('une trace historique se peint sans position courante', () => {
  loadedFrame.callable(100);

  assert.deepEqual(plain(loadedFrame.context.renderedAircraft), {
    type: 'FeatureCollection',
    features: [],
  });
  assert.deepEqual(plain(loadedFrame.context.renderedTrails), {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [[2.1, 46.1], [2.2, 46.2]] },
      properties: { hex: 'abc123' },
    }],
  });
});
