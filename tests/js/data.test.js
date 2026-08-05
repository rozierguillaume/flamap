import assert from 'node:assert/strict';
import test from 'node:test';

import { EMPTY, json } from '../../js/data/client.js';
import { loadInitialData, loadRegionalWind } from '../../js/data/initial.js';
import {
  createZonesController,
  mergedZones,
  visibleZoneIds,
} from '../../js/data/zones.js';


const collection = features => ({ type: 'FeatureCollection', features });
const feature = id => ({ properties: id ? { _id: id } : {}, geometry: null });
const bounds = (west, south, east, north) => ({
  getWest: () => west,
  getSouth: () => south,
  getEast: () => east,
  getNorth: () => north,
});

function zone(id) {
  return {
    id,
    hotspots: collection([feature(`hot-${id}`)]),
    burnt_dated: collection([feature('shared'), feature(`dated-${id}`)]),
    burnt_nrt: collection([feature('shared'), feature(`nrt-${id}`)]),
    wind: { id },
  };
}

function controllerHarness({ loadJson, cacheLimit = 20 } = {}) {
  let viewport = { zoom: 8, bounds: bounds(0, 0, 1, 1) };
  let sourceReady = true;
  const calls = [];
  const controller = createZonesController({
    loadJson,
    cacheLimit,
    getViewport: () => viewport,
    hasDetailSource: () => sourceReady,
    setLoading: value => calls.push(['loading', value]),
    clearDetail: reason => calls.push(['clear', reason]),
    applyDetail: detail => calls.push(['apply', detail]),
    afterDetail: () => calls.push(['after']),
    warn: (...args) => calls.push(['warn', ...args]),
  });
  return {
    calls,
    controller,
    setViewport(value) { viewport = value; },
    setSourceReady(value) { sourceReady = value; },
  };
}

test('json conserve les erreurs HTTP et le décodage JSON', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async url => ({
      ok: url === 'ok.json',
      status: 404,
      json: async () => ({ url }),
    });
    assert.deepEqual(await json('ok.json'), { url: 'ok.json' });
    await assert.rejects(json('missing.json'), /404 missing\.json/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('le chargement initial conserve l’ordre et le repli PSFDF facultatif', async () => {
  const urls = [];
  const payloads = new Map([
    ['data/manifest.json', { zones: [] }],
    ['data/overview_hotspots.geojson', collection([])],
    ['data/burnt_recent.geojson', collection([])],
    ['data/timeline.json', [{ ts: 1 }]],
    ['data/wind_coarse.json?v=2', { nt: 2 }],
  ]);
  const data = await loadInitialData(() => assert.fail('repli legacy inattendu'), async url => {
    urls.push(url);
    if (url === 'data/psfdf_fires.geojson') throw new Error('absent');
    return payloads.get(url);
  });

  assert.deepEqual(urls, [
    'data/manifest.json',
    'data/overview_hotspots.geojson',
    'data/burnt_recent.geojson',
    'data/psfdf_fires.geojson',
    'data/timeline.json',
    'data/wind_coarse.json?v=2',
  ]);
  assert.equal(data.psfdf, EMPTY);
  assert.equal(data.detail, null);
});

test('le chargement initial retombe sur le mode legacy complet', async () => {
  const hotspots = collection([feature('hot')]);
  const dated = collection([feature('dated')]);
  const urls = [];
  const data = await loadInitialData((hot, burnt) => {
    assert.equal(hot, hotspots);
    assert.equal(burnt, dated);
    return [{ ts: 42 }];
  }, async url => {
    urls.push(url);
    if (url === 'data/manifest.json') throw new Error('nouveau format absent');
    const values = {
      'data/burnt_nrt.geojson': collection([feature('nrt')]),
      'data/burnt_dated.geojson': dated,
      'data/hotspots.geojson': hotspots,
      'data/meta.json': { bbox: [1, 2, 3, 4], generated_at: '2026-08-02' },
    };
    if (url === 'data/wind.json') throw new Error('vent absent');
    return values[url];
  });

  assert.equal(data.manifest.legacy, true);
  assert.equal(data.manifest.detail_zoom, 99);
  assert.deepEqual(data.timeline, [{ ts: 42 }]);
  assert.equal(data.wind, null);
  assert.equal(data.detail.hotspots, hotspots);
  assert.deepEqual(urls.slice(-5), [
    'data/burnt_nrt.geojson', 'data/burnt_dated.geojson',
    'data/hotspots.geojson', 'data/meta.json', 'data/wind.json',
  ]);
});

test('les zones visibles sont bornées et la fusion déduplique les périmètres', () => {
  const manifest = { detail_zoom: 7, bbox: [-1, 0, 3, 2] };
  const available = new Set(['x-01_y+00', 'x+00_y+00', 'x+01_y+00']);
  assert.deepEqual(visibleZoneIds(
    manifest, available, 8, bounds(-2, -1, 0.9, 1),
  ), ['x-01_y+00', 'x+00_y+00']);
  assert.deepEqual(visibleZoneIds(
    manifest, available, 6, bounds(-2, -1, 1.2, 1),
  ), []);

  const merged = mergedZones([zone('a'), zone('b')], 'burnt_dated', true);
  assert.deepEqual(merged.features.map(item => item.properties._id), [
    'shared', 'dated-a', 'dated-b',
  ]);
});

test('le détail applique les mêmes collections MapLibre dans le même ordre', async () => {
  const harness = controllerHarness({ loadJson: async url =>
    zone(url.includes('x+00') ? 'west' : 'east') });
  harness.controller.configure({
    detail_zoom: 7, bbox: [0, 0, 2, 1],
    zones: ['x+00_y+00', 'x+01_y+00'], zone_template: '/{id}.json',
  });
  harness.setViewport({ zoom: 8, bounds: bounds(0, 0, 2, 1) });

  await harness.controller.loadVisibleZones();

  assert.deepEqual(harness.calls.map(call => call[0]), [
    'loading', 'apply', 'loading', 'after',
  ]);
  const detail = harness.calls[1][1];
  assert.deepEqual(detail.hotspots.features.map(item => item.properties._id), [
    'hot-west', 'hot-east',
  ]);
  assert.deepEqual(
    detail.merge('burnt_dated', true).features.map(item => item.properties._id),
    ['shared', 'dated-west', 'dated-east'],
  );
  assert.deepEqual(
    detail.merge('burnt_nrt', true).features.map(item => item.properties._id),
    ['shared', 'nrt-west', 'nrt-east'],
  );
});

test('une zone absente vide le détail courant et sort la promesse du cache', async () => {
  let attempts = 0;
  const harness = controllerHarness({ loadJson: async () => {
    attempts++;
    throw new Error('404');
  } });
  harness.controller.configure({
    detail_zoom: 7, bbox: [0, 0, 1, 1], zones: ['x+00_y+00'],
    zone_template: 'data/zones/{id}.json',
  });

  await harness.controller.loadVisibleZones();
  await harness.controller.loadVisibleZones();

  assert.equal(attempts, 2);
  assert.deepEqual(harness.calls.map(call => call[0]), [
    'loading', 'warn', 'clear', 'loading', 'after',
    'loading', 'warn', 'clear', 'loading', 'after',
  ]);
  assert.equal(harness.controller.getHotspots().length, 0);
});

test('un mouvement rapide écarte le chargement devenu ancien', async () => {
  const pending = new Map();
  const harness = controllerHarness({ loadJson: url => new Promise((resolve, reject) => {
    pending.set(url, { resolve, reject });
  }) });
  harness.controller.configure({
    detail_zoom: 7, bbox: [0, 0, 2, 1],
    zones: ['x+00_y+00', 'x+01_y+00'], zone_template: '/{id}.json',
  });

  const first = harness.controller.loadVisibleZones();
  harness.setViewport({ zoom: 8, bounds: bounds(1, 0, 2, 1) });
  const second = harness.controller.loadVisibleZones();
  pending.get('/x+01_y+00.json').resolve(zone('second'));
  await second;
  pending.get('/x+00_y+00.json').resolve(zone('first'));
  await first;

  const applied = harness.calls.filter(call => call[0] === 'apply');
  assert.equal(applied.length, 1);
  assert.equal(applied[0][1].zones[0].id, 'second');
  assert.deepEqual(harness.controller.getHotspots().map(item => item.properties._id), [
    'hot-second',
  ]);
});

test('le cache reste LRU et borné hors des zones visibles', async () => {
  const requests = [];
  const harness = controllerHarness({
    cacheLimit: 2,
    loadJson: async url => {
      requests.push(url);
      return zone(url);
    },
  });
  harness.controller.configure({
    detail_zoom: 7, bbox: [0, 0, 3, 1],
    zones: ['x+00_y+00', 'x+01_y+00', 'x+02_y+00'], zone_template: '/{id}',
  });

  for (let x = 0; x < 3; x++) {
    harness.setViewport({ zoom: 8, bounds: bounds(x, 0, x + 1, 1) });
    await harness.controller.loadVisibleZones();
  }
  harness.setViewport({ zoom: 8, bounds: bounds(0, 0, 1, 1) });
  await harness.controller.loadVisibleZones();

  assert.equal(requests.length, 4);
  assert.equal(requests.at(-1), '/x+00_y+00');
});

test('le mode legacy et une source absente ne chargent aucune zone', async () => {
  let requests = 0;
  const harness = controllerHarness({ loadJson: async () => { requests++; } });
  harness.controller.configure({
    legacy: true, detail_zoom: 99, bbox: [0, 0, 1, 1], zones: [], zone_template: '',
  });
  await harness.controller.loadVisibleZones();
  harness.controller.configure({
    detail_zoom: 7, bbox: [0, 0, 1, 1], zones: ['x+00_y+00'], zone_template: '/{id}',
  });
  harness.setSourceReady(false);
  await harness.controller.loadVisibleZones();

  assert.equal(requests, 0);
  assert.deepEqual(harness.calls, []);
});

test('les champs de vent régionaux suivent le manifeste, sauf celui de référence', async () => {
  const urls = [];
  const manifest = {
    wind_fields: [
      { file: 'wind_coarse.json' },
      { file: 'wind_coarse_es.json' },
      { file: 'wind_coarse_absent.json' },
    ],
  };
  const fields = await loadRegionalWind(manifest, async url => {
    urls.push(url);
    if (url === 'data/wind_coarse_absent.json') throw new Error('absent');
    return { nt: 2 };
  });

  assert.deepEqual(urls,
    ['data/wind_coarse_es.json', 'data/wind_coarse_absent.json']);
  assert.deepEqual(fields, [{ nt: 2 }, null]);
  assert.deepEqual(await loadRegionalWind({}, () => assert.fail('aucun champ')), []);
  assert.deepEqual(await loadRegionalWind(null, () => assert.fail('aucun champ')), []);
});
