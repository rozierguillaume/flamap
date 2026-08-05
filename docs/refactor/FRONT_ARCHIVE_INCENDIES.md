> **Statut : implémenté.** Le §2 est réalisé par `archives.html` et
> `js/archive/` (liste, détail rejouable, cadrage de carte, frise adaptée).
> Ce document reste comme trace de la passation d'origine ; il n'est plus à
> jour sur le contenu du §2 mais §3 à §7 (forme de l'API, cache, erreurs)
> restent une référence valide.

# Archive des feux — ce qu'il reste à faire côté front

Ce document décrit le travail restant dans `flamap` (le dépôt frontend, celui
que `flamap-archive` appelle `carte-incendie`) pour construire la page
« Archive des feux ». La partie serveur est terminée et déployée : ce fichier
documente comment s'y raccorder.

Il ne vit pas dans `flamap-archive` — l'AGENTS.md de ce dépôt exclut
explicitement toute logique propre au front — c'est un document de passation,
à copier où c'est utile côté `flamap`.

---

## 1. Ce qui existe déjà côté serveur

Un service séparé, `flamap-archive-fires`, lit en continu le journal
d'archive et l'expose en lecture seule sur **`https://api.flamap.fr`** — le
même domaine que `GET /aircraft-history`. Deux routes :

| Route | Rôle |
|---|---|
| `GET /fires` | liste de tous les feux PSFDF archivés, résumés |
| `GET /fires/{id}` | détail rejouable d'un feu : résumé + détections FIRMS + périmètres EFFIS proches dans l'espace et le temps |

Le filtrage spatio-temporel (rayon autour du feu, fenêtre de dates) est déjà
fait **côté serveur** — le front n'a pas à le refaire, seulement à afficher ce
qui revient.

## 2. Ce qui reste à faire côté front

1. Une nouvelle page/route (« Archive des feux »), séparée de la page
   d'accueil — **la page d'accueil ne change pas**, elle garde sa fenêtre de
   dix jours.
2. Une liste des feux (`GET /fires`), triée par défaut du plus récent au plus
   ancien (c'est déjà l'ordre renvoyé par l'API).
3. Au clic sur un feu, son détail (`GET /fires/{id}`) : détections FIRMS,
   périmètres EFFIS, et une frise/timeline « rejouable » construite à partir
   de ces événements bruts (voir §5 — l'API ne construit pas de frise, elle
   renvoie des événements datés).
4. Un rendu carte du feu sélectionné — les calques existants
   (`js/features/fires.js` pour les hotspots par âge, `js/features/burnt.js`
   pour les périmètres brûlés) sont probablement réutilisables tels quels,
   puisque le format des enregistrements FIRMS/EFFIS archivés est le même que
   celui déjà consommé par ces calques (voir §4).

---

## 3. Accès aux données

### Base et CORS

```
https://api.flamap.fr/fires
https://api.flamap.fr/fires/{id}
```

Origines autorisées en CORS : `https://flamap.fr` en production,
`http://localhost:8777` en développement local (déjà la même convention que
`aircraft-history`). Toute autre origine ne reçoit pas l'en-tête
`Access-Control-Allow-Origin` et le navigateur bloque la réponse.

⚠️ **Constaté en pratique (05/08/2026) : `localhost` ne reçoit pas non plus cet
en-tête**, quel que soit le port — `curl` avec `Origin: http://localhost:8777`
obtient une réponse `200` mais sans `Access-Control-Allow-Origin`, et le
navigateur bloque donc l'appel. En attendant un correctif côté
`flamap-archive-fires`, `js/archive/api.js` bascule vers des fixtures locales
(`js/archive/mock/`, même origine que la page) dès que `location.hostname` vaut
`localhost` ou `127.0.0.1` — voir le commentaire en tête de ce fichier.

### Cache et fraîcheur

Le journal n'avance qu'au rythme du timer de fusion serveur (dix minutes). Les
réponses portent `Cache-Control: public, max-age=30, s-maxage=60,
stale-while-revalidate=120` et un `ETag` — un `fetch()` standard avec cache
navigateur par défaut se comporte correctement, pas besoin de forcer
`no-cache`. Pas de rafraîchissement automatique à prévoir : contrairement à
`aircraft-history`, ce n'est pas du temps réel.

### Débit

10 requêtes/s par IP, en rafale de 30 — largement suffisant pour une
navigation humaine (liste puis clic sur un feu), pas dimensionné pour un
appel en boucle ou un pré-chargement de tous les feux au chargement de la
page.

### Erreurs

`GET /fires/{id}` renvoie `404` (corps vide) si l'identifiant est inconnu.

---

## 4. Forme des réponses

### `GET /fires` — liste

Tableau d'objets, un par feu. Exemple réel (production, 04/08/2026) :

```json
{
  "id": "2018Var",
  "commune": "Correns",
  "departement": "Var-83",
  "status": "En cours",
  "statuses": ["En cours"],
  "first_ts": 1785741812,
  "last_ts": 1785741812,
  "surface_max": 1850.0,
  "center": [6.080147, 43.487022],
  "radius_km": 5.81,
  "effis_matches": 6,
  "states": 1
}
```

| Champ | Type | Sens |
|---|---|---|
| `id` | string | identifiant PSFDF du feu (ex. `2018Var`) — utiliser tel quel dans l'URL de détail |
| `commune`, `departement` | string | déclaratif PSFDF |
| `status` | string | dernier statut connu (`Hors de contrôle`, `En cours`, `Fixé`, `Maîtrisé`, `Éteint`) |
| `statuses` | string[] | tous les statuts traversés par ce feu, triés alphabétiquement — pas dans l'ordre chronologique |
| `first_ts`, `last_ts` | epoch (s) | première et dernière mise à jour PSFDF archivées |
| `surface_max` | number \| null | plus grande surface déclarée (hectares) sur la trajectoire connue |
| `center` | `[lon, lat]` \| null | point à utiliser pour cadrer la carte |
| `radius_km` | number | rayon indicatif autour de `center` — voir §6, **pas** une géométrie précise |
| `effis_matches` | number \| null | nombre de périmètres EFFIS rapprochés de ce feu à la dernière collecte, `null` si aucun |
| `states` | number | nombre de fiches PSFDF archivées pour ce feu (longueur de sa trajectoire connue) |

⚠️ **`id` n'est pas garanti stable dans la durée.** L'archive est jeune
(déployée le 04/08/2026) : la stabilité de cet identifiant sur plusieurs mois
n'a pas encore pu être vérifiée empiriquement (voir le journal serveur). Ne
pas construire d'URL permalien basée sur `id` sans garder à l'esprit qu'elle
pourrait un jour cesser de résoudre vers le même feu. Un simple message
« feu introuvable » (déjà le comportement du `404`) suffit comme filet.

### `GET /fires/{id}` — détail

```json
{
  "summary": { "...": "même forme que dans la liste" },
  "firms": [
    {
      "lon": 6.0812, "lat": 43.4869, "ts": 1785743100,
      "source": "VIIRS/NOAA-20", "brightness": 331.2, "frp": 4.8,
      "confidence": "nominal", "daynight": "D", "scan": 0.42, "track": 0.39
    }
  ],
  "effis": [
    {
      "id": "d-abc123", "ts": 1785700000, "lu": 1785744000,
      "area_ha": 1850.0, "country": "FR",
      "props": { "COMMUNE": "Correns", "PROVINCE": "Var", "CLASS": "7DAYS", "...": "reste des attributs EFFIS bruts" },
      "geometry": { "type": "MultiPolygon", "coordinates": ["..."] }
    }
  ]
}
```

- `firms[]` : une entrée par détection satellite, déjà triées par `ts`
  croissant. Mêmes champs que ceux consommés par les calques existants côté
  hotspots (`lon`/`lat`/`ts`/`frp`/`confidence`/`daynight`/`scan`/`track`).
- `effis[]` : une entrée par **révision** de périmètre daté, triées par `lu`
  (date de dernière mise à jour EFFIS, ou `ts`/`FIREDATE` à défaut)
  croissant. `props` porte les attributs EFFIS bruts (`COMMUNE`, `PROVINCE`,
  `CLASS`, `FIREDATE`, `LASTUPDATE`, etc.), `geometry` est du GeoJSON déjà
  dans le bon sens d'axes (`[lon, lat]`, contrairement au flux WFS brut — la
  permutation a été faite à la collecte).
- Les cicatrices `effis_nrt` (couche sans attribut ni date propre) ne sont
  **pas** incluses : impossible de les dater fiablement, voir le commentaire
  dans `fires.py::query_fire` côté serveur.
- Rien d'autre n'est filtré côté client à faire pour l'espace/le temps : la
  fenêtre a déjà été appliquée côté serveur (voir §6).

---

## 5. Construire la frise « rejouable »

L'API ne renvoie pas de frise prête à l'emploi — volontairement, pour rester
un simple accès aux données archivées. Le plus proche équivalent existant est
`flamap/timeline.py::build_timeline`, qui regroupe déjà les passages FIRMS
par satellite avec une tolérance de 25 minutes, et les mises à jour EFFIS par
date. La même logique de regroupement s'applique directement aux tableaux
`firms`/`effis` de `/fires/{id}` :

- un pas de frise par passage satellite (regrouper les détections du même
  `source` séparées de moins de ~25 min), avec l'intensité totale (`frp`) et
  le nombre de détections comme grandeur affichée ;
- un pas de frise par mise à jour EFFIS (`lu` distinct), avec la surface
  cumulée comme grandeur affichée.

La durée totale de la frise vient directement de la donnée : un petit feu n'a
que quelques pas rapprochés, un feu de plusieurs semaines en a
proportionnellement plus — pas besoin de dimensionner une échelle a priori
(voir l'échange qui a précédé ce document).

---

## 6. Ce que `radius_km` / `center` veulent dire (et ne veulent pas dire)

Deux origines possibles, à distinguer dans l'UI si besoin :

- **Un feu rapproché d'un périmètre EFFIS** (`effis_matches` non nul) :
  `center` et `radius_km` viennent du rapprochement géographique déjà fait à
  la collecte (`align_psfdf_to_effis` côté producteur), avec une marge de
  20 % ajoutée côté lecture pour couvrir une éventuelle extension du feu
  après la dernière collecte connue.
- **Un feu jamais rapproché** (`effis_matches` = `null`) : `center` est le
  simple point déclaré par PSFDF (souvent la commune, pas le front de feu),
  et `radius_km` vaut un repli fixe de 15 km — une couronne large, pas une
  estimation de la taille réelle du feu. Le cadrage de carte doit rester
  généreux dans ce cas, pas serré sur le cercle.

Dans les deux cas, ce n'est **pas** une géométrie de périmètre : les vrais
contours, quand ils existent, sont dans `effis[].geometry`.

---

## 7. Hors scope de cette étape

- La page d'accueil n'est pas modifiée.
- Pas de rafraîchissement temps réel de la page « Archive des feux ».
- Le mécanisme de secours si un `id` PSFDF s'avérait instable dans le temps
  (regroupement de deux `id` par recouvrement bbox/temps) n'est pas construit
  côté serveur — s'il devient nécessaire, il devra être traité là-bas, pas
  compensé côté front.