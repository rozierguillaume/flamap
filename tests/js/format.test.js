import assert from 'node:assert/strict';
import test from 'node:test';

import { ago, confidenceText, fmt, fmtClock, nf } from '../../js/util/format.js';


const timestamp = Date.parse('2026-08-02T12:34:00Z') / 1000;

test('fmt et fmtClock conservent les libellés Europe/Paris', () => {
  assert.equal(fmt(timestamp), '02/08 14:34');
  assert.equal(fmtClock(timestamp), 'dimanche 2 août à 14:34');
});

test('nf conserve le format numérique français et la précision maximale', () => {
  assert.equal(nf(1234.56, 1), '1 234,6');
  assert.equal(nf(12.9), '13');
});

test('ago conserve ses seuils et arrondis', () => {
  assert.equal(ago(NaN), '');
  assert.equal(ago(-1), '');
  assert.equal(ago(89), "à l'instant");
  assert.equal(ago(90), 'il y a 2 min');
  assert.equal(ago(3660), 'il y a 1 h');
  assert.equal(ago(5 * 3600 + 50 * 60), 'il y a 5 h');
  assert.equal(ago(25 * 3600), 'il y a 1 jour');
  assert.equal(ago(48 * 3600), 'il y a 2 jours');
});

test('confidenceText conserve les classes FIRMS et les pourcentages MODIS', () => {
  assert.equal(confidenceText('n'), 'confiance nominale');
  assert.equal(confidenceText('HIGH'), 'confiance haute');
  assert.equal(confidenceText('72'), 'confiance 72 %');
  assert.equal(confidenceText(''), '');
  assert.equal(confidenceText(null), '');
});
