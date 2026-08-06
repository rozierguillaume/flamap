import { t } from '../i18n.js';
import { EMPTY } from '../data/client.js';
import { fetchFireDetail } from './api.js';
import { fitBoundsForFire, toBurnt, toHotspots } from './adapt.js';
import { createFireState } from './state.js';
import { createMap } from '../map/create-map.js';
import {
  createAgeRamps, createFiresController, MAX_AGE, zoomScaleFor,
} from '../features/fires.js';
import { createBurntController } from '../features/burnt.js';
import { PSFDF_COLORS } from '../features/psfdf.js';
import { createWindController } from '../fx/wind.js';
import { buildSteps } from '../timeline/model.js';
import { createTimelineController } from '../timeline/controller.js';
import { createPopupRouter } from '../ui/popup-router.js';
import { createPopupView, popEl, popRoot, popRow } from '../ui/popup-view.js';
import { confidenceText, fmt, fmtClock, nf } from '../util/format.js';

const MOBILE = matchMedia('(max-width: 720px)').matches;
const V = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const PLAY_MS = MOBILE ? 19000 : 23000;

const STATUS_SEVERITY = ['Hors de contrôle', 'En cours', 'Fixé', 'Maîtrisé', 'Éteint'];

// Même occupation du sol qu'en page d'accueil (main.js::coverBlock), dupliquée
// ici : js/archive/ ne doit jamais importer main.js (AGENTS.md §5).
const BURNT_COVER = ['CONIFER', 'BROADLEA', 'MIXED', 'SCLEROPH', 'TRANSIT',
                     'OTHERNATLC', 'AGRIAREAS', 'ARTIFSURF', 'OTHERLC'];

function coverBlock(p) {
  const rows = BURNT_COVER
    .map(key => [t(`cover.${key}`), Number(p[key])])
    .filter(([, share]) => Number.isFinite(share) && share >= 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4);
  if (!rows.length) return null;
  const block = popEl('div', 'cover');
  for (const [label, share] of rows) {
    const line = popEl('span');
    line.style.setProperty('--p', `${Math.min(100, share).toFixed(0)}%`);
    line.append(popEl('em', '', label), popEl('b', '', `${nf(share)} %`));
    block.append(line);
  }
  return block;
}

function hotspotPopup(feature) {
  const p = feature.properties;
  const root = popRoot(t('popup.hotspot.title'), `${p.source} — ${fmt(p.ts)}`);
  const frp = Number(p.frp);
  if (Number.isFinite(frp)) {
    const big = popEl('div', 'big', `${nf(frp, 1)} `);
    big.append(popEl('span', 'unit', t('popup.hotspot.frp')));
    root.append(big);
  }
  popRow(root, confidenceText(p.confidence), 'row dim');
  return root;
}

function burntPopup(feature) {
  const p = feature.properties;
  const place = p.COMMUNE || p.PROVINCE || t('popup.burnt.title');
  const root = popRoot(place, [p.COMMUNE ? p.PROVINCE : '', t('popup.burnt.sub')]
    .filter(Boolean).join(' — '));
  const area = Number(p.AREA_HA);
  if (Number.isFinite(area)) {
    const big = popEl('div', 'big', `${nf(area)} `);
    big.append(popEl('span', 'unit', 'ha'));
    root.append(big);
  }
  if (p.ts) popRow(root, t('archive.burnt.start', { date: fmt(p.ts) }));
  const cover = coverBlock(p);
  if (cover) root.append(cover);
  return root;
}

function statusBadge(status) {
  const badge = popEl('span', 'archive-badge',
    status ? t(`status.${status}`) : t('status.unknown'));
  if (PSFDF_COLORS[status]) badge.style.setProperty('--incident-color', PSFDF_COLORS[status]);
  return badge;
}

// `summary.first_ts`/`last_ts` datent la première et la dernière fiche PSFDF
// archivée (voir docs/refactor/FRONT_ARCHIVE_INCENDIES.md §4) — pas l'étendue
// réelle du feu, qui peut n'avoir qu'un seul statut connu alors que les
// détections satellite et périmètres EFFIS couvrent plusieurs jours. On
// affiche donc plutôt le [min, max] des crans de la frise, seule donnée qui
// reflète ce que la page rejoue réellement.
function renderSummary(el, summary, steps) {
  el.innerHTML = '';
  el.append(popEl('h2', '', summary.commune || t('archive.commune.unknown')));
  if (summary.departement) el.append(popEl('p', 'archive-sub', summary.departement));
  el.append(statusBadge(summary.status));
  const [start, end] = steps && steps.length
    ? [steps[0].ts, steps[steps.length - 1].ts]
    : [summary.first_ts, summary.last_ts];
  el.append(popEl('p', 'archive-dates', `${fmt(start)} → ${fmt(end)}`));
  if (Number.isFinite(summary.surface_max)) {
    const big = popEl('div', 'archive-surface', `${nf(summary.surface_max)} `);
    big.append(popEl('span', 'unit', t('archive.surface.max')));
    el.append(big);
  }
  // L'ordre des statuts n'est pas chronologique côté API (triés alphabétiquement) :
  // on ne prétend pas restituer une trajectoire, seulement l'ensemble traversé.
  if (Array.isArray(summary.statuses) && summary.statuses.length > 1) {
    const traversed = STATUS_SEVERITY.filter(s => summary.statuses.includes(s));
    el.append(popEl('p', 'archive-statuses', t('archive.statuses',
      { list: traversed.map(status => t(`status.${status}`)).join(', ') })));
  }
}

/* Vitesse de lecture au voisinage de `ts`, convertie en durée de naissance à
 * l'écran — même formule que main.js::appearAt, pour le même effet visuel de
 * naissance des foyers. Dupliquée : main.js ne l'exporte pas et ne doit pas
 * l'être pour cette seule page secondaire. */
const BIRTH_S = .55;
function appearAt(timelineController, ts) {
  if (!timelineController.isConfigured()) return 45 * 60;
  const q = timelineController.progressAtTime(ts), h = .004;
  const speed = (timelineController.timeAtProgress(Math.min(q + h, 1))
               - timelineController.timeAtProgress(Math.max(q - h, 0)))
              / (2 * h * timelineController.getPlayDuration() / 1000);
  return Math.min(Math.max(speed * BIRTH_S, 10 * 60), 4 * 3600);
}

/* La nappe rejoue le vent qu'il faisait, pas celui qu'il fait : l'API renvoie
 * les grilles archivées sur la fenêtre du feu, déjà découpées sur son emprise.
 * Deux mailles, exactement comme en page d'accueil — un champ de fond par
 * région, des tuiles fines là où la cellule était active — et le contrôleur de
 * `js/fx/wind.js` les consomme sans rien savoir de l'archive.
 *
 * `detail_zoom: 0` parce qu'ici le fondu des tuiles fines ne doit dépendre
 * d'aucun seuil de zoom : la page ne montre qu'un feu, déjà cadré dessus, là
 * où l'accueil s'en sert pour ne pas charger le détail au niveau national.
 * Même raison que `firesController.install({ detail_zoom: 0 })` plus bas. */
function installWind(map, wind) {
  const fields = wind?.fields || [];
  const tiles = wind?.tiles || [];
  const key = document.getElementById('windkey');
  const canvas = document.getElementById('archive-wind');
  if (!fields.length && !tiles.length) {
    // Feu antérieur à l'archivage du vent : la ligne disparaît, elle ne
    // réserve pas une place pour une lecture qui ne viendra jamais.
    key.classList.add('off');
    return null;
  }
  key.classList.remove('off');
  const controller = createWindController({
    mobile: MOBILE,
    map,
    canvas,
    key,
    value: document.getElementById('windval'),
    getManifest: () => ({ detail_zoom: 0 }),
  });
  controller.configure(fields[0]);
  for (const field of fields.slice(1)) controller.addField(field);
  controller.setTiles(tiles);
  controller.resize();
  map.on('move', () => {
    controller.sync();
    // La traînée est peinte en coordonnées écran : la laisser pendant un
    // déplacement la ferait glisser avec la carte, décalée du champ.
    controller.clear();
    controller.badge();
  });
  map.on('resize', () => controller.resize());
  return controller;
}

// `elements` : { mapContainerId, dock, slider, playBtn, clockEl, summaryEl, statusEl }
export async function openFire(id, elements) {
  const detail = await fetchFireDetail(id);
  if (!detail) return { notFound: true, destroy: () => {} };

  const { summary, firms, effis, wind } = detail;

  const hotspots = toHotspots(firms);
  const burnt = toBurnt(effis);
  const steps = buildSteps(hotspots, burnt);
  renderSummary(elements.summaryEl, summary, steps);
  elements.statusEl.textContent = '';
  if (!steps.length) {
    elements.statusEl.textContent = t('archive.tooShort');
    return { notFound: false, destroy: () => {} };
  }

  const fireState = createFireState();
  fireState.setTimeline(steps);

  const map = createMap({
    maplibregl, mobile: MOBILE, container: elements.mapContainerId, hash: false,
  });

  let timelineController = null;
  let windController = null;
  let popupClick = null;
  let ready = false;
  let poll = null;

  function fitToFire() {
    const bounds = fitBoundsForFire(summary, hotspots, burnt);
    if (!bounds) return;
    map.fitBounds(bounds, { padding: 24, duration: 0 });
  }

  function setup() {
    map.addSource('hs', { type: 'geojson', data: hotspots });
    map.addSource('overview-hs', { type: 'geojson', data: hotspots });
    map.addSource('nrt', { type: 'geojson', data: EMPTY });
    map.addSource('dated', { type: 'geojson', data: burnt });
    map.addSource('recent', { type: 'geojson', data: EMPTY });

    const ramps = createAgeRamps({
      mobile: MOBILE, front: V('--front'), hot: V('--hot'),
      recent: V('--recent'), old: V('--old'),
    });
    const firesController = createFiresController({
      map, ramps, zoomScale: zoomScaleFor(MOBILE), value: V,
    });
    const burntController = createBurntController({ map, getState: fireState.getState, value: V });
    // detail_zoom: 0, legacy: true masque hotspots-overview/recent-* (maxzoom
    // 0) et rend hotspots/burnt-* visibles à tout zoom — voir js/archive/detail.js
    // dans le plan : un feu isolé n'a pas de logique d'agrégation par zone.
    firesController.install({ detail_zoom: 0, legacy: true });
    burntController.install({ detail_zoom: 0, legacy: true });

    windController = installWind(map, wind);

    let renderedAtLatest = true;
    function show(ts) {
      const { atLatest, lastObservedTime } = fireState.getState();
      firesController.setTime(ts, lastObservedTime, appearAt(timelineController, ts));
      // Le champ n'est refabriqué qu'au changement d'heure : `setTime` écarte
      // lui-même les appels rapprochés, la lecture peut donc l'appeler à chaque
      // frame sans coût.
      windController?.setTime(ts);
      if (renderedAtLatest !== atLatest) {
        renderedAtLatest = atLatest;
        burntController.paint(map, atLatest);
      }
      const clock = fmtClock(ts);
      if (clock !== elements.clockEl.textContent) elements.clockEl.textContent = clock;
    }

    timelineController = createTimelineController({
      mobile: MOBILE,
      slider: elements.slider,
      playBtn: elements.playBtn,
      playMs: PLAY_MS,
      trackUsage: () => {},
      getSteps: () => fireState.getState().steps,
      getCurrentTime: () => fireState.getState().currentTime,
      setCurrentTime: fireState.setCurrentTime,
      show,
      smokeTime: () => {},
      smokeLoop: () => {},
    });

    const popupView = createPopupView({ map, maplibregl, dock: elements.dock });
    const popupRouter = createPopupRouter({
      map, mobile: MOBILE,
      layers: ['hotspots', 'burnt-fill'],
      isPointLayer: layerId => layerId === 'hotspots',
      isAlwaysVisible: () => false,
      getAtLatest: () => fireState.getState().atLatest,
      getShownTime: () => fireState.getState().currentTime,
      maxAge: MAX_AGE,
      onGround: () => {},
      onFeature: (hit, event) => {
        const content = hit.id === 'hotspots' ? hotspotPopup(hit.feature) : burntPopup(hit.feature);
        popupView.open(event.lngLat, content, hit.id);
      },
    });
    popupClick = event => popupRouter.click(event);
    map.on('click', popupClick);

    timelineController.configure();
    timelineController.installSliderListener();
    timelineController.installPlayListener();
    fitToFire();
    // passe par setTime() (pas show() directement) pour positionner aussi le
    // curseur — voir main.js::init(), même séquence.
    timelineController.setTime(fireState.getState().lastObservedTime);
    map.resize();
  }

  function whenReady() {
    if (ready || !map.isStyleLoaded()) return;
    ready = true;
    clearInterval(poll);
    setup();
  }
  map.on('style.load', whenReady);
  map.on('load', whenReady);
  poll = setInterval(whenReady, 80);

  // Onglet masqué : `requestAnimationFrame` gèle, la nappe n'a rien à animer.
  // Au retour, `loop()` la relance — sans quoi elle resterait figée pour de bon.
  function visibilityChange() {
    windController?.loop();
  }
  document.addEventListener('visibilitychange', visibilityChange);

  function destroy() {
    clearInterval(poll);
    timelineController?.stop();
    document.removeEventListener('visibilitychange', visibilityChange);
    // Coupe la boucle rAF et efface la traînée : sans ça, la nappe du feu
    // précédent continuerait de tourner derrière la liste.
    windController?.setEnabled(false);
    windController = null;
    if (popupClick) map.off('click', popupClick);
    map.remove();
  }

  return { notFound: false, destroy };
}
