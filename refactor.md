# Plan canonique de refactorisation de Flamap

Ce document est la source de vérité du chantier de refactorisation. Il doit
permettre à chaque nouvelle conversation Codex de reprendre le travail sans
dépendre de l'historique d'une conversation précédente.

Le chantier porte sur le front, le collecteur Python et les workflows de
publication. Son objectif est de rendre le code beaucoup plus clair, testable
et facile à maintenir, sans modifier les fonctionnalités visibles, la
sémantique des données, les performances ou la robustesse opérationnelle.

Le projet reste volontairement simple : site statique, modules ES natifs,
bibliothèque standard Python, aucun bundler, aucun gestionnaire de paquets et
aucune donnée générée suivie par Git.

---

## 1. Mode d'emploi pour les conversations Codex

Chaque conversation doit :

1. lire intégralement `AGENTS.md` et ce fichier avant toute modification ;
2. inspecter `git status` et les derniers commits du chantier ;
3. traiter un seul lot non terminé ;
4. annoncer précisément son périmètre avant d'écrire ;
5. préserver les noms, commentaires et comportements pendant une extraction ;
6. noter les améliorations hors périmètre dans « Repéré en chemin » ;
7. exécuter les contrôles automatisés et manuels proportionnés au lot ;
8. faire relire le diff à froid avant validation ;
9. mettre à jour la checklist et le journal de ce fichier ;
10. ne pas committer, pousser ou fusionner sans demande explicite de l'utilisateur.

Un agent principal est responsable du diff. Les sous-agents sont réservés aux
travaux indépendants et principalement en lecture seule : exploration, tests,
analyse de performances et relecture. Plusieurs agents ne doivent jamais
modifier simultanément les mêmes fichiers.

### Prompt d'ouverture d'une conversation d'implémentation

> Refactor Flamap, lot **N** de `refactor.md`.
>
> Lis `AGENTS.md` et `refactor.md` en entier avant toute modification. Inspecte
> aussi l'état Git et les lots déjà terminés.
>
> Fais uniquement le lot N. Pendant une extraction, conserve les mêmes noms,
> commentaires, valeurs, ordre d'initialisation et comportements. Toute idée
> hors périmètre va dans « Repéré en chemin ».
>
> Exécute les contrôles requis par le lot, puis demande à des sous-agents en
> lecture seule de rechercher les changements de comportement et les
> régressions de performances. Corrige les problèmes confirmés, mets à jour
> `refactor.md`, et montre le diff final. Ne committe ni ne pousse sans mon
> accord explicite.

### Prompt de relecture à froid

> Relis ce diff de refactorisation de Flamap avec `AGENTS.md` et `refactor.md`.
> Il est censé préserver strictement les fonctionnalités et les performances.
>
> Cherche uniquement : changement de comportement, ordre d'exécution modifié,
> variable auparavant partagée qui ne l'est plus, valeur capturée au chargement
> au lieu d'être lue à l'appel, listener perdu ou doublé, requête supplémentaire,
> boucle d'animation plus coûteuse, régression mobile, accessibilité ou repli
> réseau cassé. Donne des références de fichiers et de lignes. Ne propose pas
> de changement esthétique ou fonctionnel sans lien avec une régression.

---

## 2. Stratégie Git et worktrees

- Le chantier ne se fait jamais directement sur `main`, car tout push sur
  `main` peut déclencher une publication.
- Branche d'intégration recommandée : `codex/refactor-integration`.
- Une branche courte par lot : `codex/refactor-N-nom-du-lot`.
- Chaque branche de lot part de la branche d'intégration à jour et y revient
  seulement après vérification.
- Le front est refactoré séquentiellement. Le Python peut avancer en parallèle
  du front uniquement après le lot de référence et dans un worktree distinct.
- Si deux branches avancent en parallèle, une seule conversation coordinatrice
  met à jour le journal de ce fichier afin d'éviter les conflits.
- Un commit porte une seule préoccupation et doit être vérifiable et
  réversible. Un lot peut contenir plusieurs commits cohérents.
- Aucun message de commit ou de PR ne doit mentionner un agent IA, conformément
  à `AGENTS.md`.

`AGENTS.md` est actuellement un fichier local ignoré. Avant d'utiliser des
worktrees Codex, créer et suivre un fichier `.worktreeinclude` contenant :

```text
AGENTS.md
```

---

## 3. Règles absolues du chantier

### 3.1 Préservation fonctionnelle

- Une extraction ne doit ajouter, supprimer ou renommer aucune fonctionnalité.
- Une correction d'un défaut préexistant doit vivre dans un lot explicitement
  identifié comme correctif, jamais cachée dans un déplacement de code.
- L'ordre des sources et couches MapLibre reste identique.
- L'ordre d'attachement des listeners et l'ordre de démarrage restent identiques.
- Les formats des JSON et GeoJSON publics restent compatibles.
- Les URLs, paramètres, cadences, valeurs par défaut et textes restent
  inchangés sauf correction explicitement listée.
- Les replis en cas de données manquantes restent opérationnels.
- Le site doit fonctionner en HTTP statique sans étape de compilation.

### 3.2 Préservation des performances

- Aucun `setFilter` ne doit entrer dans la boucle d'animation temporelle.
- `applyBurnt()` ne doit pas être rappelé à chaque frame.
- Les boucles vent et fumée gardent leurs plafonds de particules, DPR et FPS.
- Aucun module ne doit créer une seconde boucle `requestAnimationFrame` pour un
  effet déjà piloté par une boucle existante.
- Les listeners `move`, `moveend`, `resize` et `visibilitychange` ne doivent pas
  être dupliqués par une réinitialisation de contrôleur.
- Le chargement des zones reste progressif, dédupliqué, borné et protégé par
  son jeton de course.
- Le nombre d'appels aux APIs externes reste identique. Les avions restent
  activés par défaut et leur polling s'arrête s'ils sont décochés, dans un
  onglet masqué ou au passé.
- L'extraction en modules conserve un graphe d'import peu profond. Éviter les
  dizaines de fichiers minuscules et les imports en cascade.
- Les nouveaux fichiers statiques doivent être copiés par les trois workflows
  de publication et correctement servis par GitHub Pages.

### 3.3 Architecture et dépendances

Sens autorisé des dépendances :

```text
config/utilitaires -> données/état -> fonctionnalités/effets/UI -> main
```

- `util` ne dépend ni du DOM, ni de MapLibre, ni d'un module métier.
- `state` ne contient ni instance MapLibre, ni élément DOM, ni cache réseau,
  ni particules.
- Les états du vent, de la fumée, des avions, des zones et des popups restent
  privés à leurs contrôleurs.
- Un module fonctionnel n'importe jamais `main.js`.
- Le module de création de carte n'importe pas les fonctionnalités.
- `main.js` est la seule racine qui connaît et assemble tous les contrôleurs.
- Les dépendances entre fonctionnalités passent par une petite API explicite
  ou des callbacks injectés, pas par des variables globales importées.
- Aucun objet mutable global ne doit remplacer le monolithe actuel.

---

## 4. Invariants historiques à protéger

Cette liste résume les points les plus exposés. `AGENTS.md` reste la référence
complète et ne doit pas être supprimé après le découpage.

- EFFIS émet ses coordonnées dans l'ordre `[lat, lon]` : `swap_axes()` reste
  obligatoire.
- EFFIS ne doit jamais être appelé depuis le front.
- Le démarrage MapLibre conserve le sondage de `isStyleLoaded()` et ne revient
  pas à un simple `map.on('load')`.
- Les crans EFFIS restent bornés à la fenêtre temporelle FIRMS.
- Le curseur reste fondé sur un timestamp continu en secondes epoch.
- La rampe d'ancienneté reste continue et la légende reste générée depuis la
  même source que le rendu de la carte.
- `lockWidths()` continue à figer les largeurs de la lecture et du vent.
- La ligne de vent conserve sa place quand le champ manque, mais disparaît
  lorsque la couche est désactivée.
- Les rafales restent déjà exprimées en km/h dans les fichiers produits.
- Les canvas de vent et de fumée gardent `width: 100%; height: 100%`.
- La grille de vent conserve sa marge de 60 km.
- Les prévisions restent désactivables avec `FORECAST_H` sans supprimer le
  mécanisme.
- Les surfaces brûlées utilisent l'opacité, pas `visibility`, pour leur fondu.
- Un seul routeur de clic carte et une seule popup restent actifs.
- `popTarget()` continue à écarter les objets transparents mais rendus.
- Les popups restent entre les nappes et les panneaux sans ajouter de
  `z-index` à `#map`.
- `fitPopup()` continue à dégager le dock mobile.
- Le point météo épinglé ne suit pas `moveend`.
- Le cadrage initial ne retient que les incendies significatifs et récents.
- Les crédits restent hors du flux du dock sur ordinateur.

---

## 5. Architecture cible du front

La cible reste volontairement compacte. Un module de fonctionnalité n'est
transformé en sous-dossier que s'il reste réellement trop gros après son
extraction.

```text
index.html
css/
  app.css                    # première extraction, ordre CSS inchangé
  tokens.css                 # phase de finition seulement
  base.css
  map.css
  components.css
  responsive.css
js/
  app.js                     # monolithe externe temporaire pendant la migration
  main.js                    # orchestration finale, remplace app.js à la fin
  config.js
  state.js                   # état partagé minimal, API contrôlée
  map/
    create-map.js
    base-style.js
  data/
    client.js
    initial.js
    zones.js
  timeline/
    model.js
    controller.js
    activity.js
  features/
    fires.js
    burnt.js
    weather.js
    psfdf.js
    aircraft.js
  fx/
    wind.js
    smoke.js
  ui/
    panel-manager.js
    popup-router.js
    popup-view.js
    legend.js
    layers-menu.js
    updates.js
  export/
    map-export.js
  util/
    format.js
    grid.js
    geo.js
```

### 5.1 État partagé

`state.js` peut porter uniquement les valeurs réellement transversales, par
exemple le timestamp courant, le dernier timestamp observé et la visibilité
des familles de couches.

Il ne doit pas exporter un objet modifiable directement. API attendue :

```js
getState()
setCurrentTime(timestamp)
setTimeline(steps)
setLayerVisibility(layer, visible)
subscribe(listener)
```

`steps` est une donnée initialisée une fois. Les contrôleurs conservent leur
état technique privé et exposent des méthodes explicites comme `setTime()`,
`setEnabled()`, `resize()` et `destroy()`.

### 5.2 Carte

`map/create-map.js` crée MapLibre, le fond IGN/Sentinel, les toponymes et les
contrôles généraux. Il ne connaît pas les couches métier.

Chaque fonctionnalité installe ses propres sources et couches via une API du
type :

```js
install(map)
setTime(timestamp)
setEnabled(enabled)
setData(data)
destroy()
```

### 5.3 Panneaux et popups

`panel-manager.js` centralise l'ouverture exclusive, `aria-expanded`, Escape,
le focus initial, le retour du focus et la fermeture extérieure.

`popup-router.js` possède la priorité des couches, `popTarget()` et le clic
unique sur la carte. `popup-view.js` fournit seulement les primitives communes.
Les fonctionnalités fabriquent le contenu de leur propre fiche.

---

## 6. Architecture cible du collecteur et des workflows

Le collecteur reste fondé sur la bibliothèque standard Python.

```text
flamap/
  __init__.py
  config.py
  http.py
  geo.py
  firms.py
  effis.py
  psfdf.py
  meteo.py
  timeline.py
  validation.py
  writer.py
fetch_fires.py              # CLI et orchestration seulement
scripts/
  download_live_artifact.py
  assemble_site.py
  validate_export.py
tests/
  python/
  js/
  fixtures/
```

- Les clients de source reçoivent une fonction HTTP injectable afin d'être
  testés avec des fixtures locales.
- Les exceptions réseau attendues sont distinguées des erreurs de programmation.
- Les données sont produites dans un répertoire de préparation, validées, puis
  substituées seulement après succès.
- Le manifeste reste le dernier point d'entrée publié.
- Les trois workflows appellent des scripts partagés au lieu de dupliquer de
  gros blocs Python inline.

---

## 7. Filet de sécurité et budgets de performance

### 7.1 Contrôles automatisés minimaux

Sans `package.json` ni dépendance supplémentaire :

```bash
python3 -m py_compile fetch_fires.py notify_telegram.py make_og.py
python3 -m unittest discover tests/python
find js -name '*.js' -print0 | while IFS= read -r -d '' file; do
  node --input-type=module --check < "$file"
done
node --experimental-default-type=module --test tests/js/*.test.js
```

Les commandes ne deviennent obligatoires qu'après la création des répertoires
concernés. Un workflow `checks.yml` doit les exécuter sur push et pull request.

### 7.2 Scénarios de référence à mesurer au lot 0

Servir le projet avec `python3 -m http.server 8777` et remplir le tableau :

| Mesure | Référence avant refactor | Seuil maximal après lot |
|---|---:|---:|
| Affichage initial de la carte, cache froid | à mesurer | +10 % ou +200 ms |
| Octets JS/CSS transférés, hors données | à mesurer | +5 % hors vendoring |
| Requêtes de données au démarrage | à mesurer | aucune supplémentaire |
| Coût de `show()` pendant la lecture | à mesurer | +10 % maximum |
| Frames perdues sur 30 s de lecture | à mesurer | +5 points maximum |
| Mémoire après 5 min vent + fumée | à mesurer | +10 % maximum |

Les mesures sont comparatives, sur la même machine et le même navigateur. Un
écart au-delà du seuil bloque le lot jusqu'à explication et correction. La
cible reste **zéro régression mesurable** : les tolérances du tableau absorbent
le bruit d'une mesure locale, elles n'autorisent pas un ralentissement. Une
hausse plus faible mais répétable sur plusieurs mesures doit elle aussi être
analysée et corrigée, ou explicitement soumise à l'utilisateur.

### 7.3 Vérification courte à chaque commit

- Syntaxe et tests disponibles.
- Chargement local sans nouvelle erreur console.
- Vérification ciblée de la fonctionnalité déplacée.
- Vérification du nombre de listeners et boucles d'animation concernés.
- Relecture du diff à froid.

### 7.4 Checklist complète avant fusion d'un lot

#### Carte et données

- [ ] La carte s'affiche avec le cadrage initial attendu.
- [ ] Les foyers suivent la rampe continue d'ancienneté.
- [ ] Les surfaces brûlées, contours et zones PSFDF sont visibles.
- [ ] Le zoom charge et décharge les zones détaillées sans erreur.
- [ ] Une zone manquante dégrade le détail sans casser la carte nationale.

#### Frise et lecture

- [ ] Le curseur atteint exactement les timestamps publiés.
- [ ] La lecture reprend, se met en pause et s'arrête au dernier cran.
- [ ] Les marques restent alignées avec le curseur.
- [ ] La largeur du curseur et de la légende ne varie pas entre les crans.
- [ ] Les surfaces brûlées apparaissent et disparaissent au même instant.

#### Vent et fumée

- [ ] Le vent s'anime, se redimensionne et s'arrête quand il est décoché.
- [ ] La fumée part des foyers récents et suit le vent.
- [ ] La légende du vent garde sa place si le champ manque.
- [ ] Un déplacement de carte ne duplique aucune boucle ou traînée.
- [ ] Les performances respectent les budgets de référence.

#### Panneaux et popups

- [ ] Un seul panneau principal est ouvert à la fois.
- [ ] Escape, focus et `aria-expanded` restent cohérents.
- [ ] Clic foyer, agrégat, périmètre, NRT, avion et fond de carte.
- [ ] Un objet transparent ne reçoit pas de clic.
- [ ] La météo d'une popup lit le timestamp courant.
- [ ] Un point météo épinglé reste fixe pendant un déplacement.
- [ ] Une seule popup reste ouverte et `fitPopup()` dégage le dock.

#### PSFDF et avions

- [ ] Les raccourcis et le panneau PSFDF affichent le même feu qu'avant.
- [ ] Le graphique d'activité locale conserve ses valeurs et son échelle.
- [ ] Les avions démarrent au chargement et s'arrêtent dès qu'ils sont décochés.
- [ ] Le polling avions s'arrête au passé et dans un onglet masqué.
- [ ] Les traces, libellés et popups des appareils restent cohérents.

#### Export

- [ ] PNG 1920 x 1080 identique dans son contenu et son cadrage.
- [ ] GIF instantané et GIF d'évolution fonctionnent.
- [ ] Vent et fumée exportés ne modifient pas l'état de la carte vivante.
- [ ] Le partage mobile et le téléchargement desktop restent opérationnels.

#### Responsive et accessibilité

- [ ] Vérification à 1440 px, 820 px, 375 px et 320 px.
- [ ] Aucun panneau ne recouvre une commande indispensable.
- [ ] Une popup mobile reste au-dessus du dock.
- [ ] Navigation clavier et focus visible sur les contrôles principaux.
- [ ] Le mode de réduction des animations conserve une interface utilisable.

#### Arrière-plan

- [ ] Ouvrir le site dans un onglet non actif, attendre 30 secondes, revenir :
      la carte est rendue et utilisable.
- [ ] Masquer l'onglet pendant la lecture puis revenir : aucun saut temporel.
- [ ] Vent, fumée et avions reprennent sans dupliquer leur boucle.

#### Publication

- [ ] Les workflows incluent tous les nouveaux fichiers CSS, JS et vendor.
- [ ] Les données générées restent absentes du diff Git.
- [ ] L'artefact Pages contient exactement les zones du manifeste.
- [ ] Le front publié fonctionne sans chemin absolu ni secret.

---

## 8. Lots de réalisation

Un lot ne commence que lorsque ses dépendances sont terminées. Les extractions
doivent rester mécaniques ; les nettoyages viennent après la stabilisation.

### Lot 0 — Socle du chantier et références

- [x] Suivre `refactor.md` et créer `.worktreeinclude` pour `AGENTS.md`.
- [x] Créer la branche d'intégration.
- [x] Mesurer et consigner les performances de référence.
- [x] Capturer des screenshots de référence desktop et mobile.
- [x] Documenter les requêtes réseau du chargement initial et des avions.
- [x] Ajouter les premiers contrôles de syntaxe sans changer l'application.

Critère de sortie : références reproductibles et chantier reprenable depuis une
nouvelle conversation.

### Lot 1 — Correctifs préexistants isolés

- [x] Ajouter l'import `shutil` manquant au workflow front.
- [x] Conserver les avions activés par défaut, conformément à la décision
      explicite de l'utilisateur.
- [x] Uniformiser les textes de fréquence sur 30 minutes.
- [x] Afficher un état d'erreur si l'initialisation principale échoue.
- [x] Vérifier chaque correction séparément.

Ce lot modifie intentionnellement des défauts connus. Il ne doit contenir aucun
déplacement architectural.

### Lot 2 — Filet de tests et CI

- [x] Créer les fixtures minimales FIRMS, EFFIS, PSFDF et météo.
- [x] Tester les dates PSFDF, `swap_axes`, les agrégats, la frise, les bornes
      géographiques et les exports météo.
- [x] Préparer les tests JavaScript purs sans `package.json`.
- [x] Ajouter `.github/workflows/checks.yml`.
- [x] Exécuter les tests sans réseau.

Critère de sortie : les règles métier les plus risquées échouent clairement en
cas de régression.

### Lot 3 — Extraction mécanique des assets

- [x] Déplacer le CSS inline, sans réordonner une règle, vers `css/app.css`.
- [x] Déplacer le grand script inline, sans le modulariser, vers `js/app.js`.
- [x] Conserver MapLibre et l'ordre d'exécution actuels pendant ce déplacement.
- [x] Adapter les trois workflows, leurs filtres de chemins et l'assemblage de
      l'artefact pour inclure `css/` et `js/`.
- [x] Vérifier que `index.html` ne contient plus que le HTML et les petits blocs
      indispensables au `<head>`.

Critère de sortie : diff mécanique, comportement et mesures identiques.

### Lot 4 — Utilitaires purs

- [x] Passer `js/app.js` en module ES natif.
- [x] Adapter le banc du lot 0 à une API de mesure explicite avant que `show`
      et l'état de lecture deviennent privés au module ; ne pas exposer d'objet
      mutable global pour cela.
- [x] Extraire `util/format.js`, `util/grid.js` et `util/geo.js`.
- [x] Extraire uniquement les fonctions sans DOM, MapLibre ou état global.
- [x] Ajouter des tests de caractérisation pour chaque fonction extraite.
- [x] Conserver les signatures et résultats numériques.

Critère de sortie : utilitaires testés, aucune nouvelle dépendance circulaire.

### Lot 5 — Modèle temporel et activité

- [x] Extraire la construction de la frise dans `timeline/model.js`.
- [x] Extraire le warp et les calculs d'activité purs.
- [x] Extraire le rendu/contrôleur dans `timeline/controller.js` et
      `timeline/activity.js` sans changer l'animation.
- [x] Tester timestamps irréguliers, publications EFFIS et moyennes mobiles.

Critère de sortie : calculs temporels testables sans carte ni DOM.

### Lot 6 — État partagé minimal

- [x] Introduire `state.js` avec getters, setters et abonnements contrôlés.
- [x] Ne migrer que l'état réellement transversal.
- [x] Garder les états techniques privés dans leurs blocs actuels.
- [x] Vérifier qu'aucune valeur dépendant du temps n'est capturée à l'import.

Critère de sortie : aucun objet mutable global exporté et aucune boucle créée
par un abonnement.

### Lot 7 — Chargement des données et des zones

- [x] Extraire le client JSON et le chargement initial.
- [x] Extraire le cache LRU, les zones visibles, la fusion et la déduplication.
- [x] Conserver le jeton anti-course et tous les replis.
- [x] Tester cache, zone absente, mouvement rapide et mode legacy.

Critère de sortie : mêmes requêtes, mêmes données MapLibre, cache toujours borné.

### Lot 8 — Vent et fumée

- [x] Extraire `fx/wind.js` avec état privé et API de contrôleur.
- [x] Extraire `fx/smoke.js` après le vent, avec injection de la lecture du vent.
- [x] Conserver les plafonds, timings, DPR, interpolation et reprises de boucle.
- [x] Vérifier redimensionnement, masquage d'onglet et déplacement de carte.

Critère de sortie : budgets de frames et mémoire respectés.

### Lot 9 — Foyers et surfaces brûlées

- [x] Extraire rampes, installation des couches et mises à jour des foyers.
- [x] Extraire installation et fondu des surfaces brûlées.
- [x] Conserver les expressions MapLibre et leur ordre à l'identique.
- [x] Tester les fonctions pures de rampe et les instants de bascule.

Critère de sortie : rendu visuel et coût de `show()` inchangés.

### Lot 10 — Météo, PSFDF et avions

Ce lot est obligatoirement exécuté en trois sous-lots et trois conversations
distinctes : `10A-weather`, `10B-psfdf`, puis `10C-aircraft`. Chaque sous-lot
doit être relu et intégré avant le suivant.

- [x] Sous-lot `10A-weather` : extraire le contrôleur météo, ses grilles, son
      cache de géocodage, son graphique et son point épinglé.
- [x] Sous-lot `10B-psfdf` : extraire le suivi et les graphiques PSFDF.
- [x] Sous-lot `10C-aircraft` : extraire les avions, leur historique et leur
      polling.
- [x] Extraire chaque fonctionnalité dans un contrôleur autonome.
- [x] Conserver l'état métier privé et injecter les dépendances temporelles.
- [x] Ne créer des sous-dossiers internes que si un module reste trop gros.
- [x] Vérifier polling, abort, caches, graphiques et repli météo.

Critère de sortie : fonctionnalités identiques et aucune requête supplémentaire.

### Lot 11 — Gestion commune des panneaux et popups

- [x] Introduire `panel-manager.js` sans changer la disposition.
- [x] Extraire le routeur de clic unique et les primitives de popup.
- [x] Laisser chaque fonctionnalité produire le contenu de sa fiche.
- [x] Vérifier focus, Escape, clic extérieur, priorité et objets transparents.

Critère de sortie : une seule popup, un seul panneau principal et mêmes fiches.

### Lot 12 — Export image et GIF

- [ ] Extraire l'export seulement après stabilisation des APIs carte, vent,
      fumée, temps et zones.
- [ ] Renommer le module `export/map-export.js`.
- [ ] Remplacer les accès directs aux états internes par des snapshots/APIs.
- [ ] Vérifier que l'état vivant est restauré même après erreur d'export.

Critère de sortie : PNG/GIF identiques et aucune boucle vivante perturbée.

### Lot 13 — Carte et orchestration finale

- [ ] Extraire la création de carte et le style de base.
- [ ] Laisser les fonctionnalités installer leurs couches métier.
- [ ] Réduire `js/app.js` à une composition explicite, puis le renommer
      `js/main.js`.
- [ ] Ajouter un chemin unique de démarrage, d'erreur et de destruction.
- [ ] Vérifier le démarrage en arrière-plan avant tout nettoyage.

Critère de sortie : `main.js` orchestre sans logique métier et sans cycle
d'import.

### Lot 14 — Découpage du collecteur Python

Ce lot est obligatoirement découpé par frontière de source : socle HTTP/géo,
FIRMS/frise, EFFIS/PSFDF, météo, puis écriture/orchestration. Une conversation
et un diff révisable par sous-lot.

- [ ] Créer le package `flamap/` selon l'architecture cible.
- [ ] Déplacer une source à la fois avec tests et fixtures.
- [ ] Garder `fetch_fires.py` comme CLI compatible.
- [ ] Réduire les `except Exception` aux frontières réellement facultatives.
- [ ] Introduire l'écriture en répertoire de préparation et la validation avant
      substitution.

Critère de sortie : mêmes fichiers produits sur les fixtures, CLI inchangée et
aucune donnée partielle substituée.

### Lot 15 — Simplification des workflows

- [ ] Extraire reprise, assemblage et validation dans `scripts/`.
- [ ] Paramétrer les différences fire/front/weather sans dupliquer le code.
- [ ] Conserver les verrous, délais, replis et validations actuels.
- [ ] Tester les trois modes sur des fixtures d'artefact.

Critère de sortie : YAML déclaratif, artefacts équivalents et replis conservés.

### Lot 16 — Finition CSS, dépendances et sécurité

- [ ] Découper `css/app.css` seulement après stabilisation fonctionnelle.
- [ ] Extraire les vrais tokens communs sans remplacer mécaniquement les IDs.
- [ ] Vendorer des versions exactes de MapLibre et `gifenc` avec leurs licences.
- [ ] Mesurer à nouveau taille et chargement après vendoring.
- [ ] Construire une CSP à partir de l'inventaire réel : scripts, styles,
      connexions, tuiles, fontes, images, workers, `blob:` et `data:`.
- [ ] Ajouter `prefers-reduced-motion` sans rendre les données inaccessibles.

Critère de sortie : dépendances reproductibles, CSP fonctionnelle et budgets
de performance respectés.

### Lot 17 — Revue finale et retrait du chantier

- [ ] Exécuter toute la checklist sur desktop et mobile.
- [ ] Comparer toutes les mesures aux références du lot 0.
- [ ] Faire une relecture parallèle : comportement, performances,
      accessibilité, données et workflows.
- [ ] Vérifier l'absence de secret, chemin absolu et donnée générée.
- [ ] Mettre à jour README, SOURCES et AGENTS seulement si l'architecture finale
      l'exige.
- [ ] Fusionner vers `main` uniquement après validation explicite.
- [ ] Décider de conserver ce fichier comme historique ou de le supprimer.

---

## 9. Journal du chantier

| Lot | Statut | Branche/commit | Date | Vérifications et notes |
|---:|---|---|---|---|
| 0 | terminé | `codex/refactor-0-socle` | 2026-08-01 | Références et protocole dans `docs/refactor/lot-0-baseline.md` ; captures 1440/375 px ; trois séries mémoire, deux lectures finales ; syntaxe Python/JS et console vérifiées ; doubles relectures comportement/performance. |
| 1 | terminé | `codex/refactor-1-correctifs` | 2026-08-02 | Points du lot vérifiés séparément ; avions conservés actifs par défaut sur décision explicite de l'utilisateur, avec 1 requête d'historique et 2 requêtes Airplanes.live observées dans les 5 premières secondes ; syntaxe Python/JS, bloc Python du workflow et `git diff --check` valides ; échec des données forcé et état d'erreur contrôlé ; initialisation finale à 401 ms, carte prête à 1 331 ms et aucune requête de données supplémentaire ; rendu desktop 1440 px et console contrôlés ; relecture à froid sans régression confirmée ; validation mobile 375 px confirmée par l'utilisateur. |
| 2 | terminé | `codex/refactor-2-tests-ci` | 2026-08-02 | Fixtures locales FIRMS, EFFIS, PSFDF et météo ; garde réseau actif avant l'import du collecteur ; 11 tests Python et 7 tests JavaScript purs valides sous Python 3.12 et Node 22, y compris sous plusieurs fuseaux ; syntaxe Python/JS, YAML et `git diff --check` valides ; doubles relectures comportement et CI/performance sans constat résiduel. Après validation du lot, correction séparée demandée explicitement : les 30 minutes de traces d'avions sont conservées et rendues dès l'amorçage VPS, avec 3 tests de non-régression et documentation alignée. |
| 3 | terminé | `codex/refactor-3-assets` | 2026-08-02 | CSS et JavaScript extraits byte à byte (empreintes identiques aux blocs inline) ; ordre MapLibre et exécution classique conservés ; trois workflows adaptés et artefact local contrôlé ; 11 tests Python et 7 tests JavaScript, syntaxe Python/JS, YAML et `git diff --check` valides ; assets servis en 200 avec les bons types MIME ; 11 requêtes de données inchangées ; médianes courtes à 633 ms pour l'initialisation et 1 492 ms pour la carte prête ; lecture longue : `show()` à 0,75/0,70/0,90 ms moyenne/médiane/p95, aucune frame perdue, mémoire médiane à 26 510 731 octets (+4,3 %) ; rendu et console contrôlés à 1440, 820, 375 et 320 px ; relecture à froid sans régression confirmée. Le navigateur intégré garde `visibilityState=visible` entre ses onglets : le scénario réellement masqué n'y est pas reproductible, mais le démarrage et son listener sont inchangés dans l'extraction. |
| 4 | terminé | `codex/refactor-4-utilitaires` | 2026-08-02 | `app.js` passé en module natif ; utilitaires de formatage, grille et géométrie extraits mécaniquement et couverts par 11 nouveaux tests (18 JS au total). API de mesure gelée, état privé et banc lot 0 adapté ; 11 requêtes de données et séquence avions inchangées. Front propriétaire à 277 645 octets bruts (+0,76 %) et 83 577 octets gzip (+2,56 %). Comparaison directe lot 3/lot 4 à 120 Hz : initialisation 555/545,9 ms, carte prête 1 701,1/1 703,1 ms, 3 600 frames et 14 manquées dans les deux cas, `show()` 1,175/1,152 ms de moyenne et 1,3/1,3 ms au p95, aucune hausse mémoire. 11 tests Python, syntaxe, YAML, artefact, `git diff --check`, fuseaux UTC/Honolulu et rendu 1440/820/375/320 px contrôlés ; doubles relectures à froid sans constat. |
| 5 | terminé | `codex/refactor-5-timeline` | 2026-08-02 | Modèle de frise, prévisions, warp et contrôleurs de lecture/activité extraits ; 21 tests JS et 11 tests Python valides, dont timestamps irréguliers, bornage EFFIS, prévisions et moyennes mobiles compte/FRP ; syntaxe, YAML, bloc Python du workflow météo, fuseaux UTC/Honolulu et `git diff --check` contrôlés. Les trois workflows publient les nouveaux modules ; 11 requêtes de données inchangées. Front propriétaire brut à 282 927 octets (+1,9 % sur le lot 4). Banc complet : initialisation 845,5 ms, carte prête 1 816,9 ms, aucune frame perdue sur 30 s, `show()` à 1,02/1,00/1,20 ms moyenne/médiane/p95, mémoire médiane à 25 366 145 octets après cinq minutes. Lecture, pause, curseur et largeurs vérifiés ; graphiques national et PSFDF, métriques compte/FRP et rendu 1440/820/375/320 px contrôlés. Double relecture à froid : aucune régression comportementale ; lecture de l'état de lecture sortie de la boucle des particules après constat performance, correctif confirmé. Comme aux lots 3 et 4, le navigateur intégré ne permet pas de rendre réellement l'onglet masqué ; le listener `visibilitychange` et son ordre ont été conservés et relus. |
| 6 | terminé | `codex/refactor-6-state` | 2026-08-02 | Store sans DOM ni MapLibre, snapshots et frise immuables, abonnements synchrones sans boucle ; seuls frise, dernier instant observé, heure courante et visibilité transversale sont migrés. 11 tests Python et 22 tests JS, syntaxe, YAML, artefact et `git diff --check` valides ; listeners, rAF, `fetch`, `setFilter` et appels à `applyBurnt()` inchangés. Rendu et interactions contrôlés à 1440/820/375/320 px, 10 requêtes de données présentes plus le 404 thermique attendu. Taille brute/gzip à +1,43/+1,41 % sur le lot 5. Comparaison directe 120 Hz : `show()` à 1,34/1,30/1,50 ms moyenne/médiane/p95 contre 1,30/1,30/1,50 ms au lot 5, 14 frames manquées contre 35 ; mémoire à 30,6–30,9 Mo contre 45,1 Mo au lot 5. Relecture à froid sans régression confirmée. Le masquage réel d'onglet reste non reproductible dans le navigateur intégré ; le listener `visibilitychange` et son ordre sont inchangés. |
| 7 | terminé | `codex/refactor-7-data-zones` | 2026-08-02 | Client JSON, chargement initial et contrôleur de zones extraits avec cache et état privés ; ordre des requêtes, repli PSFDF, repli legacy, jeton anti-course, fusion et déduplication conservés. 9 nouveaux tests couvrent succès et données MapLibre, cache LRU, zone absente, mouvement rapide et legacy ; 11 tests Python et 31 tests JS, syntaxe, YAML et `git diff --check` valides. Les trois workflows publient les modules ; front brut/gzip à +0,69/+1,44 % sur le lot 6. Mode legacy, lecture et largeur du curseur, console, canvas et rendu contrôlés à 1440/820/375/320 px ; relecture à froid corrigée puis rejouée sans constat résiduel. |
| 8 | terminé | `codex/refactor-8-wind-smoke` | 2026-08-02 | Contrôleurs vent et fumée extraits avec grilles, particules, dimensions et rAF privés ; lecture du vent injectée dans la fumée et APIs ciblées pour météo, zones et export. Un nouveau test contrôle DPR, arrêt/reprise et absence de boucle dupliquée : 32 tests JS et 11 tests Python valides, syntaxe et `git diff --check` contrôlés. rAF, annulations, listeners, `fetch` et `setFilter` inchangés ; 11 requêtes de données. Front brut/gzip à +1,71/+2,81 % sur le lot 7. Banc long : initialisation 678 ms, carte prête 1 569 ms, aucune frame manquée sur 30 s, `show()` à 1,18/1,20/1,40 ms moyenne/médiane/p95, mémoire médiane à 27 612 567 octets utilisés et 33 486 208 octets alloués. Redimensionnement, zoom, lecture, arrêt/reprise des effets, console et rendu contrôlés à 1440/820/375/320 px ; relecture à froid corrigée puis rejouée sans constat résiduel. Le navigateur intégré ne rend toujours pas l'onglet réellement masqué ; le listener `visibilitychange`, son ordre et les gardes `document.hidden` ont été conservés et relus. |
| 9 | terminé | `codex/refactor-9-fires-burnt` | 2026-08-02 | Rampes, expressions, filtres et couches des foyers extraits dans `features/fires.js` ; couches, visibilité et fondu EFFIS extraits dans `features/burnt.js`. Quatre nouveaux tests portent le total à 36 tests JS, avec 11 tests Python ; syntaxe, YAML et `git diff --check` valides. Ordre des couches, appels `setFilter`, `applyBurnt()`, listeners, rAF et requêtes inchangés ; 11 requêtes de données au banc. Comparaison isolée lot 8/lot 9 à 120 Hz : `show()` à 0,827/0,800/1,000 ms contre 0,820/0,800/1,000 ms moyenne/médiane/p95, 14 contre 15 frames manquées sur 3 600. La mémoire absolue du processus était contaminée par les séries précédentes, mais la répétition directe lot 9/lot 8 ne montre aucune hausse (43,9 contre 44,7 Mo utilisés ; 100 contre 101 Mo alloués). Front brut/gzip à +0,07/+0,32 % sur le lot 8. Passage passé/dernier instant, bascules foyers/EFFIS, export, console, canvas et rendu 1440/820/375/320 px contrôlés ; double relecture à froid sans constat résiduel. L'omission préexistante des modules `fx/` dans le workflow météo est consignée dans « Repéré en chemin ». |
| 10 | terminé | `codex/refactor-10c-aircraft` | 2026-08-02 | Sous-lot 10A terminé : panneau, géocodage/cache, grilles thermique et de repli, graphique, point épinglé et badge extraits dans un contrôleur à état privé ; temps du vent, manifeste et callbacks de panneaux injectés. Deux tests de caractérisation portent le total à 38 tests JS, avec 11 tests Python ; syntaxe Python/JS, YAML et `git diff --check` valides. Listeners, rAF, `fetch`, `setFilter`, appels à `applyBurnt()` et deux requêtes météo initiales inchangés ; front brut à +1,02 % sur le lot 9. Panneau, fiche, point épinglé, recentrage, repli sans grille thermique, console et rendu contrôlés à 1440/820/375/320 px. Le `thermal.json` local manque, comme autorisé : le graphique complet est couvert avec fixture et le repli visuel a été vérifié. Relecture à froid sans constat résiduel. Sous-lot 10B terminé : couches, filtrage des signalements récents, raccourcis, panneau de suivi et graphique local PSFDF extraits dans `features/psfdf.js`, avec état privé et dépendances temporelles injectées ; l’accès des avions passe par une requête de proximité ciblée. Deux tests de caractérisation portent le total à 40 tests JS, avec 11 tests Python ; syntaxe Python/JS et `git diff --check` valides. `fetch`, rAF, timers, listeners MapLibre et `setFilter` inchangés ; front brut/gzip à +0,87/+1,54 % sur 10A. Raccourcis, métriques foyers/FRP, bascule passé/présent, case PSFDF, proximité avions, console et rendu contrôlés à 1440/820/375/320 px ; relecture à froid corrigée puis rejouée sans constat résiduel. Sous-lot 10C terminé : avions, historique, traces, polling, aborts, icônes, couches et fiche extraits dans `features/aircraft.js`, avec état privé et lectures temporelles/PSFDF injectées. Les 40 tests JS et 11 tests Python, syntaxe, workflow météo et `git diff --check` sont valides ; nombres de rAF, timers, aborts et listeners inchangés, deux requêtes aériennes inchangées, front brut/gzip à +1,17/+2,84 % sur 10B. Démarrage actif, arrêt/reprise par case, masquage au passé, retour au direct, console et rendu contrôlés à 1440 et 375 px ; relecture à froid corrigée puis rejouée sans constat résiduel. |
| 11 | terminé | `codex/refactor-11-panels-popups` | 2026-08-02 | Coordination d’exclusivité des panneaux extraite dans `ui/panel-manager.js` en conservant les fermetures et retours de focus propres à chaque panneau ; état, ancrage, recadrage et timer des fiches extraits dans `ui/popup-view.js` ; priorité, tolérance tactile et rejet des objets transparents extraits dans `ui/popup-router.js`. Trois tests portent le total à 43 tests JS, avec 11 tests Python ; syntaxe Python/JS et `git diff --check` valides. Ordre du clic carte, listeners, rAF, timers, `setFilter` et requêtes inchangés ; le workflow météo publie les trois modules. Exclusivité Calques/Météo, focus, Escape, clic extérieur, unicité des popups, fiche météo du fond de carte et rendu contrôlés à 1440 et 375 px ; relecture à froid corrigée puis rejouée sans constat résiduel. |
| 12 | à faire | | | |
| 13 | à faire | | | |
| 14 | à faire | | | |
| 15 | à faire | | | |
| 16 | à faire | | | |
| 17 | à faire | | | |

Statuts autorisés : `à faire`, `en cours`, `bloqué`, `terminé`.

---

## 10. Repéré en chemin

Noter ici les idées qui ne font pas partie du lot courant. Ne jamais les
implémenter opportunément dans un diff d'extraction.

- Évaluer des variables CSS pour les valeurs visuelles réellement répétées :
  fond, rayon, flou, durée de fondu et taille tactile.
- Extraire seulement les tokens de marque réellement communs à `index.html`,
  `social.html` et `mentions-legales.html`.
- Étudier une stratégie de cache-busting fondée sur la génération appropriée à
  chaque fichier, en respectant la cadence indépendante de `thermal.json`.
- Évaluer la spécificité CSS sélecteur par sélecteur ; conserver les IDs pour
  les éléments réellement uniques.
- Ne mémoïser les lectures de styles calculés qu'après mesure et seulement pour
  les tokens garantis immuables.
- Les trois assemblages de publication omettent actuellement `fonts/`, alors
  que le front précharge `fonts/instrument-sans-latin.woff2` ; traiter ce défaut
  préexistant dans un lot correctif explicite, sans le mêler à l'extraction des
  assets du lot 3.
- `update-weather-deploy.yml` reprend le front depuis une liste explicite qui
  omet déjà `js/fx/wind.js` et `js/fx/smoke.js` depuis le lot 8 ; traiter ce
  défaut préexistant dans un lot correctif explicite, sans le mêler à
  l'extraction des foyers et surfaces brûlées du lot 9.

---

## 11. Conditions d'arrêt

Un lot doit s'arrêter et demander une décision si :

- préserver le comportement exige une modification fonctionnelle non prévue ;
- une dépendance circulaire impose de changer l'architecture cible ;
- une mesure dépasse un budget de performance ;
- une vérification ne peut pas être exécutée dans l'environnement disponible ;
- le diff recouvre des modifications utilisateur non liées ;
- une source externe ou une donnée nécessaire manque pour valider le résultat ;
- le lot devient trop grand pour être relu avec confiance.

Dans ce dernier cas, découper le lot dans ce document avant de poursuivre.
