import assert from 'node:assert/strict';
import test from 'node:test';

import { createPanelManager } from '../../js/ui/panel-manager.js';
import { createPopupRouter } from '../../js/ui/popup-router.js';

test('le gestionnaire de panneaux ferme les autres avant d’activer le nouveau', () => {
  const manager = createPanelManager();
  const calls = [];
  manager.activate('weather', () => calls.push('close-others'));
  assert.deepEqual(calls, ['close-others']);
  assert.equal(manager.isActive('weather'), true);
  manager.deactivate('weather');
  assert.equal(manager.isActive('weather'), false);
});

test('le routeur respecte la priorité et ignore les objets transparents', () => {
  const oldPoint = { layer: { id: 'hotspots' }, properties: { ts: 100 } };
  const burnt = { layer: { id: 'burnt-fill' }, properties: {} };
  const map = {
    getLayer: () => true,
    queryRenderedFeatures: point => Array.isArray(point[0]) ? [oldPoint] : [burnt],
  };
  const calls = [];
  const router = createPopupRouter({
    map,
    mobile: false,
    layers: ['hotspots', 'burnt-fill'],
    isPointLayer: id => id === 'hotspots',
    isAlwaysVisible: () => false,
    getAtLatest: () => false,
    getShownTime: () => 1000,
    maxAge: 100,
    onGround: () => calls.push('ground'),
    onFeature: hit => calls.push(hit.id),
  });
  assert.equal(router.target({ point: { x: 1, y: 2 } }), null);
  router.click({ point: { x: 1, y: 2 } });
  assert.deepEqual(calls, ['ground']);
});

test('le routeur choisit la première couche visible dans l’ordre déclaré', () => {
  const second = { layer: { id: 'second' }, properties: { ts: 950 } };
  const first = { layer: { id: 'first' }, properties: { ts: 950 } };
  const map = {
    getLayer: () => true,
    queryRenderedFeatures: () => [second, first],
  };
  const router = createPopupRouter({
    map,
    mobile: false,
    layers: ['first', 'second'],
    isPointLayer: () => true,
    isAlwaysVisible: () => false,
    getAtLatest: () => true,
    getShownTime: () => 1000,
    maxAge: 100,
    onGround: () => {},
    onFeature: () => {},
  });
  assert.equal(router.target({ point: { x: 1, y: 2 } }).id, 'first');
});
