import assert from 'node:assert/strict';
import test from 'node:test';

import { createBaseStyle } from '../../js/map/base-style.js';
import { createMap } from '../../js/map/create-map.js';

test('le style de base conserve les sources et couches dans leur ordre', () => {
  const style = createBaseStyle();
  assert.deepEqual(Object.keys(style.sources), ['sat', 'ortho', 'toponyms']);
  assert.deepEqual(style.layers.map(layer => layer.id), [
    'sat', 'ortho', 'label-water-point', 'label-water-line', 'label-country',
    'label-state', 'label-city', 'label-town', 'label-village', 'label-local',
    'label-road',
  ]);
  assert.equal(style.glyphs, 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf');
});

test('la création de carte conserve options et contrôle desktop', () => {
  const controls = [];
  let rotationDisabled = false;
  class Map {
    constructor(options) {
      this.options = options;
      this.touchZoomRotate = { disableRotation: () => { rotationDisabled = true; } };
    }
    addControl(control, position) { controls.push([control, position]); }
  }
  class NavigationControl {
    constructor(options) { this.options = options; }
  }
  const map = createMap({ maplibregl: { Map, NavigationControl }, mobile: false });
  assert.equal(map.options.container, 'map');
  assert.equal(map.options.hash, 'map');
  assert.deepEqual(map.options.center, [2.2, 46.5]);
  assert.equal(map.options.zoom, 5);
  assert.equal(controls.length, 1);
  assert.equal(controls[0][1], 'top-right');
  assert.deepEqual(controls[0][0].options, { showCompass: false });
  assert.equal(rotationDisabled, true);
});

test('la création mobile omet uniquement le contrôle de navigation', () => {
  let controls = 0;
  class Map {
    constructor() { this.touchZoomRotate = { disableRotation() {} }; }
    addControl() { controls++; }
  }
  createMap({
    maplibregl: { Map, NavigationControl: class {} },
    mobile: true,
  });
  assert.equal(controls, 0);
});
