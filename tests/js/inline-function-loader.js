import fs from 'node:fs';
import vm from 'node:vm';


const source = fs.readFileSync(
  new URL('../../js/main.js', import.meta.url),
  'utf8',
);

/**
 * Charge une fonction pure du monolithe sans exécuter le navigateur entier.
 * Les marqueurs rendent la copie impossible : le test évalue bien la source
 * courante et échoue explicitement quand l'extraction future la déplace.
 */
export function loadInlineContext(name, endMarker, setup = '', globals = {}, sourceText = source) {
  const starts = [
    sourceText.indexOf(`function ${name}(`),
    sourceText.indexOf(`async function ${name}(`),
  ].filter(index => index >= 0);
  const start = starts.length ? Math.min(...starts) : -1;
  const end = sourceText.indexOf(endMarker, start);
  if (start < 0 || end < 0) {
    throw new Error(`fonction du monolithe introuvable : ${name}`);
  }
  const context = { ...globals };
  vm.runInNewContext(
    `${setup}\n${sourceText.slice(start, end)}\nglobalThis.loaded = ${name};`,
    context,
    { filename: 'js/main.js' },
  );
  return { callable: context.loaded, context };
}

export function loadInlineFunction(name, endMarker, setup = '', globals = {}) {
  return loadInlineContext(name, endMarker, setup, globals).callable;
}

export function plain(value) {
  return JSON.parse(JSON.stringify(value));
}
