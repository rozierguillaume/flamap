import { getLang, storeLang, t } from '../i18n.js';


/* =====================================================================
 * TRADUCTION DU DOCUMENT
 *
 * Les textes fixes vivent dans le HTML, en français, et portent la clé qui les
 * remplace : la page reste lisible et référençable sans JavaScript, et le
 * balisage n'est pas dupliqué par langue.
 *
 *   data-i18n        → textContent
 *   data-i18n-html   → innerHTML (uniquement les clés qui portent du balisage)
 *   data-i18n-title  → title
 *   data-i18n-label  → aria-label
 *   data-i18n-content→ content (balises <meta>)
 *   data-i18n-href   → href (pages qui existent en deux versions)
 *
 * Ce module s'exécute de lui-même à l'import : il est déclaré en tête des pages
 * pour que la substitution ait lieu avant le premier rendu. Les scripts de type
 * module sont différés, donc placés après l'analyse du document — la traduction
 * arrive avant la peinture dans la pratique, mais elle n'est jamais garantie
 * plus tôt : ne rien y mettre dont la mise en page dépendrait.
 * ===================================================================== */

const ATTRIBUTES = [
  ['data-i18n-title', 'i18nTitle', 'title'],
  ['data-i18n-label', 'i18nLabel', 'aria-label'],
  ['data-i18n-content', 'i18nContent', 'content'],
  ['data-i18n-href', 'i18nHref', 'href'],
];

export function translate(root = document) {
  for (const element of root.querySelectorAll('[data-i18n]'))
    element.textContent = t(element.dataset.i18n);
  for (const element of root.querySelectorAll('[data-i18n-html]'))
    element.innerHTML = t(element.dataset.i18nHtml);
  for (const [selector, dataset, attribute] of ATTRIBUTES)
    for (const element of root.querySelectorAll(`[${selector}]`))
      element.setAttribute(attribute, t(element.dataset[dataset]));
}

/* Un bouton par langue supplémentaire serait un menu ; à deux, la bascule
 * porte le code de l'autre langue et se lit d'un coup d'œil. Le choix est
 * mémorisé puis la page rechargée : fiches, graphiques et infobulles sont
 * fabriqués à la volée, les retraduire en place demanderait un inventaire de
 * tout ce qui est déjà à l'écran. */
function installLangButton() {
  const button = document.getElementById('lang-btn');
  if (!button) return;
  const other = getLang() === 'fr' ? 'es' : 'fr';
  button.lang = other;
  button.addEventListener('click', () => {
    storeLang(other);
    // `?lang=` a fait son office : le laisser figerait la langue dans les liens
    // partagés depuis cette page.
    const url = new URL(location.href);
    url.searchParams.delete('lang');
    // `replace()` vers une adresse qui ne diffère que par son fragment est une
    // navigation *dans* le document : `#map=` étant toujours là, elle ne
    // rechargerait rien et le clic resterait sans effet.
    if (url.href === location.href) location.reload();
    else location.replace(url);
  });
}

export function applyDocumentLanguage() {
  document.documentElement.lang = getLang();
  translate();
  installLangButton();
}

if (typeof document !== 'undefined') applyDocumentLanguage();
