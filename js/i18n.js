import { STRINGS } from './strings.js';


/* =====================================================================
 * LANGUE — choix, textes et conventions de format
 *
 * Le site est statique : aucune négociation de contenu n'est possible côté
 * serveur, tout se décide dans le navigateur. La langue est donc arrêtée une
 * fois pour toutes au chargement, et en changer recharge la page — les fiches,
 * les graphiques et les infobulles sont fabriqués à la volée, les retraduire
 * en place demanderait de tenir un inventaire de tout ce qui est déjà à
 * l'écran.
 *
 * Ce module ne touche pas au DOM : il est importé par `util/format.js` comme
 * par les contrôleurs. La traduction des pages est le travail de
 * `ui/translate.js`, qui est seul à connaître le document.
 * ===================================================================== */

export const LANGS = ['fr', 'es'];
export const DEFAULT_LANG = 'fr';
export const LANG_STORAGE_KEY = 'flamap-lang';

/* Espagne péninsulaire et France partagent CET/CEST : le fuseau ne change pas
 * les heures affichées, seulement la façon de les nommer dans les crédits et
 * les exports. Les Canaries ne sont pas collectées (voir `REGIONS`). */
const LOCALES = {
  fr: { locale: 'fr-FR', timeZone: 'Europe/Paris', timeZoneName: 'Paris' },
  es: { locale: 'es-ES', timeZone: 'Europe/Madrid', timeZoneName: 'Madrid' },
};

const store = () => {
  try {
    return globalThis.localStorage || null;
  } catch (_) {
    // Stockage refusé (mode privé strict, cookies bloqués) : la détection
    // automatique reste entièrement fonctionnelle sans lui.
    return null;
  }
};

export function readStoredLang() {
  const saved = store()?.getItem(LANG_STORAGE_KEY);
  return LANGS.includes(saved) ? saved : null;
}

/* Ordre volontaire : un choix explicite prime toujours sur une déduction.
 * Le domaine passe avant le navigateur — quelqu'un qui ouvre flamap.es
 * demande la version espagnole, quelle que soit la langue de son téléphone. */
export function detectLang({
  search = globalThis.location?.search ?? '',
  hostname = globalThis.location?.hostname ?? '',
  languages = globalThis.navigator?.languages
    || [globalThis.navigator?.language || ''],
  stored = readStoredLang(),
} = {}) {
  const asked = new URLSearchParams(search).get('lang');
  if (LANGS.includes(asked)) return asked;
  if (stored) return stored;
  if (/(^|\.)flamap\.es$/i.test(hostname)) return 'es';
  for (const tag of languages) {
    const base = String(tag || '').toLowerCase().split('-')[0];
    if (LANGS.includes(base)) return base;
  }
  return DEFAULT_LANG;
}

let lang = detectLang();

export const getLang = () => lang;
export const getLocale = () => LOCALES[lang].locale;
export const getTimeZone = () => LOCALES[lang].timeZone;
export const getTimeZoneName = () => LOCALES[lang].timeZoneName;

/** Change la langue sans recharger : réservé aux tests et à `ui/translate.js`. */
export function setLang(next) {
  if (!LANGS.includes(next)) throw new RangeError(`langue inconnue : ${next}`);
  lang = next;
}

/** Mémorise le choix ; l'appelant recharge la page pour l'appliquer. */
export function storeLang(next) {
  if (!LANGS.includes(next)) throw new RangeError(`langue inconnue : ${next}`);
  try {
    store()?.setItem(LANG_STORAGE_KEY, next);
  } catch (_) {
    // Sans stockage le choix ne survit pas au rechargement ; c'est dégradé,
    // pas cassé — la détection automatique reprend la main.
  }
}

/* Français et espagnol ne coupent pas le pluriel au même endroit : « 0 foyer »
 * mais « 0 focos ». Une seule règle par langue suffit, aucune des deux n'a de
 * forme duelle ni de cas particuliers au-delà. */
const PLURAL = {
  fr: n => (Math.abs(n) < 2 ? 'one' : 'other'),
  es: n => (Math.abs(n) === 1 ? 'one' : 'other'),
};

export const plural = n => PLURAL[lang](n);

const FIELD = /\{(\w+)\}/g;

/**
 * Texte traduit. `vars.n` sélectionne la forme plurielle lorsque l'entrée en
 * porte une ; les autres champs sont substitués tels quels.
 * Une clé absente est renvoyée telle quelle : une interface en clés brutes se
 * repère tout de suite, et `tests/js/i18n.test.js` interdit le cas.
 */
export function t(key, vars = null) {
  const entry = STRINGS[key]?.[lang];
  if (entry === undefined) return key;
  const text = typeof entry === 'string'
    ? entry : entry[plural(vars?.n ?? 1)] ?? entry.other;
  if (!vars) return text;
  return text.replace(FIELD, (whole, name) =>
    (name in vars ? String(vars[name]) : whole));
}
