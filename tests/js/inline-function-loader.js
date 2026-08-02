import fs from 'node:fs';
import vm from 'node:vm';


const source = fs.readFileSync(
  new URL('../../index.html', import.meta.url),
  'utf8',
);

/**
 * Charge une fonction pure du monolithe sans exécuter le navigateur entier.
 * Les marqueurs rendent la copie impossible : le test évalue bien la source
 * courante et échoue explicitement quand l'extraction future la déplace.
 */
export function loadInlineContext(name, endMarker, setup = '', globals = {}) {
  const starts = [
    source.indexOf(`function ${name}(`),
    source.indexOf(`async function ${name}(`),
  ].filter(index => index >= 0);
  const start = starts.length ? Math.min(...starts) : -1;
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end < 0) {
    throw new Error(`fonction inline introuvable : ${name}`);
  }
  const context = { ...globals };
  vm.runInNewContext(
    `${setup}\n${source.slice(start, end)}\nglobalThis.loaded = ${name};`,
    context,
    { filename: 'index.html' },
  );
  return { callable: context.loaded, context };
}

export function loadInlineFunction(name, endMarker, setup = '', globals = {}) {
  return loadInlineContext(name, endMarker, setup, globals).callable;
}

export function plain(value) {
  return JSON.parse(JSON.stringify(value));
}
