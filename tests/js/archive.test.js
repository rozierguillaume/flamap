import assert from 'node:assert/strict';
import test from 'node:test';

import { fitBoundsFor, toBurnt, toHotspots } from '../../js/archive/adapt.js';


const FIRMS = [
  { lon: 6.09, lat: 43.49, ts: 200, source: 'VIIRS/NOAA-20', brightness: 331.2,
    frp: 4.8, confidence: 'nominal', daynight: 'D', scan: .42, track: .39 },
  { lon: 6.08, lat: 43.48, ts: 100, source: 'MODIS', frp: 2.1, confidence: '72' },
];

const EFFIS = [
  { id: 'd-abc123', ts: 1785700000, lu: 1785744000, area_ha: 1850.0, country: 'FR',
    props: { COMMUNE: 'Correns', PROVINCE: 'Var', CLASS: '7DAYS', CONIFER: 62 },
    geometry: { type: 'MultiPolygon', coordinates: [] } },
];

test('toHotspots convertit les détections en points GeoJSON triés par date', () => {
  const fc = toHotspots(FIRMS);
  assert.equal(fc.type, 'FeatureCollection');
  assert.equal(fc.features.length, 2);
  // triées par ts croissant, même si l'entrée ne l'était pas
  assert.equal(fc.features[0].properties.ts, 100);
  assert.equal(fc.features[1].properties.ts, 200);
  assert.deepEqual(fc.features[0].geometry, { type: 'Point', coordinates: [6.08, 43.48] });
  assert.equal(fc.features[1].properties.source, 'VIIRS/NOAA-20');
  assert.equal(fc.features[1].properties.frp, 4.8);
});

test('toHotspots renvoie une collection vide sans détection', () => {
  assert.deepEqual(toHotspots([]), { type: 'FeatureCollection', features: [] });
  assert.deepEqual(toHotspots(undefined), { type: 'FeatureCollection', features: [] });
});

test('toBurnt reporte la surface, les dates et les attributs EFFIS bruts', () => {
  const fc = toBurnt(EFFIS);
  assert.equal(fc.features.length, 1);
  const p = fc.features[0].properties;
  assert.equal(p.AREA_HA, 1850.0);
  assert.equal(p.ts, 1785700000);
  assert.equal(p.lu, 1785744000);
  assert.equal(p.COMMUNE, 'Correns');
  assert.equal(p.CONIFER, 62);
  assert.deepEqual(fc.features[0].geometry, EFFIS[0].geometry);
});

test('fitBoundsFor renvoie un rectangle centré et généreux', () => {
  const [[west, south], [east, north]] = fitBoundsFor([6.08, 43.49], 10);
  assert.ok(west < 6.08 && east > 6.08);
  assert.ok(south < 43.49 && north > 43.49);
  // marge de 15 % au-delà du rayon fourni, pas un cadrage serré
  const halfWidthKm = (east - west) / 2 * 111.32 * Math.cos(43.49 * Math.PI / 180);
  assert.ok(halfWidthKm > 10 && halfWidthKm < 13);
});
