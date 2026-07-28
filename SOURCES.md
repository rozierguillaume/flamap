# Où récupérer des données incendie en quasi temps réel

Notes de repérage + ce que j'ai testé pour de vrai le 28/07/2026 sur le feu du Porge.

---

## TL;DR

| Besoin | Source | Fraîcheur | Résolution |
|---|---|---|---|
| **Foyers actifs** | NASA FIRMS (VIIRS 375 m) | ~3 h après le passage, ~6 passages/jour | 375 m |
| **Surface brûlée (périmètre)** | Copernicus EFFIS, WFS | 1–2×/jour | ~250–375 m, seuil ~30 ha |
| **Intensité minute par minute** | LSA SAF / Meteosat FRP | **15 min** | 3 km (trop grossier pour cartographier) |
| **Périmètre haute résolution** | Copernicus EMS Rapid Mapping | heures à jours, seulement si activation | ~10 m et mieux |
| **Périmètre haute résolution, en autonomie** | Sentinel-2 dNBR | revisite 5 jours | 10–20 m |

Les deux premières lignes sont celles implémentées dans `fetch_fires.py`. Ce sont
aussi celles qui font les deux images que tu m'as envoyées : la 1re, c'est FIRMS ;
la 2e, c'est le *Current Situation Viewer* d'EFFIS.

---

## 1. Foyers actifs — NASA FIRMS

### Le plus simple : les flux CSV publics, sans clé API

```
https://firms.modaps.eosdis.nasa.gov/data/active_fire/{sensor}/csv/{FILE}
```

| Capteur | dossier | préfixe fichier |
|---|---|---|
| VIIRS NOAA-20 | `noaa-20-viirs-c2` | `J1_VIIRS_C2` |
| VIIRS NOAA-21 | `noaa-21-viirs-c2` | `J2_VIIRS_C2` |
| VIIRS Suomi-NPP | `suomi-npp-viirs-c2` | `SUOMI_VIIRS_C2` |
| MODIS Terra+Aqua | `modis-c6.1` | `MODIS_C6_1` |

Suffixe : `_{REGION}_{24h|48h|7d}.csv`, avec `REGION` ∈ `Europe`, `Global`,
`Russia_Asia`, `North_America`… Exemple utilisé ici :

```
https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_Europe_7d.csv
```

Colonnes : `latitude, longitude, bright_ti4, scan, track, acq_date, acq_time,
satellite, confidence, version, bright_ti5, frp, daynight`
(MODIS remplace `bright_ti4/ti5` par `brightness/bright_t31` et donne une
confiance 0-100 au lieu de `low/nominal/high`).

`acq_time` est en **UTC**, format `HHMM` parfois sans zéro initial (`130` = 01:30).

### Si tu veux des dates arbitraires ou l'historique : l'API REST

Clé gratuite : <https://firms.modaps.eosdis.nasa.gov/api/map_key/>

```
https://firms.modaps.eosdis.nasa.gov/api/area/csv/{MAP_KEY}/{SOURCE}/{west,south,east,north}/{DAY_RANGE}/{YYYY-MM-DD}
```

`SOURCE` ∈ `VIIRS_NOAA20_NRT`, `VIIRS_NOAA21_NRT`, `VIIRS_SNPP_NRT`,
`MODIS_NRT`, + variantes `_SP` (standard, qualité science, ~2 mois de retard).
`DAY_RANGE` max 5. Limite : 5 000 requêtes / 10 min.

Avantage sur les CSV : bbox côté serveur, choix de la date, historique complet.
Inconvénient : il faut la clé.

### Cadence réelle

VIIRS = 3 satellites × 2 passages/jour = **~6 observations/jour**, mais irrégulières
(vers 01h30 et 13h30 solaire, décalées entre satellites). Il y a donc des trous de
plusieurs heures : c'est la limite dure de l'animation de progression.

---

## 2. Surfaces brûlées — Copernicus EFFIS

WFS MapServer, ouvert, sans authentification :

```
https://maps.effis.emergency.copernicus.eu/effis
  ?service=WFS&version=1.0.0&request=GetFeature
  &typename=ms:{LAYER}&outputformat=geojson
  &bbox={west},{south},{east},{north}
```

Couches utiles (`GetCapabilities` en donne 40) :

| Couche | Contenu |
|---|---|
| `modis.ba.poly.today` / `.week` / `.month` / `.season` | **polygones datés**, avec `FIREDATE`, `FINALDATE`, `LASTUPDATE`, `AREA_HA`, `COMMUNE`, `PROVINCE`, `CLASS`, + répartition par type de couvert |
| `modis.ba.poly.2016` … `.2025` | archives annuelles |
| `modis.ba.point.*` | mêmes objets en centroïdes (léger) |
| `effis.nrt.ba.poly` / `.point` | version **NRT**, contour plus frais — mais **géométrie seule, aucun attribut** exposé |
| `viirs.hs`, `modis.hs`, `noaa.hs`, `all.hs` | hotspots (redondant avec FIRMS, et pas de filtre date pratique) |

L'attribut `CLASS` vaut `Today` / `7DAYS` / `30DAYS` / `FireSeason` — c'est
exactement ta distinction « brûlé récemment » vs « brûlé plus tôt », prête à l'emploi.

### Trois pièges que j'ai rencontrés

1. **L'axe est inversé.** La sortie `outputformat=geojson` renvoie les coordonnées
   en `[lat, lon]`, pas `[lon, lat]` comme le veut la spec GeoJSON. Il faut les
   permuter (`swap_axes()` dans `fetch_fires.py`), sinon tout atterrit en Somalie.
2. **C'est lent.** 40 s à 250 s par requête, et `GetCapabilities` a mis 4 min 30.
   À mettre en cache, jamais à appeler depuis le front.
3. **`LASTUPDATE` retarde.** Le polygone du Porge était encore daté du 23/07 alors
   que le feu courait toujours le 27. Le produit MODIS BA a un seuil de ~30 ha et
   lisse beaucoup : il sous-estime pendant la phase active. C'est pour ça que la
   carte superpose les hotspots FIRMS (frais) au polygone (en retard).

Autres formats dispo sur la même URL : `outputformat=SHAPEZIP`, `SPATIALITEZIP`.
Il y a aussi un WMS (`.../gwis`) si tu préfères des tuiles au vecteur.

---

## 3. Les autres pistes, par ordre d'intérêt

### Copernicus EMS Rapid Mapping — le plus précis, mais seulement sur activation

Quand un État déclenche le service, on obtient des délimitations dérivées
d'imagerie haute résolution (Sentinel + satellites commerciaux), en shapefile /
GeoJSON / PDF. API publique :

```
https://rapidmapping.emergency.copernicus.eu/backend/dashboard-api/public-activations-info/
https://rapidmapping.emergency.copernicus.eu/backend/dashboard-api/public-activations/?code=EMSR842
```

Champs utiles : `code`, `productsPath` (ZIP complet), `aois[].products[].downloadPath`,
`statusCode` (`F` fini, `I` en cours, `W` en attente d'image).
Un feu de cette taille en France est très probablement activé — à vérifier dans la
liste. C'est la meilleure géométrie disponible, mais la latence se compte en
heures/jours et ça ne se met pas à jour en continu.

### Sentinel-2 dNBR — pour faire ta propre surface brûlée à 10–20 m

Calcul du *Normalized Burn Ratio* avant/après (`(NIR − SWIR) / (NIR + SWIR)`,
soit B8A et B12), puis différence. Ça donne un périmètre bien plus fin qu'EFFIS et
en prime une **sévérité** — ce qui te donnerait naturellement le dégradé
« brûlé récent / brûlé ancien » que tu cherches, sans passer par l'âge des hotspots.

Accès via le Copernicus Data Space Ecosystem (compte gratuit) : openEO ou
Sentinel Hub Process API — <https://dataspace.copernicus.eu/analyse/apis>.

Limite : revisite ~5 jours, et un feu actif = fumée + nuages = images inexploitables.
C'est un produit du *lendemain*, pas du direct.

### LSA SAF / Meteosat FRP — la seule source vraiment continue

Meteosat est géostationnaire : mesure de puissance radiative **toutes les 15 min**
(10 min sur MTG), sur toute l'Europe. À 3 km de résolution c'est inutilisable pour
dessiner un périmètre, mais c'est parfait pour une **courbe d'intensité horaire**
à côté de la carte — le seul moyen de voir les reprises nocturnes en quasi direct.
Accès : <https://lsa-saf.eumetsat.int> ou l'EUMETSAT Data Store (compte gratuit).

### Sources françaises

- **BDIFF** — base nationale, mais annuelle/consolidée, aucun intérêt en temps réel.
- **Prométhée** — plus réactif, mais ne couvre que la zone méditerranéenne
  (15 départements) : **la Gironde n'y est pas**.
- Les **points de situation préfectoraux** restent la seule source pour tout ce qui
  n'est pas visible du satellite : évacuations, centres d'accueil, routes coupées,
  effectifs. C'est ce qui alimente la 1re image que tu m'as envoyée — à saisir à la
  main, il n'y a pas de flux.

---

## 4. Ce que disent les données sur le feu en cours (état 28/07/2026)

Sortie réelle de `fetch_fires.py` sur la bbox `-1.6, 44.2, -0.2, 45.4` :

```
NASA FIRMS - foyers actifs
  VIIRS/NOAA-20: 2596   VIIRS/NOAA-21: 2924
  VIIRS/S-NPP:   2982   MODIS:          592
  -> 9094 détections sur 7 jours, dernière : 2026-07-28T02:53Z

Copernicus EFFIS - surfaces brûlées (saison 2026, Gironde/Landes)
  2026-07-22  Porge          38 174 ha  [7DAYS]
  2026-07-23  Biscarrosse     3 798 ha  [7DAYS]
  2026-07-21  Mérignac            7 ha  [7DAYS]
  2026-07-20  Arès                3 ha  [30DAYS]
  ... (13 polygones au total)
```

Répartition des détections par jour dans la zone (NOAA-20 seul) :
`21/07: 4 · 22/07: 6 · 23/07: 534 · 24/07: 1103 · 25/07: 353 · 26/07: 549 · 27/07: 31 · 28/07: 16`

→ pic les 24 et 26, forte décrue depuis le 27.

---

## 5. Le modèle à 3 couches que tu décris

Aucune source ne le fournit tel quel. La façon la plus propre de le construire avec
ce qui existe :

| Couche | Construction |
|---|---|
| **Foyers actifs** | hotspots FIRMS < 6 h |
| **Brûlé récemment** | hotspots FIRMS de 6 h à ~72 h, en dégradé |
| **Terre brûlée** | polygone EFFIS, moins la zone couverte par les deux précédentes |

C'est ce que fait `index.html`. Version plus ambitieuse : remplacer la 3e couche par
un dNBR Sentinel-2, qui donne la sévérité et permet un vrai dégradé continu au lieu
de trois paliers.

---

## Pièges généraux

- **Un hotspot n'est pas une surface brûlée.** C'est un pixel de 375 m où quelque
  chose de chaud a été vu à un instant donné. Agréger les hotspots surestime
  toujours la surface, surtout en bord de balayage (`scan`/`track` dans le CSV
  donnent l'empreinte réelle du pixel, qui grossit jusqu'à ~1,5 km sur les bords).
- **Faux positifs** : torchères industrielles, centrales, panneaux solaires,
  volcans. À filtrer sur `confidence` (`nominal`/`high`) et par masque.
- **Faux négatifs** : nuages et fumée épaisse cachent le feu. Un trou dans les
  détections ne veut pas dire que le feu s'est arrêté.
- **Tout est en UTC** côté satellite, l'heure française est UTC+2 en été.
- **Attribution obligatoire** : NASA FIRMS et Copernicus sont libres d'usage mais
  demandent d'être cités.

---

## Liens

- FIRMS API : <https://firms.modaps.eosdis.nasa.gov/api/area/>
- FIRMS clé : <https://firms.modaps.eosdis.nasa.gov/api/map_key/>
- EFFIS données & services : <https://forest-fire.emergency.copernicus.eu/applications/data-and-services>
- EFFIS Current Situation Viewer : <https://forest-fire.emergency.copernicus.eu/apps/effis_current_situation_test/>
- Copernicus EMS Rapid Mapping : <https://rapidmapping.emergency.copernicus.eu/>
- CDSE (Sentinel-2) : <https://dataspace.copernicus.eu/analyse/apis>
- LSA SAF : <https://lsa-saf.eumetsat.int/en/a/natural-hazards/>
