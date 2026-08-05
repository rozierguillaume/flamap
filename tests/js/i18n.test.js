import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { LANGS, detectLang, plural, setLang, t } from '../../js/i18n.js';
import { STRINGS } from '../../js/strings.js';


const ROOT = new URL('../../', import.meta.url);
const HTML_PAGES = ['index.html', 'archives.html'];
const JS_ROOTS = ['js'];

function walk(directory) {
  const entries = fs.readdirSync(new URL(directory, ROOT), { withFileTypes: true });
  return entries.flatMap(entry => (entry.isDirectory()
    ? walk(`${directory}/${entry.name}`)
    : entry.name.endsWith('.js') ? [`${directory}/${entry.name}`] : []));
}

const read = name => fs.readFileSync(new URL(name, ROOT), 'utf8');

test('chaque entrée porte les deux langues et les mêmes champs', () => {
  for (const [key, entry] of Object.entries(STRINGS)) {
    for (const lang of LANGS) {
      assert.ok(entry[lang] !== undefined, `${key} : ${lang} manquant`);
    }
    const forms = value => (typeof value === 'string'
      ? [value] : Object.values(value));
    // Un champ absent d'une traduction produirait un texte tronqué en silence.
    const fields = value => new Set(forms(value)
      .flatMap(text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1])));
    const reference = fields(entry[LANGS[0]]);
    for (const lang of LANGS.slice(1)) {
      assert.deepEqual([...fields(entry[lang])].sort(), [...reference].sort(),
        `${key} : champs différents entre ${LANGS[0]} et ${lang}`);
    }
    // Les deux langues ont soit une forme unique, soit un singulier et un pluriel.
    for (const lang of LANGS) {
      const value = entry[lang];
      if (typeof value !== 'string')
        assert.deepEqual(Object.keys(value).sort(), ['one', 'other'],
          `${key} : formes plurielles incomplètes en ${lang}`);
    }
  }
});

test('toutes les clés employées par le front existent', () => {
  const used = new Set();
  for (const page of HTML_PAGES) {
    const html = read(page);
    for (const match of html.matchAll(/data-i18n(?:-\w+)?="([^"]+)"/g))
      used.add(match[1]);
  }
  for (const directory of JS_ROOTS) {
    for (const file of walk(directory)) {
      if (file.endsWith('/strings.js')) continue;
      for (const match of read(file).matchAll(/\bt\('([\w.À-ſ -]+)'/g))
        used.add(match[1]);
    }
  }
  assert.ok(used.size > 100, 'inventaire des clés vraisemblablement incomplet');
  const missing = [...used].filter(key => !(key in STRINGS));
  assert.deepEqual(missing, []);
});

test('la détection suit le choix, puis le domaine, puis le navigateur', () => {
  const base = { search: '', hostname: 'flamap.fr', languages: ['fr-FR'], stored: null };
  assert.equal(detectLang(base), 'fr');
  assert.equal(detectLang({ ...base, search: '?lang=es' }), 'es');
  // Un choix explicite prime sur le domaine comme sur le navigateur.
  assert.equal(detectLang({ ...base, hostname: 'flamap.es', stored: 'fr' }), 'fr');
  assert.equal(detectLang({ ...base, search: '?lang=fr', stored: 'es' }), 'fr');
  assert.equal(detectLang({ ...base, hostname: 'flamap.es' }), 'es');
  assert.equal(detectLang({ ...base, hostname: 'www.flamap.es' }), 'es');
  assert.equal(detectLang({ ...base, languages: ['es-419', 'en'] }), 'es');
  assert.equal(detectLang({ ...base, languages: ['de', 'en-GB'] }), 'fr');
  // `?lang=` inconnu ou vide ne doit pas court-circuiter la suite.
  assert.equal(detectLang({ ...base, search: '?lang=de', hostname: 'flamap.es' }), 'es');
});

test('le pluriel suit la règle de chaque langue', () => {
  setLang('fr');
  assert.equal(plural(0), 'one');
  assert.equal(plural(1), 'one');
  assert.equal(plural(2), 'other');
  setLang('es');
  assert.equal(plural(0), 'other');
  assert.equal(plural(1), 'one');
  setLang('fr');
});

test('t() substitue les champs et choisit la forme', () => {
  setLang('fr');
  assert.equal(t('activity.count', { n: 1, count: '1' }), '1 foyer');
  assert.equal(t('activity.count', { n: 4, count: '4' }), '4 foyers');
  setLang('es');
  assert.equal(t('activity.count', { n: 0, count: '0' }), '0 focos');
  assert.equal(t('legend.title'), 'Leyenda');
  setLang('fr');
  // Une clé absente se voit à l'écran plutôt que de laisser un texte vide.
  assert.equal(t('clé.inexistante'), 'clé.inexistante');
});
