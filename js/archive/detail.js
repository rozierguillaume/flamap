import { EMPTY } from '../data/client.js';
import { fetchFireDetail } from './api.js';
import { fitBoundsFor, toBurnt, toHotspots } from './adapt.js';
import { createFireState } from './state.js';
import { createMap } from '../map/create-map.js';
import {
  createAgeRamps, createFiresController, MAX_AGE, zoomScaleFor,
} from '../features/fires.js';
import { createBurntController } from '../features/burnt.js';
import { PSFDF_COLORS } from '../features/psfdf.js';
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
const BURNT_COVER = [
  ['CONIFER', 'conifères'], ['BROADLEA', 'feuillus'], ['MIXED', 'forêt mixte'],
  ['SCLEROPH', 'maquis, garrigue'], ['TRANSIT', 'landes, recrû'],
  ['OTHERNATLC', 'autres milieux naturels'], ['AGRIAREAS', 'surfaces agricoles'],
  ['ARTIFSURF', 'surfaces bâties'], ['OTHERLC', 'autres'],
];

function coverBlock(p) {
  const rows = BURNT_COVER
    .map(([key, label]) => [label, Number(p[key])])
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
  const root = popRoot('Foyer détecté', `${p.source} — ${fmt(p.ts)}`);
  const frp = Number(p.frp);
  if (Number.isFinite(frp)) {
    const big = popEl('div', 'big', `${nf(frp, 1)} `);
    big.append(popEl('span', 'unit', 'MW rayonnés'));
    root.append(big);
  }
  popRow(root, confidenceText(p.confidence), 'row dim');
  return root;
}

function burntPopup(feature) {
  const p = feature.properties;
  const place = p.COMMUNE || p.PROVINCE || 'Périmètre brûlé';
  const root = popRoot(place, [p.COMMUNE ? p.PROVINCE : '', 'périmètre EFFIS']
    .filter(Boolean).join(' — '));
  const area = Number(p.AREA_HA);
  if (Number.isFinite(area)) {
    const big = popEl('div', 'big', `${nf(area)} `);
    big.append(popEl('span', 'unit', 'ha'));
    root.append(big);
  }
  if (p.ts) popRow(root, `Départ le ${fmt(p.ts)}`);
  const cover = coverBlock(p);
  if (cover) root.append(cover);
  return root;
}

function statusBadge(status) {
  const badge = popEl('span', 'archive-badge', status || 'Statut inconnu');
  if (PSFDF_COLORS[status]) badge.style.setProperty('--incident-color', PSFDF_COLORS[status]);
  return badge;
}

function renderSummary(el, summary) {
  el.innerHTML = '';
  el.append(popEl('h2', '', summary.commune || 'Commune inconnue'));
  if (summary.departement) el.append(popEl('p', 'archive-sub', summary.departement));
  el.append(statusBadge(summary.status));
  el.append(popEl('p', 'archive-dates', `${fmt(summary.first_ts)} → ${fmt(summary.last_ts)}`));
  if (Number.isFinite(summary.surface_max)) {
    const big = popEl('div', 'archive-surface', `${nf(summary.surface_max)} `);
    big.append(popEl('span', 'unit', 'ha (surface maximale connue)'));
    el.append(big);
  }
  // L'ordre des statuts n'est pas chronologique côté API (triés alphabétiquement) :
  // on ne prétend pas restituer une trajectoire, seulement l'ensemble traversé.
  if (Array.isArray(summary.statuses) && summary.statuses.length > 1) {
    const traversed = STATUS_SEVERITY.filter(s => summary.statuses.includes(s));
    el.append(popEl('p', 'archive-statuses', 'Statuts traversés : ' + traversed.join(', ')));
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

// `elements` : { mapContainerId, dock, slider, playBtn, clockEl, summaryEl, statusEl }
export async function openFire(id, elements) {
  const detail = await fetchFireDetail(id);
  if (!detail) return { notFound: true, destroy: () => {} };

  const { summary, firms, effis } = detail;
  renderSummary(elements.summaryEl, summary);

  const hotspots = toHotspots(firms);
  const burnt = toBurnt(effis);
  const steps = buildSteps(hotspots, burnt);
  elements.statusEl.textContent = '';
  if (!steps.length) {
    elements.statusEl.textContent = 'Pas assez de données conservées pour rejouer ce feu.';
    return { notFound: false, destroy: () => {} };
  }

  const fireState = createFireState();
  fireState.setTimeline(steps);

  const map = createMap({
    maplibregl, mobile: MOBILE, container: elements.mapContainerId, hash: false,
  });

  let timelineController = null;
  let popupClick = null;
  let ready = false;
  let poll = null;

  function fitToFire() {
    if (!Array.isArray(summary.center)) return;
    map.fitBounds(fitBoundsFor(summary.center, summary.radius_km || 15),
      { padding: 24, duration: 0 });
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

    let renderedAtLatest = true;
    function show(ts) {
      const { atLatest, lastObservedTime } = fireState.getState();
      firesController.setTime(ts, lastObservedTime, appearAt(timelineController, ts));
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

  function destroy() {
    clearInterval(poll);
    timelineController?.stop();
    if (popupClick) map.off('click', popupClick);
    map.remove();
  }

  return { notFound: false, destroy };
}
