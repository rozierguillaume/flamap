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
import { createWeatherController, weatherCoordinates } from '../../js/features/weather.js';


const colors = { front: '#1', hot: '#2', recent: '#3', old: '#4' };

function fakeElement() {
  const classes = new Set();
  const attributes = new Map();
  return {
    attributes,
    classList: {
      add: (...names) => names.forEach(name => classes.add(name)),
      contains: name => classes.has(name),
      remove: (...names) => names.forEach(name => classes.delete(name)),
      toggle(name, force) {
        const enabled = force === undefined ? !classes.has(name) : force;
        if (enabled) classes.add(name); else classes.delete(name);
        return enabled;
      },
    },
    addEventListener() {},
    focus() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 430, height: 424 }),
    hidden: false,
    innerHTML: '',
    querySelector: () => null,
    setAttribute: (name, value) => attributes.set(name, String(value)),
    style: { left: '', top: '' },
    textContent: '',
    title: '',
  };
}

function weatherHarness({ loadJson, fetchImpl, gridValueAt = () => null } = {}) {
  const elements = Object.fromEntries([
    'panel', 'button', 'chart', 'tip', 'place', 'status', 'title', 'follow',
    'close', 'incidents', 'credits', 'creditsButton', 'layers', 'layersButton',
  ].map(name => [name, fakeElement()]));
  const mapListeners = [];
  const tempKey = fakeElement(), tempValue = fakeElement();
  const controller = createWeatherController({
    map: {
      getCenter: () => ({ lng: .5, lat: .5 }),
      on: (name, listener) => mapListeners.push([name, listener]),
    },
    maplibregl: { LngLat: { convert: value => value }, Marker: class {} },
    loadJson,
    fetchImpl,
    cardinals: Array(16).fill('nord'),
    fmt: value => String(value),
    getManifest: () => null,
    gridValueAt,
    getWindTime: () => 150,
    legacyTemperatureAt: () => 23,
    temperatureMetadata: () => ({ dated: true, ts: 100 }),
    getTempKey: () => tempKey,
    getTempValue: () => tempValue,
    closeUpdates() {},
    isActivityOpen: () => false,
    closeActivity() {},
    trackUsage() {},
    elements,
  });
  return { controller, elements, mapListeners, tempKey, tempValue };
}

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

test('le contrôleur météo conserve coordonnées, cache et listener de déplacement', async () => {
  const urls = [];
  const { controller, mapListeners } = weatherHarness({
    loadJson: async () => assert.fail('chargement météo inattendu'),
    fetchImpl: async url => {
      urls.push(String(url));
      return {
        ok: true,
        json: async () => ({ features: [{ properties: { city: 'Paris' } }] }),
      };
    },
  });

  assert.equal(weatherCoordinates({ lng: -1.25, lat: 44.5 }), '44.500° N, 1.250° O');
  assert.equal(await controller.communeAt(2.3522, 48.8566), 'Paris');
  assert.equal(await controller.communeAt(2.3522, 48.8566), 'Paris');
  assert.equal(urls.length, 1);
  assert.match(urls[0], /lon=2\.352200&lat=48\.856600&limit=1/);
  assert.deepEqual(mapListeners.map(([name]) => name), ['moveend']);
});

test('le contrôleur météo charge les deux grilles une fois et garde les replis', async () => {
  const requested = [];
  const thermal = {
    bbox: [0, 0, 1, 1], nx: 2, ny: 2, nt: 2, t0: 100, dt: 100,
    temperature: [[10, 10, 10, 10], [20, 20, 20, 20]],
    precipitation: [[0, 0, 0, 0], [1, 1, 1, 1]],
  };
  const forecast = {
    bbox: [0, 0, 1, 1], nx: 2, ny: 2, nt: 2, t0: 100, dt: 100,
    u: [[1, 1, 1, 1], [1, 1, 1, 1]],
    v: [[1, 1, 1, 1], [1, 1, 1, 1]],
    gust: [[10, 10, 10, 10], [10, 10, 10, 10]],
  };
  const { controller, elements, tempValue } = weatherHarness({
    loadJson: async url => {
      requested.push(url);
      return url.includes('thermal') ? thermal : forecast;
    },
    fetchImpl: async () => assert.fail('géocodage inattendu'),
  });

  controller.startData();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(requested, [
    'data/weather_forecast.json?v=4',
    'data/thermal.json',
  ]);
  assert.equal(controller.temperatureAt(.5, .5), 15);
  assert.equal(controller.temperatureAt(2, 2), 23);
  assert.equal(tempValue.textContent, '15 °C');
  controller.setOpen(true);
  assert.match(elements.chart.innerHTML, /class="temp-line"/);
  assert.match(elements.chart.innerHTML, /class="gust-line"/);
  assert.match(elements.chart.innerHTML, /class="precip-bar/);
  assert.match(elements.chart.attributes.get('aria-label'), /Historique et prévisions météo/);
});
