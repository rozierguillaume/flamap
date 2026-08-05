# Fixtures locales pour `js/archive/`

`api.flamap.fr` bloque le CORS depuis `localhost` en pratique (voir
`docs/refactor/FRONT_ARCHIVE_INCENDIES.md` §3) : impossible d'y tester la page
archives sans passer par `https://flamap.fr`. `js/archive/api.js` bascule donc
vers ces deux fixtures dès que `location.hostname` vaut `localhost` ou
`127.0.0.1` :

- `fires.json` — liste (forme de `GET /fires`), deux feux.
- `fire-2018Var.json` — détail de Correns (Var), volontairement multi-jours
  pour vérifier que l'étendue affichée suit bien la frise et pas les dates
  PSFDF (voir `js/archive/detail.js::renderSummary`).
- `fire-2019Ariege.json` — détail de Seix (Ariège), plus petit.

Données réelles capturées sur l'API de production le 05/08/2026 (sources
publiques PSFDF/FIRMS/EFFIS, cf. `SOURCES.md`), puis allégées : détections
FIRMS et sommets de polygones EFFIS sous-échantillonnés, propriétés EFFIS
réduites à celles que le front lit réellement. Pas de rafraîchissement prévu
— si l'API change de forme, mettre ces fixtures à jour à la main.

Servies en statique, même origine que la page : aucune configuration CORS ni
serveur supplémentaire à lancer pour tester en local.
