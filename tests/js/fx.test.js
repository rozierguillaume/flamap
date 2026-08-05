import assert from 'node:assert/strict';
import test from 'node:test';

import { createSmokeController } from '../../js/fx/smoke.js';
import { createWindController } from '../../js/fx/wind.js';


function context() {
  return {
    beginPath() {}, clearRect() {}, createRadialGradient() {
      return { addColorStop() {} };
    },
    drawImage() {}, fillRect() {}, lineTo() {}, moveTo() {}, setTransform() {}, stroke() {},
  };
}

function canvas(width = 200, height = 100) {
  const ctx = context();
  return {
    clientWidth: width, clientHeight: height, hidden: false, width: 0, height: 0,
    getContext: () => ctx,
  };
}

test('les contrôleurs vent et fumée bornent le DPR et ne dupliquent pas leurs boucles', () => {
  const previous = {
    document: globalThis.document,
    devicePixelRatio: globalThis.devicePixelRatio,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
  };
  const scheduled = [], cancelled = [];
  let nextRaf = 0;
  globalThis.document = { hidden: false, createElement: () => canvas(96, 96) };
  globalThis.devicePixelRatio = 2;
  globalThis.requestAnimationFrame = callback => {
    scheduled.push(callback.name);
    return ++nextRaf;
  };
  globalThis.cancelAnimationFrame = id => cancelled.push(id);

  try {
    const bounds = {
      getWest: () => 0, getEast: () => 1, getSouth: () => 0, getNorth: () => 1,
    };
    const map = {
      getBounds: () => bounds,
      getCenter: () => ({ lng: .5, lat: .5 }),
      getZoom: () => 5,
    };
    const key = {
      classList: { toggle() {} }, hidden: false, style: { setProperty() {} }, title: '',
    };
    const value = { textContent: '' };
    const windCanvas = canvas();
    const order = [];
    const wind = createWindController({
      mobile: true, map, canvas: windCanvas, key, value,
      getManifest: () => null,
      onBadgeChange: () => order.push('temperature'),
      onFieldChange: () => order.push('smoke'),
    });
    wind.configure({
      bbox: [0, 0, 1, 1], nx: 2, ny: 2, nt: 2, t0: 0, dt: 3600,
      u: [[1, 1, 1, 1], [3, 3, 3, 3]],
      v: [[2, 2, 2, 2], [4, 4, 4, 4]],
      gust: [[20, 20, 20, 20], [40, 40, 40, 40]],
    });
    wind.resize();
    assert.deepEqual([windCanvas.width, windCanvas.height], [300, 150]);
    wind.setTime(1800);
    const out = {};
    assert.equal(wind.at(.5, .5, out), true);
    assert.deepEqual(out, { u: 2, v: 3, g: 30 });
    assert.deepEqual(order, ['temperature', 'smoke']);
    assert.equal(scheduled.length, 1);
    wind.loop();
    assert.equal(scheduled.length, 1);
    wind.setEnabled(false);
    assert.equal(cancelled.length, 1);

    const smokeCanvas = canvas();
    const smoke = createSmokeController({
      mobile: true,
      canvas: smokeCanvas,
      windAt: (_lon, _lat, target) => {
        Object.assign(target, { u: 1, v: 1, g: 20 });
        return true;
      },
      getWindProjection: target => Object.assign(target, {
        current: true, lon0: 0, dLon: .01, y0: 0, dY: .01,
      }),
      getState: () => ({
        atLatest: true, lastObservedTime: 100, steps: [100],
        layerVisibility: { hotspots: { VIIRS: true } },
      }),
      isPlaying: () => false,
    });
    smoke.configureOverview([{
      geometry: { coordinates: [.5, .5] },
      properties: { ts: 100, source: 'VIIRS', n: 1, frp: 1, overview: true },
    }]);
    smoke.resize();
    assert.deepEqual([smokeCanvas.width, smokeCanvas.height], [250, 125]);
    smoke.setTime(100, true, true);
    assert.equal(scheduled.length, 2);
    smoke.loop();
    assert.equal(scheduled.length, 2);
    smoke.setEnabled(false);
    assert.equal(smokeCanvas.hidden, true);
    assert.equal(cancelled.length, 2);
  } finally {
    globalThis.document = previous.document;
    globalThis.devicePixelRatio = previous.devicePixelRatio;
    globalThis.requestAnimationFrame = previous.requestAnimationFrame;
    globalThis.cancelAnimationFrame = previous.cancelAnimationFrame;
  }
});

function grid(bbox, u) {
  return {
    bbox, nx: 2, ny: 2, nt: 2, t0: 0, dt: 3600,
    u: [[u, u, u, u], [u, u, u, u]],
    v: [[0, 0, 0, 0], [0, 0, 0, 0]],
    gust: [[10, 10, 10, 10], [10, 10, 10, 10]],
  };
}

test('les champs de vent régionaux couvrent chacun leur emprise, le premier prime', () => {
  const previous = {
    document: globalThis.document,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
  };
  globalThis.document = { hidden: true, createElement: () => canvas(96, 96) };
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};

  try {
    const map = {
      getBounds: () => ({
        getWest: () => 0, getEast: () => 1, getSouth: () => 0, getNorth: () => 1,
      }),
      getCenter: () => ({ lng: .5, lat: .5 }),
      getZoom: () => 5,
    };
    const wind = createWindController({
      mobile: true, map, canvas: canvas(),
      key: { classList: { toggle() {} }, hidden: false,
             style: { setProperty() {} }, title: '' },
      value: { textContent: '' },
      getManifest: () => null,
    });
    // Les deux emprises se recouvrent entre 1 et 2 : c'est la bande où les
    // domaines des modèles se chevauchent, et le champ de référence l'emporte.
    wind.configure(grid([0, 0, 2, 2], 5));
    wind.addField(grid([1, 0, 4, 2], 9));
    wind.setTime(0);

    const out = {};
    assert.equal(wind.at(.5, 1, out), true);
    assert.equal(out.u, 5);
    assert.equal(wind.at(1.5, 1, out), true);
    assert.equal(out.u, 5, 'la bande commune revient au champ de référence');
    assert.equal(wind.at(3, 1, out), true);
    assert.equal(out.u, 9, 'la région voisine reste couverte');
    assert.equal(wind.at(9, 1, out), false);
    assert.equal(wind.hasCurrent(), true);

    // Le champ tardif doit être amené au cran déjà affiché, sans nouveau setTime.
    const late = createWindController({
      mobile: true, map, canvas: canvas(),
      key: { classList: { toggle() {} }, hidden: false,
             style: { setProperty() {} }, title: '' },
      value: { textContent: '' },
      getManifest: () => null,
    });
    late.configure(grid([0, 0, 2, 2], 5));
    late.setTime(1800);
    late.addField(grid([2, 0, 4, 2], 9));
    assert.equal(late.at(3, 1, out), true);
    assert.equal(out.u, 9);
  } finally {
    globalThis.document = previous.document;
    globalThis.requestAnimationFrame = previous.requestAnimationFrame;
    globalThis.cancelAnimationFrame = previous.cancelAnimationFrame;
  }
});
