# Flamap

Cartographie des incendies en France métropolitaine, en quasi temps réel, à
partir de données satellite publiques. Aucune clé d'API, aucune dépendance,
aucun serveur applicatif : Python fabrique des fichiers statiques que le
navigateur charge progressivement selon le zoom.

## Ce que la carte montre

Trois états du terrain plus le vent, superposés sur un fond satellite :

| Couche | Source | Rendu |
|---|---|---|
| **Terre brûlée** | polygones Copernicus EFFIS | aplat sombre |
| **Foyers** | détections FIRMS des 5 derniers jours | échelle continue, du jaune clair au brun |
| **Vent à 10 m** | modèle AROME HD via Open-Meteo | nappe de particules blanches |

Un curseur temporel rejoue la progression du feu.

Sur la vue nationale, les détections des dernières 24 heures sont regroupées
spatialement. Un groupe reçoit un halo et un raccourci lorsqu'il compte au
moins 25 foyers près d'un périmètre EFFIS, ou lorsque quelques détections
confirment encore une surface brûlée d'au moins 200 ha. Le voisinage EFFIS
écarte notamment les anomalies thermiques industrielles et les groupes
étrangers inclus dans le rectangle de collecte FIRMS. Il s'agit de seuils
fixes, pas d'un classement limité à trois incendies. Cliquer sur un raccourci
charge directement sa zone détaillée. La position et le zoom sont conservés
dans le fragment `#map=` de l'URL, qui peut donc être copié pour partager
exactement la vue courante.

## Démarrage

```bash
python3 fetch_fires.py
```

Écrit un aperçu national léger (`manifest.json`, foyers agrégés, EFFIS récent,
frise et vent grossier), puis environ 176 paquets dans `data/zones/`.
Bibliothèque standard uniquement, aucune clé d'API.

Compter quelques minutes depuis une connexion résidentielle : le WFS d'EFFIS
peut répondre en 40 à 250 s par requête. Open-Meteo est interrogé sans rafale :
un champ national grossier est produit partout et une maille d'environ 20 km
seulement dans les cellules où EFFIS ou FIRMS signale un incendie récent.

Pour une autre zone, en `west south east north` :

```bash
python3 fetch_fires.py -1.6 44.2 -0.2 45.4
```

Puis servir le dossier — les `fetch()` de la page échouent en `file://` :

```bash
python3 -m http.server 8777
```

et ouvrir <http://localhost:8777>. Les anciens exemples Gironde restent le
filet de sécurité avant la première génération nationale.

## Le temps est continu, les données ne le sont pas

VIIRS et MODIS ne voient la zone que lors d'un passage orbital (environ 6 par
jour pour VIIRS, à heures irrégulières), et EFFIS ne republie ses polygones
qu'une à deux fois par jour. Entre deux passages, il ne se passe littéralement
rien dans les données. La frise nationale regroupe les détections par satellite
et par passage : traits gris pour FIRMS, traits ocres plus hauts pour EFFIS.

Ces mises à jour restent visibles comme telles — les traits de la frise, et
l'étiquette sous l'horloge qui nomme la source ayant parlé en dernier. Mais le
curseur, lui, **balaie le temps en continu**. La version précédente sautait d'un
cran au suivant : chaque saut avançait l'horloge de deux à trois heures d'un
coup, et toute une rafale de foyers apparaissait d'un bloc. Désormais un foyer
naît — il monte en opacité et en taille — puis vieillit le long d'une échelle de
couleur continue.

La vitesse de défilement n'est pas uniforme : elle est modulée par la densité de
mises à jour, calculée par un noyau gaussien le long de la frise. La lecture
accélère dans les creux et ralentit dans les rafales, sans cassure de vitesse
puisque la densité, elle, est continue.

Les passages satellite sont reconstitués en regroupant les détections espacées
de moins de 25 minutes — une rafale de détections correspond à un survol.

Corollaire assumé : les polygones EFFIS n'apparaissent qu'à partir de leur date
de **publication** (`LASTUPDATE`), pas de leur date de départ de feu. On voit
donc la carte telle qu'elle aurait été disponible à l'instant choisi, pas telle
qu'on la reconstruit après coup.

La frise peut se prolonger **après le dernier passage satellite**, heure par
heure : le vent est le seul paramètre dont on connaisse la suite, et
`data/wind_coarse.json` porte 24 h de prévision. Le feu y resterait figé dans son
dernier état observé — le vieillir jusqu'à demain le ferait s'éteindre à
l'écran alors qu'on n'en sait rien. Désactivé pour l'instant : la constante
`FORECAST_H` d'`index.html` vaut 0, la remonter à 24 rouvre ces crans.

## Chargement progressif

À l'ouverture, la page ne télécharge qu'environ 230 ko compressés :

- foyers FIRMS regroupés par cellule de 0,25°, heure et satellite ;
- périmètres EFFIS français des sept derniers jours ;
- vent national 15 × 15 ;
- manifest et frise nationale.

À partir du zoom 7, `moveend` charge les cellules de 1° qui coupent l'écran.
Chaque paquet contient les détections FIRMS exactes, les périmètres EFFIS de la
saison et NRT, et éventuellement le vent fin. Les polygones traversant une
frontière de cellule portent un identifiant stable et sont dédupliqués avant
leur envoi à MapLibre. Le cache JS reste borné à 20 cellules ; le cache HTTP
conserve les fichiers déjà visités.

Le vent fin déborde chaque cellule active de 60 km et se fond progressivement
dans le champ grossier sur les 35 derniers kilomètres de cette marge. En dehors
des cellules d'incendie, ou pendant le téléchargement, le champ national reste
affiché : la nappe ne présente ni trou ni bord carré.

## Comment ça marche

**Récupération** (`fetch_fires.py`) — trois sources, trois protocoles :

- NASA FIRMS expose des flux CSV régionaux publics (24 h / 48 h / 7 j) qui ne
  demandent pas de clé. Le script en agrège quatre : VIIRS NOAA-20, NOAA-21,
  Suomi-NPP et MODIS, filtre sur la bbox et convertit en GeoJSON.
- Copernicus EFFIS expose un WFS MapServer. Le script y prend les polygones
  datés de la saison (`modis.ba.poly.season`) et le produit NRT
  (`effis.nrt.ba.poly`), et ajoute deux epochs (`ts`, `lu`) exploitables
  directement par le curseur.
- Open-Meteo sert le modèle **AROME HD** de Météo-France en JSON, sans clé. Le
  script demande 225 points pour le champ national, puis de petites grilles à
  20 km dans les cellules actives. Les requêtes sont séquentielles avec reprise
  bornée sur HTTP 429. Vitesse et azimut sont convertis en composantes est/nord.

**Rendu** (`index.html`) — MapLibre GL, sans build ni bundler. Seules les
détections des cellules visibles forment la couche `circle`. Avancer dans le
temps ne fait que réécrire trois expressions de peinture — couleur, rayon,
opacité, toutes fonction de l'âge : le GeoJSON n'est jamais renvoyé au moteur.
Il n'y a délibérément **pas de filtre** dans cette boucle, ce sont les bornes de
la rampe d'opacité qui masquent le futur et l'au-delà de 5 jours ; un `setFilter`
réécrit à chaque frame invalide les tuiles et repasse les foyers visibles au
parseur, ce qui doublait le coût mesuré de la frame. Le `circle-sort-key` sur la
date fait passer les détections récentes au-dessus des anciennes sans tri manuel.

L'échelle de couleur et le dégradé qui l'explique en légende sont produits par
**la même table** (`AGE_COLOR`), pour qu'ils ne puissent pas diverger. L'axe de
ce dégradé est en racine carrée : linéaire, les six premières heures — là où le
feu court et où la couleur change le plus vite — tiendraient dans 3 % de la
barre. Un axe déformé se doit d'être chiffré, d'où le repère « 24 h » en son
milieu.

Le vent, lui, est peint à la main dans un `<canvas>` posé sur la carte : 1 700
particules (550 sur téléphone) advectées par le champ interpolé, et une traînée
obtenue en retirant chaque frame un peu d'alpha à ce qui est déjà dessiné. La
vitesse rendue est **relative** — à z8 un vent de 10 m/s vaut 0,02 px/s au sol,
soit une nappe parfaitement immobile.

## Déploiement

Le site est publié par GitHub Pages, via le workflow
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) : toutes les
2 heures, un runner exécute `fetch_fires.py`, assemble les seuls exports
nationaux dans `_site`, et livre le tout à Pages sous forme d'artefact.

Les données rafraîchies ne sont **jamais commitées**. À plusieurs Mo par version et
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

En trois lignes : **NASA FIRMS** pour les foyers actifs (VIIRS 375 m, ~6
passages par jour, latence ~3 h), **Copernicus EFFIS** pour les surfaces
brûlées (polygones datés, mis à jour 1 à 2 fois par jour) et **Open-Meteo**
pour le vent (AROME HD de Météo-France, maille 1,5 km, pas horaire).

## Fichiers

| | |
|---|---|
| `fetch_fires.py` | récupération, agrégation nationale et paquets de 1° |
| `index.html` | la carte : MapLibre GL, fond satellite, frise temporelle |
| `make_og.py` | fabrique `og.png`, l'aperçu des liens (Pillow requis) |
| `og.png` | image de partage, 1200 × 630, versionnée |
| `SOURCES.md` | note de repérage sur les sources de données |
| `.github/workflows/deploy.yml` | rafraîchissement toutes les 2 h + publication Pages |
| `data/manifest.json` | emprise, génération, liste et format des zones |
| `data/zones/` | paquets détaillés générés, non versionnés |

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
- **Le vent est un modèle, pas une mesure.** La vue nationale est volontairement
  grossière (~94 km). Dans les cellules d'incendie elle passe à ~20 km, toutes
  les trois heures. Elle donne une tendance, pas la rafale d'une parcelle.
- La vitesse de la nappe est relative, jamais une distance parcourue au sol :
  les chiffres justes sont ceux de la légende.
- Tout est en UTC côté satellite ; l'affichage est converti en heure de Paris.

## Crédits

Repliés derrière le lien « Sources & crédits » en bas de page, et à conserver :
les sources sont libres d'usage mais demandent d'être citées.

- Foyers actifs : **NASA FIRMS** (VIIRS 375 m et MODIS, LANCE/EOSDIS)
- Surfaces brûlées : **Copernicus EFFIS**
- Vent à 10 m : modèle **AROME HD** de Météo-France, servi par **Open-Meteo**
  (CC BY 4.0)
- Fond : ortho-photo **IGN-F/Géoplateforme** (France), **Sentinel-2 cloudless**
  par EOX ailleurs (données Copernicus Sentinel modifiées 2020) ; toponymes
  **CARTO** / **OpenStreetMap**
- Rendu : **MapLibre GL JS**

Aucune licence n'est déclarée pour l'instant : le code est donc, par défaut,
tous droits réservés. À ajouter si le dépôt doit être réutilisable.
