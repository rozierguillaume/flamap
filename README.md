# Flamap

Cartographie des incendies en France métropolitaine, en quasi temps réel, à
partir de données satellite publiques. Aucune clé d'API ni dépendance :
Python fabrique des fichiers statiques que le navigateur charge
progressivement selon le zoom. Un petit service facultatif et isolé amorce
l'historique récent des moyens aériens.

## Ce que la carte montre

Trois états du terrain, le vent et une simulation de fumée, superposés sur un
fond satellite :

| Couche | Source | Rendu |
|---|---|---|
| **Terre brûlée** | polygones Copernicus EFFIS | aplat sombre |
| **Foyers** | détections FIRMS des 10 derniers jours | échelle continue, du jaune clair au brun sombre |
| **Fumée simulée** | foyers FIRMS récents + vent AROME HD | panaches diffus qui suivent le champ de vent |
| **Vent à 10 m** | modèle AROME HD via Open-Meteo | nappe de particules blanches |
| **Moyens aériens** | positions ADS-B Airplanes.live | appareils suivis, cap et fiche de vol |

Un curseur temporel rejoue la progression du feu.

Le menu **Calques** permet d'afficher ou masquer les foyers dans leur ensemble,
ou séparément pour chacun des flux FIRMS (VIIRS/NOAA-20, VIIRS/NOAA-21,
VIIRS/S-NPP et MODIS). Il permet aussi de choisir la métrique des graphiques :
nombre de foyers ou, par défaut, somme de leur puissance radiative instantanée
(FRP, en MW). Sur la carte, la FRP module légèrement la taille de chaque point ;
l'ancienneté reste le facteur visuel principal.
La fumée peut elle aussi être masquée dans **Calques**. Elle est indicative :
ce n'est ni une observation satellite de fumée ni une mesure de qualité de
l'air.
Le calque **Moyens aériens** est désactivé par défaut. Son activation interroge
directement Airplanes.live depuis le navigateur, toutes les 4 secondes et
uniquement lorsque l'onglet est visible. Une liste de 112 adresses ICAO24
connues limite la requête aux appareils susceptibles de participer aux
opérations ; leur proximité avec un incendie récent est signalée, mais ne
constitue pas une confirmation de mission. Le calque disparaît lorsque la
frise montre le passé, puisque ces positions ne décrivent que l'instant présent.
À l'activation, le navigateur demande au service du VPS les positions déjà
collectées pendant les quinze dernières minutes, puis fusionne cet amorçage
avec sa collecte directe. Si le service est indisponible, le trajet se
construit simplement à partir de l'activation comme auparavant. Cette requête
d'amorçage est abandonnée après 4 secondes et ses données sont validées avant
fusion. Les 10 dernières minutes sont dessinées et restent en mémoire dans le
navigateur, y compris si le calque est brièvement masqué. Les appareils sont
affichés avec 6 secondes de différé — un cycle de collecte plus 2 secondes de
marge — puis avancent continûment entre deux positions réellement reçues, sans
extrapoler au-delà du dernier point connu. Avions et hélicoptères utilisent des
symboles distincts.
Le bouton `i` à droite de la frise ouvre le journal des 40 dernières mises à
jour : heure, source et volume de données reçu.

Sur la vue nationale, les détections des dernières 24 heures sont regroupées
spatialement. Un groupe reçoit un halo et un raccourci lorsqu'il compte au
moins 25 foyers près d'un périmètre EFFIS mis à jour dans les 7 derniers jours,
ou lorsque quelques détections confirment encore une surface brûlée d'au moins
200 ha. Le voisinage EFFIS
écarte notamment les anomalies thermiques industrielles et les groupes
étrangers inclus dans le rectangle de collecte FIRMS. Il s'agit de seuils
fixes, pas d'un classement limité à trois incendies. Cliquer sur un raccourci
charge directement sa zone détaillée. Son libellé donne le département et, en
priorité, la superficie du plus grand périmètre EFFIS voisin ; le nombre de
foyers sert de repli si cette superficie manque. La position et le zoom sont
conservés dans le fragment `#map=` de l'URL, qui peut donc être copié pour
partager exactement la vue courante.

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
et par passage. Une barre orange par passage représente, au choix, le nombre de
foyers ou leur puissance radiative totale. Dès que toute la France ne tient plus
à l'écran, ce graphique est recalculé sur la seule emprise visible.

Les mises à jour EFFIS restent consultables dans le journal ouvert par le bouton
`i`, sans être mélangées à cette mesure d'intensité FIRMS.
L'horodatage complet flotte au-dessus pour préserver toute la largeur utile du
curseur, qui **balaie le temps en continu**. La version précédente sautait d'un
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

## Cliquer sur la carte

Toute la carte répond au clic, et une seule fiche reste ouverte à la fois. La
priorité de lecture est explicite : un appareil, puis un foyer, puis un
regroupement de la vue nationale, puis un périmètre brûlé, puis le sol.

Chaque fiche a deux étages séparés par un filet — ce qui a été observé au-dessus,
l'air qu'il y fait en dessous :

- **Foyer** — satellite et heure de détection, ancienneté relative au cran
  affiché, puissance radiative en MW, indice de confiance FIRMS (classe pour
  VIIRS, pourcentage pour MODIS).
- **Regroupement national** — nombre de détections de l'heure et FRP cumulée.
- **Périmètre EFFIS daté** — commune, département, surface en hectares, date de
  départ, puis la composition du couvert brûlé publiée par EFFIS (conifères,
  feuillus, forêt mixte, maquis, landes, cultures, bâti…) et, le cas échéant, la
  part située en zone Natura 2000.
- **Emprise NRT** — rappel qu'elle arrive sans date ni surface et peut englober
  d'anciennes cicatrices.
- **Fond de carte** — la commune, les coordonnées, la température et le vent du
  point cliqué.

L'étage météo lit les grilles déjà en mémoire pour la nappe de vent : aucune
requête réseau n'est déclenchée par l'ouverture d'une fiche. Son bouton
**Prévisions météo** ouvre le volet détaillé sur ce point précis.

Le bouton discret **Météo** ouvre un graphique pour le centre courant de la
carte — ou pour le point épinglé si l'on y est arrivé depuis une fiche, auquel
cas le volet ne suit plus les déplacements et un bouton ramène au centre :
température, vent moyen, direction, rafales et précipitations horaires
sur les 12 dernières et les 12 prochaines heures. Deux traits situent l'heure
actuelle et l'extraction des données affichées sur la carte. Ces séries sont
réparties sur **deux fichiers de pas différents**. Un déplacement de la carte
ouverte réinterpole ensuite les mêmes grilles, sans requête réseau
supplémentaire — sauf sur un point épinglé, qui reste fixe. Le survol donne,
heure par heure, la température, le vent moyen, sa direction, les rafales et le
cumul de précipitations en millimètres.

Le vent vient de `data/weather_forecast.json`, sur la grille nationale à
~94 km : il varie assez lentement dans l'espace pour s'en contenter. La
température et les précipitations viennent de `data/thermal.json`, sur une
grille à **20 km**. La raison est le relief : la température à 2 m perd environ
0,65 °C par 100 m d'altitude, si bien qu'un point de grille tombé en montagne
tirait toute la plaine voisine vers le bas. Sur la grille du vent, Lyon
ressortait à 33 °C un jour où AROME en prévoyait 39 ; à 20 km l'écart passe sous
le degré. Descendre à 10 km ne gagnerait qu'à peu près 1 °C de plus pour 3,4
fois le poids du fichier et 36 lots Open-Meteo au lieu de 10.

Les deux fichiers ont leur **propre base de temps** et sont interpolés
séparément par horodatage, jamais au même indice de ligne : ils sont produits par
deux workflows de cadences différentes, 2 h pour le vent et 6 h pour la
température.

La légende principale affiche la température au centre de la carte en lisant
cette même grille fine, ce qui impose de la télécharger au démarrage et non à
l'ouverture du volet. Elle couvre ±18 h — délibérément plus large que les ±12 h
du vent, pour que le graphique reste complet même quand les deux collectes sont
décalées de six heures. Dès que le curseur temporel sort de cette fenêtre — ou si
`thermal.json` manque encore — la légende comme le volet retombent sur la
température grossière transportée par `data/wind_coarse.json`, qui suit les dix
jours de la frise.

## Chargement progressif

À l'ouverture, la page ne télécharge que quelques centaines de ko compressés :

- foyers FIRMS regroupés par cellule de 0,25°, heure et satellite, avec leur
  nombre et leur FRP totale ;
- périmètres EFFIS français mis à jour dans les sept derniers jours ;
- vent national 15 × 15 ;
- grille de température à 20 km sur ±12 h, pour la légende et le volet météo ;
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
  demandent pas de clé. Le script en télécharge quatre en parallèle, avec une
  reprise courte : VIIRS NOAA-20, NOAA-21, Suomi-NPP et MODIS. Il filtre ensuite
  sur la bbox, reprend les détections encore valides du déploiement précédent
  pour conserver 10 jours, puis convertit l'ensemble en GeoJSON.
- Copernicus EFFIS expose un WFS MapServer. Le script y prend les polygones
  datés de la saison (`modis.ba.poly.season`) et le produit NRT
  (`effis.nrt.ba.poly`), et ajoute deux epochs (`ts`, `lu`) exploitables
  directement par le curseur.
- Open-Meteo sert le modèle **AROME HD** de Météo-France en JSON, sans clé. Le
  script demande 225 points pour le champ national de vent, environ 2 570 pour
  les grilles fines à 20 km des cellules actives, et environ 4 290 pour la
  grille de température à 20 km — soit **environ 17 requêtes** par passage. Les
  requêtes sont séquentielles et espacées de six secondes pour les IP partagées
  des runners GitHub. Si une grille fine de vent reste indisponible, le vent
  national grossier demeure affiché partout. Vitesse et azimut sont convertis
  en composantes est/nord.

  La grille de température ne demande qu'un jour de passé, contre dix pour le
  vent, et deux variables au lieu de cinq : c'est cette fenêtre courte qui paie
  ses points supplémentaires. Elle pèse au total environ 5 % de données de plus
  qu'avant son introduction, les grilles fines de vent restant de loin le poste
  dominant.

  Le quota Open-Meteo se compte par variables et par durée, pas par point : un
  lot de 430 points pèse un appel comme un lot d'un seul. La contrainte réelle
  est le nombre d'aller-retours depuis l'IP partagée du runner, qui déclenche
  au-delà d'un certain rythme des HTTP 429 et des poignées de main TLS qui
  restent pendantes.

  D'où quatre garde-fous. Les points partent par lots de 430 — le plafond est la
  longueur d'URL, 1 000 points renvoient un `HTTP 414`. Le découpage en cellules
  de 1° sert le navigateur, pas l'API : les points de **toutes** les cellules
  actives voyagent dans des lots partagés, donc 18 cellules tiennent en 6
  requêtes au lieu de 18, et chaque grille est reconstruite depuis sa tranche de
  la réponse. Le timeout est à 30 s là où une réponse saine arrive en moins
  d'une seconde. Enfin le vent fin et la grille de température ont chacun un
  budget de temps — 8 et 6 minutes — au-delà duquel ils sont écourtés au profit
  du champ national : les cellules entièrement couvertes par les lots déjà reçus
  restent exploitables, les autres retombent sur le champ large, exactement
  comme une cellule que le navigateur n'a pas encore téléchargée.
- Airplanes.live n'est pas interrogé par le collecteur : le navigateur lui
  demande en une seule fois les positions courantes des ICAO24 connus dès
  l'ouverture de la carte. Les réponses sans position fraîche sont
  ignorées. Le service autonome `flamap-aircraft-history`, déployé séparément,
  effectue en parallèle une collecte mutualisée pour amorcer les traces lors de
  leur première ouverture ; il ne participe ni aux exports statiques ni à
  l'affichage des positions courantes.

**Rendu** (`index.html`) — MapLibre GL, sans build ni bundler. Seules les
détections des cellules visibles forment la couche `circle`. Avancer dans le
temps ne fait que réécrire trois expressions de peinture — couleur, rayon,
opacité, toutes fonction de l'âge : le GeoJSON n'est jamais renvoyé au moteur.
Il n'y a délibérément **pas de filtre** dans cette boucle, ce sont les bornes de
la rampe d'opacité qui masquent le futur et l'au-delà de 10 jours ; un `setFilter`
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

La fumée occupe un second `<canvas>`. Les foyers jaunes des six dernières heures
émettent des bouffées en fonction de leur FRP et du nombre de pixels détectés,
sans concentrer tout le panache sur le seul maximum. Chaque bouffée conserve une
position géographique, interroge le vent interpolé après chaque déplacement,
s'élargit et disparaît progressivement en six heures environ. Elle peut donc
changer de direction en traversant une autre zone de vent et reste continue
pendant un zoom. En lecture, émission, déplacement et vieillissement suivent le
temps accéléré de la frise ; au dernier instant, ils continuent à vitesse
visuelle accélérée même lorsque la frise est en pause.

## Déploiement

Le site est publié par GitHub Pages avec trois workflows :

- [`update-fire-deploy.yml`](.github/workflows/update-fire-deploy.yml) exécute
  `fetch_fires.py` toutes les 2 heures (et lors d'une modification du
  collecteur) : foyers, périmètres, vent national et vent fin des cellules
  actives ;
- [`update-weather-deploy.yml`](.github/workflows/update-weather-deploy.yml)
  exécute `fetch_fires.py --thermal` toutes les 6 heures et ne produit que
  `data/thermal.json`, la grille de température à 20 km ;
- [`update-front-deploy.yml`](.github/workflows/update-front-deploy.yml)
  est déclenché par une modification du front, de l'aperçu social, des icônes
  ou des fichiers destinés aux moteurs de recherche.
  Il reprend les données de la version déjà publiée sur `flamap.fr`, y superpose
  le front, vérifie l'artefact complet, puis le déploie sans interroger les
  sources satellites ni météorologiques. Si un même push modifie aussi le
  collecteur, ce workflow rapide s'efface au profit du déploiement complet.

Un premier déploiement complet doit naturellement avoir réussi avant un
déploiement front seul, ou un déploiement météo seul.

### Pourquoi la météo a son propre workflow

La grille de température représentait dix des dix-sept requêtes Open-Meteo d'une
collecte, et c'est le rythme des aller-retours depuis l'IP partagée du runner qui
déclenche les bridages. Elle n'a pourtant aucune raison de suivre la cadence des
foyers : **AROME HD ne sort une nouvelle échéance que toutes les 3 heures**. La
passer de 12 à 4 collectes par jour divise sa pression par trois sans rien
perdre, et une panne météo ne peut plus retarder la publication d'un foyer.

### Comment deux workflows ne s'écrasent pas

Un artefact Pages remplace **toujours le précédent en entier** : il n'existe pas
de déploiement partiel. Deux protections en découlent.

D'abord le verrou : les trois workflows partagent `concurrency: group: pages`,
et un groupe de concurrence est **global au dépôt**, pas propre à un workflow.
Deux d'entre eux ne peuvent donc jamais publier en même temps ; le second attend
que le premier ait fini, puisque `cancel-in-progress` est faux.

Ensuite le partage des fichiers, sans recouvrement :

| Fichier | Produit par |
|---|---|
| `manifest.json`, foyers, périmètres, frise, `zones/` (vent fin inclus), `wind_coarse.json`, `weather_forecast.json` | `update-fire-deploy` |
| `thermal.json` | `update-weather-deploy` |

Chaque workflow reprend du site publié tout ce qu'il ne produit pas, et n'y
substitue que ses propres fichiers. Comme les runs sont sérialisés, chacun repart
donc de l'état que l'autre vient de publier.

`thermal.json` porte sa propre base de temps (`t0`, `dt`, `nt`), indépendante de
celle du vent. C'est ce qui permet aux deux cadences de ne pas avoir à s'aligner :
le navigateur interpole chaque champ séparément par horodatage. Son absence est
un état valide — avant la première collecte météo, ou si celle-ci échoue — et le
front retombe alors sur la température grossière que `wind_coarse.json`
transporte toujours.

Le service `flamap-aircraft-history` est déployé séparément sur le VPS. Il
conserve quinze minutes en RAM et expose
`https://api.flamap.fr/aircraft-history` derrière nginx. Il n'est pas inclus
dans l'artefact GitHub Pages.

Les données rafraîchies ne sont **jamais commitées**. À plusieurs Mo par version et
12 exécutions par jour, l'historique git gonflerait de plusieurs gigaoctets par
an pour un dépôt qui contient 30 Ko de code utile. Le `data/` versionné reste
figé : il sert uniquement à ce que la carte s'affiche dès le clonage.

Si une source est indisponible, le job échoue et le site déjà en ligne reste
intact — mieux vaut une carte un peu datée qu'une carte vide. Un garde-fou
annule aussi le déploiement si aucun foyer n'a été récupéré, si une zone manque
ou si le site assemblé dépasse 100 Mio.

Mesure de référence au 28 juillet 2026 : 184 fichiers, environ 18 Mio non
compressés et 5 Mio pour l'archive gzip transmise à Pages. La limite officielle
de publication est de 1 Go et le déploiement doit finir en moins de 10 minutes ;
l'artefact dispose donc d'une marge très large. La génération Python elle-même
n'utilise que la bibliothèque standard et dispose de 25 minutes dans le
workflow. Les reprises bornées — HTTP 429 comme coupures de transport —
protègent les requêtes Open-Meteo sans pouvoir bloquer le runner indéfiniment ;
l'échec d'une seule grille fine ne bloque pas le rafraîchissement des
incendies. Ces 25 minutes ont déjà été atteintes une fois, le 30 juillet 2026 :
cinq poignées de main TLS expirées à 180 s chacune avaient suffi à consommer
15 minutes de temps mort. C'est de là que viennent le timeout ramené à 30 s et
le budget de six minutes sur la grille de température. Les quatre timeouts FIRMS
s'exécutent en parallèle pour qu'une panne réseau globale échoue rapidement au
lieu de monopoliser le runner pendant huit minutes.

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
et Twitter, JSON-LD `WebSite` et `WebApplication`, favicon servi à une URL
explorable, et un court texte décrivant la carte — masqué à l'écran, lu par les
lecteurs d'écran et les robots. Un `<noscript>` renvoie vers les GeoJSON bruts.
`robots.txt` indique également le plan de site `sitemap.xml`.

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
Le nom de la commune au centre de la carte est résolu à la demande par l'API
de géocodage inverse de la Géoplateforme (BAN), uniquement à l'ouverture du
volet météo.

## Fichiers

| | |
|---|---|
| `fetch_fires.py` | récupération, agrégation nationale et paquets de 1° |
| `index.html` | la carte : MapLibre GL, fond satellite, frise temporelle |
| `social.html` | prépare le texte et le graphique PNG d'une publication |
| `make_og.py` | fabrique `og.png`, l'aperçu des liens (Pillow requis) |
| `og.png` | image de partage, 1200 × 630, versionnée |
| `SOURCES.md` | note de repérage sur les sources de données |
| `.github/workflows/update-fire-deploy.yml` | foyers, périmètres et vent toutes les 2 h + publication Pages |
| `.github/workflows/update-weather-deploy.yml` | grille de température toutes les 6 h |
| `.github/workflows/update-front-deploy.yml` | publication rapide des seuls changements de front |
| `data/manifest.json` | emprise, génération, liste et format des zones |
| `data/thermal.json` | température et pluie à 20 km sur ±18 h, non versionné |
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
- **La température reste sous-estimée dans les vallées encaissées.** Sa grille
  à 20 km suffit en plaine — Lyon à moins d'un degré — mais un fond de vallée
  alpin n'a que des sommets pour voisins, et perd plusieurs degrés à
  l'interpolation. Corriger ce cas demanderait un modèle d'élévation embarqué.
- Tout est en UTC côté satellite ; l'affichage est converti en heure de Paris.

## Crédits

Repliés derrière le bouton « Sources & crédits » en bas de page sur ordinateur,
et derrière « crédits » dans l'en-tête sur mobile. Ces crédits sont à conserver :
les sources sont libres d'usage mais demandent d'être citées.

- Foyers actifs : **NASA FIRMS** (VIIRS 375 m et MODIS, LANCE/EOSDIS)
- Surfaces brûlées : **Copernicus EFFIS**
- Vent à 10 m : modèle **AROME HD** de Météo-France, servi par **Open-Meteo**
  (CC BY 4.0)
- Fond : ortho-photo **IGN-F/Géoplateforme** (France), **Sentinel-2 cloudless**
  par EOX ailleurs (données Copernicus Sentinel modifiées 2020) ; toponymes
  **CARTO** / **OpenStreetMap**
- Commune au centre : géocodage inverse **Géoplateforme / BAN**
- Positions des moyens aériens : **Airplanes.live** (ADS-B communautaire,
  affichage non exhaustif)
- Rendu : **MapLibre GL JS**

Aucune licence n'est déclarée pour l'instant : le code est donc, par défaut,
tous droits réservés. À ajouter si le dépôt doit être réutilisable.
