# Flamap

Cartographie d'incendie en quasi temps réel, à partir de données satellite
publiques. Aucune clé d'API, aucune dépendance, aucun serveur : deux fichiers
de code et un dossier de GeoJSON.

Le cas d'usage de départ est le feu de Gironde de juillet 2026
(Le Porge / Lège-Cap-Ferret, 38 000 ha), mais la zone se change avec un
argument en ligne de commande.

## Ce que la carte montre

Trois états du terrain, superposés sur un fond satellite :

| Couche | Source | Rendu |
|---|---|---|
| **Terre brûlée** | polygones Copernicus EFFIS | aplat sombre |
| **Brûlé récemment** | détections FIRMS de 6 h à 72 h | dégradé rouge → orange |
| **Foyers actifs** | détections FIRMS de moins de 6 h | jaune vif |

Un curseur temporel rejoue la progression du feu, cran par cran.

## Démarrage

```bash
python3 fetch_fires.py
```

Écrit `data/hotspots.geojson`, `data/burnt_dated.geojson` et
`data/burnt_nrt.geojson`. Bibliothèque standard uniquement, aucune clé d'API.

Compter quelques minutes depuis une connexion résidentielle : le WFS d'EFFIS y
répond en 40 à 250 s par requête. Depuis un datacenter il répond en quelques
secondes — le job GitHub Actions complet tourne en une quinzaine de secondes.

Pour une autre zone, en `west south east north` :

```bash
python3 fetch_fires.py -1.6 44.2 -0.2 45.4
```

Puis servir le dossier — les `fetch()` de la page échouent en `file://` :

```bash
python3 -m http.server 8777
```

et ouvrir <http://localhost:8777>. Des données d'exemple sont versionnées, la
carte s'affiche donc dès le clonage, sans rien exécuter.

## Le curseur est cranté, et c'est voulu

Les données ne sont pas continues. VIIRS et MODIS ne voient la zone que lors
d'un passage orbital (environ 6 par jour pour VIIRS, à heures irrégulières), et
EFFIS ne republie ses polygones qu'une à deux fois par jour. Entre deux
passages, il ne se passe littéralement rien dans les données — un curseur lisse
laisserait croire à un suivi continu qui n'existe pas.

Le curseur saute donc d'une mise à jour réelle à la suivante. Sur la fenêtre du
feu de Gironde : **70 crans en 6,6 jours**, soit 61 passages satellite (traits
gris) et 9 publications EFFIS (traits ocres, plus hauts). L'étiquette sous
l'horloge indique quelle source a produit le cran affiché.

Les passages satellite sont reconstitués en regroupant les détections espacées
de moins de 25 minutes — une rafale de détections correspond à un survol.

Corollaire assumé : les polygones EFFIS n'apparaissent qu'à partir de leur date
de **publication** (`LASTUPDATE`), pas de leur date de départ de feu. On voit
donc la carte telle qu'elle aurait été disponible à l'instant choisi, pas telle
qu'on la reconstruit après coup.

## Comment ça marche

**Récupération** (`fetch_fires.py`) — deux sources, deux protocoles :

- NASA FIRMS expose des flux CSV régionaux publics (24 h / 48 h / 7 j) qui ne
  demandent pas de clé. Le script en agrège quatre : VIIRS NOAA-20, NOAA-21,
  Suomi-NPP et MODIS, filtre sur la bbox et convertit en GeoJSON.
- Copernicus EFFIS expose un WFS MapServer. Le script y prend les polygones
  datés de la saison (`modis.ba.poly.season`) et le produit NRT
  (`effis.nrt.ba.poly`), et ajoute deux epochs (`ts`, `lu`) exploitables
  directement par le curseur.

**Rendu** (`index.html`) — MapLibre GL, sans build ni bundler. Les ~9 000
détections forment une seule couche `circle` en mémoire GPU. Changer de cran
ne fait que réécrire un filtre et trois expressions de peinture : le GeoJSON
n'est jamais renvoyé au moteur. Le `circle-sort-key` sur la date fait passer
les détections récentes au-dessus des anciennes sans tri manuel.

## Déploiement

Le site est publié par GitHub Pages, via le workflow
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) : toutes les
2 heures, un runner exécute `fetch_fires.py`, assemble `index.html` + `data/`
dans `_site`, et livre le tout à Pages sous forme d'artefact. L'ensemble prend
une quinzaine de secondes.

Les données rafraîchies ne sont **jamais commitées**. À 3 Mo par version et
12 exécutions par jour, l'historique git gonflerait de plusieurs gigaoctets par
an pour un dépôt qui contient 30 Ko de code utile. Le `data/` versionné reste
figé : il sert uniquement à ce que la carte s'affiche dès le clonage.

Si une source est indisponible, le job échoue et le site déjà en ligne reste
intact — mieux vaut une carte un peu datée qu'une carte vide. Un garde-fou
annule aussi le déploiement si aucun foyer n'a été récupéré.

Deux points de vigilance propres aux workflows planifiés :

- ils partent avec du retard aux heures de pointe, d'où le décalage de 17 min
  dans le cron ;
- GitHub **désactive un workflow planifié après 60 jours sans activité** sur le
  dépôt. Sans commit pendant deux mois, le rafraîchissement s'arrête en
  silence ; il faut le réactiver à la main dans l'onglet Actions.

## Référencement et aperçu des liens

La carte est un canvas WebGL : un robot d'indexation, comme l'aperçu d'un lien
collé dans une messagerie, n'en voit strictement rien. D'où, dans `index.html` :
titre et `description`, `canonical` sur `https://flamap.fr/`, balises OpenGraph
et Twitter, JSON-LD `WebApplication`, favicon en `data:` URI, et un court texte
décrivant la carte — masqué à l'écran, lu par les lecteurs d'écran et les
robots. Un `<noscript>` renvoie vers les GeoJSON bruts.

L'image d'aperçu `og.png` est produite par `make_og.py`, qui rejoue hors
navigateur le rendu de la carte — mêmes tuiles IGN, mêmes polygones EFFIS,
même rampe de couleurs sur les foyers — puis y pose le titre :

```bash
python3 make_og.py
```

Elle est versionnée et non regénérée par le workflow : elle vieillit donc avec
le feu, à relancer si le cadrage n'a plus de sens.

## Sources de données

Le repérage complet — ce qui existe, à quelle fréquence, avec quels pièges —
est dans [SOURCES.md](SOURCES.md) : NASA FIRMS, Copernicus EFFIS, Copernicus
EMS Rapid Mapping, Sentinel-2 dNBR, Meteosat FRP, et pourquoi les bases
françaises (BDIFF, Prométhée) ne conviennent pas ici.

En deux lignes : **NASA FIRMS** pour les foyers actifs (VIIRS 375 m, ~6
passages par jour, latence ~3 h) et **Copernicus EFFIS** pour les surfaces
brûlées (polygones datés, mis à jour 1 à 2 fois par jour).

## Fichiers

| | |
|---|---|
| `fetch_fires.py` | récupération des deux sources → GeoJSON |
| `index.html` | la carte : MapLibre GL, fond satellite, curseur cranté |
| `make_og.py` | fabrique `og.png`, l'aperçu des liens (Pillow requis) |
| `og.png` | image de partage, 1200 × 630, versionnée |
| `SOURCES.md` | note de repérage sur les sources de données |
| `.github/workflows/deploy.yml` | rafraîchissement toutes les 2 h + publication Pages |
| `data/` | sorties du script, regénérables |

## Limites connues

- **Un hotspot n'est pas une surface brûlée.** C'est un pixel de 375 m où
  quelque chose de chaud a été vu à un instant donné, et il s'élargit jusqu'à
  ~1,5 km en bord de balayage (`scan` et `track` donnent l'empreinte réelle).
  Agréger les détections surestime toujours la surface.
- **Le polygone EFFIS retarde pendant la phase active** : seuil de ~30 ha, base
  MODIS 250 m. Au 28/07 il datait encore du 23/07 pour un feu toujours en cours.
- **Trous de plusieurs heures entre deux passages.** Un trou peut aussi être de
  la fumée ou des nuages, pas une accalmie.
- **Faux positifs** : torchères industrielles, centrales, panneaux solaires. À
  filtrer sur `confidence` si besoin.
- La couche `effis.nrt.ba.poly` est plus fraîche mais ne porte **aucun
  attribut** (ni date ni surface) et contient aussi d'anciennes cicatrices —
  d'où son rendu en simple contour, désactivable.
- MapLibre ne charge son style qu'à la première frame rendue. Un onglet ouvert
  en arrière-plan a son `requestAnimationFrame` gelé et l'événement `load`
  n'arrive jamais — d'où le démarrage par sondage de `isStyleLoaded()` et le
  `resize()` sur `visibilitychange`.
- Tout est en UTC côté satellite ; l'affichage est converti en heure de Paris.

## Crédits

Affichés en bas de page, et à conserver : les deux sources sont libres d'usage
mais demandent d'être citées.

- Foyers actifs : **NASA FIRMS** (VIIRS 375 m et MODIS, LANCE/EOSDIS)
- Surfaces brûlées : **Copernicus EFFIS**
- Fond : ortho-photo **IGN-F/Géoplateforme** (France), **Sentinel-2 cloudless**
  par EOX ailleurs (données Copernicus Sentinel modifiées 2020) ; toponymes
  **CARTO** / **OpenStreetMap**
- Rendu : **MapLibre GL JS**

Aucune licence n'est déclarée pour l'instant : le code est donc, par défaut,
tous droits réservés. À ajouter si le dépôt doit être réutilisable.
