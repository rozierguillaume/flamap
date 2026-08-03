import { ago, confidenceText, fmt, fmtClock, nf } from './util/format.js';
import { EMPTY, json } from './data/client.js';
import { loadInitialData } from './data/initial.js';
import { createZonesController } from './data/zones.js';
import { createBurntController } from './features/burnt.js';
import { createAircraftController } from './features/aircraft.js';
import {
  createPsfdfController,
  currentPsfdf,
  isPsfdfLayer,
  PSFDF_HIT_LAYERS,
} from './features/psfdf.js';
import { createWeatherController } from './features/weather.js';
import { createMapExportController } from './export/map-export.js';
import { createMap } from './map/create-map.js';
import {
  agePos,
  createAgeRamps,
  createFiresController,
  FIRMS_SOURCES,
  MAX_AGE,
  zoomScaleFor,
} from './features/fires.js';
import { createSmokeController } from './fx/smoke.js';
import { CARD, createWindController } from './fx/wind.js';
import { createActivityController } from './timeline/activity.js';
import { createTimelineController } from './timeline/controller.js';
import { addForecast, buildSteps } from './timeline/model.js';
import { createPanelManager } from './ui/panel-manager.js';
import { createPopupRouter } from './ui/popup-router.js';
import { createPopupView, popEl, popRoot, popRow } from './ui/popup-view.js';
import {
  getState,
  setCurrentTime,
  setLayerVisibility,
  setTimeline,
} from './state.js';


const MOBILE = matchMedia('(max-width: 720px)').matches;
const H = 3600;
const V = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

function trackUsage(eventName, data) {
  if (data === undefined) {
    window.umami?.track?.(eventName);
  } else {
    window.umami?.track?.(eventName, data);
  }
}

const FIRE_RAMPS = createAgeRamps({
  mobile: MOBILE,
  front: V('--front'),
  hot: V('--hot'),
  recent: V('--recent'),
  old: V('--old'),
});

/*
 * La cle de lecture est fabriquee a partir d'AGE_COLOR : la meme table peint
 * les foyers et dessine le degrade, elles ne peuvent donc pas diverger.
 *
 * L'axe est en racine carree, pas lineaire. Les premieres heures — celles ou le
 * feu court, et ou la couleur change le plus vite — tiendraient sinon dans les
 * trois premiers pour cent de la barre, et la cle serait un aplat brun. Un axe
 * deforme se doit d'etre chiffre : d'ou le repere « 24 h » au milieu, qui
 * empeche de lire la barre comme une regle graduee.
 */
function drawAgeKey() {
  const ramp = document.getElementById('ageramp');
  // sens de lecture : l'ancien a gauche, la detection fraiche a droite
  ramp.style.background = 'linear-gradient(90deg,'
    + FIRE_RAMPS.AGE_COLOR.map(([a, c]) => `${c} ${agePos(a).toFixed(1)}%`).reverse().join(',') + ')';
  requestAnimationFrame(() => positionAgeLabels(ramp));
}

/* Les libelles sont d'abord centres sur leur repere, puis repousses de droite
 * a gauche s'ils se chevauchent. Leur petit trait reste, lui, a la position
 * exacte de l'age : la lecture demeure juste meme sur une barre etroite. */
function positionAgeLabels(ramp) {
  const width = ramp.clientWidth;
  if (!width) return;
  const gap = 7;
  const labels = [...ramp.querySelectorAll('b')]
    .map(b => ({ b, x: agePos(+b.dataset.age) / 100 * width,
                 w: b.getBoundingClientRect().width }))
    .sort((a, b) => a.x - b.x);
  const starts = labels.map(({ x, w }) => Math.max(0, Math.min(width - w, x - w / 2)));
  for (let i = labels.length - 2; i >= 0; i--)
    starts[i] = Math.min(starts[i], starts[i + 1] - gap - labels[i].w);
  for (let i = 0; i < labels.length; i++) {
    const start = Math.max(0, starts[i]);
    labels[i].b.style.left = `${start}px`;
    labels[i].b.style.transform = 'none';
    labels[i].b.style.setProperty('--tick-offset', `${labels[i].x - start}px`);
  }
}
drawAgeKey();
new ResizeObserver(() => positionAgeLabels(document.getElementById('ageramp')))
  .observe(document.getElementById('ageramp'));

const ZOOM_SCALE = zoomScaleFor(MOBILE);
const FRANCE_BBOX = [-5.5, 41.0, 10.0, 51.5];

// MapLibre lit et maintient automatiquement #map=zoom/latitude/longitude.
// Le test sert plus bas à ne pas recadrer sur la France par-dessus un lien
// partagé qui porte déjà une caméra.
const HAS_MAP_HASH = /^#map=/.test(location.hash);
const map = createMap({ maplibregl, mobile: MOBILE });
const panelManager = createPanelManager();
const popupView = createPopupView({
  map, maplibregl, dock: document.getElementById('dock'),
});
const closePopup = () => popupView.close();
const openPopup = (...args) => popupView.open(...args);

document.getElementById('cr-btn').addEventListener('click', e => {
  const open = document.getElementById('credits').classList.toggle('open');
  e.currentTarget.setAttribute('aria-expanded', open);
  document.getElementById('incidents').classList.toggle('credits-open', open);
  if (open) {
    panelManager.activate('credits', () => {
    setUpdatesOpen(false);
    setActivityOpen(false);
    setWeatherOpen(false);
    document.getElementById('layers').classList.remove('open');
    document.getElementById('layers-btn').setAttribute('aria-expanded', 'false');
    document.getElementById('incidents').classList.remove('layers-open');
    });
  } else {
    panelManager.deactivate('credits');
  }
});

const legendEl = document.getElementById('legend');
const legendBtn = document.getElementById('legend-btn');
legendBtn.addEventListener('click', e => {
  const open = legendEl.classList.toggle('open');
  e.currentTarget.setAttribute('aria-expanded', open);
  e.currentTarget.setAttribute('aria-label', open ? 'Masquer la légende' : 'Afficher la légende');
  e.currentTarget.title = open ? 'Masquer la légende' : 'Afficher la légende';
});
document.getElementById('legend-collapse').addEventListener('click', e => {
  const open = !legendEl.classList.toggle('collapsed');
  e.currentTarget.setAttribute('aria-expanded', open);
  e.currentTarget.setAttribute('aria-label', open ? 'Replier la légende' : 'Déplier la légende');
  e.currentTarget.title = open ? 'Replier la légende' : 'Déplier la légende';
});

document.getElementById('layers-btn').addEventListener('click', e => {
  const open = document.getElementById('layers').classList.toggle('open');
  e.currentTarget.setAttribute('aria-expanded', open);
  document.getElementById('incidents').classList.toggle('layers-open', open);
  if (open) {
    panelManager.activate('layers', () => {
    trackUsage('layers-open');
    setUpdatesOpen(false);
    setActivityOpen(false);
    setWeatherOpen(false);
    document.getElementById('credits').classList.remove('open');
    document.getElementById('cr-btn').setAttribute('aria-expanded', 'false');
    document.getElementById('incidents').classList.remove('credits-open');
    });
  } else {
    panelManager.deactivate('layers');
  }
});

const slider  = document.getElementById('slider');
const playBtn = document.getElementById('play');
const activityEl = document.getElementById('activity');
const activityTip = document.getElementById('activity-tip');
const activityPanel = document.getElementById('activity-panel');
const activityLarge = document.getElementById('activity-large');
const activityDetail = document.getElementById('activity-detail');
const activityMetricInputs = [...document.querySelectorAll('input[name="activity-metric"]')];
const activityMetricTabs = [...document.querySelectorAll('[data-activity-metric]')];
const powerMetricInput = activityMetricInputs.find(input => input.value === 'frp');
const clockEl = document.getElementById('clock');
const updatesPanel = document.getElementById('updates-panel');
const updatesBtn = document.getElementById('updates-btn');
const weatherController = createWeatherController({
  map,
  maplibregl,
  loadJson: json,
  fetchImpl: (...args) => fetch(...args),
  cardinals: CARD,
  fmt,
  getManifest: () => zonesController.getManifest(),
  gridValueAt: (...args) => windController.gridValueAt(...args),
  getWindTime: () => windController.getTime(),
  legacyTemperatureAt: (...args) => windController.legacyTemperatureAt(...args),
  temperatureMetadata: () => windController.temperatureMetadata(),
  getTempKey: () => tempKey,
  getTempValue: () => tempVal,
  closeUpdates: () => setUpdatesOpen(false),
  isActivityOpen: () => activityPanel.classList.contains('open'),
  closeActivity: () => setActivityOpen(false),
  activatePanel: () => panelManager.activate('weather', () => {}),
  deactivatePanel: () => panelManager.deactivate('weather'),
  trackUsage,
  elements: {
    panel: document.getElementById('weather-panel'),
    button: document.getElementById('weather-btn'),
    chart: document.getElementById('weather-chart'),
    tip: document.getElementById('weather-tip'),
    place: document.getElementById('weather-place'),
    status: document.getElementById('weather-status'),
    title: document.getElementById('weather-title'),
    follow: document.getElementById('weather-follow'),
    close: document.getElementById('weather-close'),
    incidents: document.getElementById('incidents'),
    credits: document.getElementById('credits'),
    creditsButton: document.getElementById('cr-btn'),
    layers: document.getElementById('layers'),
    layersButton: document.getElementById('layers-btn'),
  },
});

const setWeatherOpen = open => weatherController.setOpen(open);
const openWeatherAt = lngLat => weatherController.openAt(lngLat);
const weatherCoordinates = point => weatherController.coordinates(point);
const communeAt = (...args) => weatherController.communeAt(...args);

function setUpdatesOpen(open) {
  updatesPanel.classList.toggle('open', open);
  updatesBtn.setAttribute('aria-expanded', open);
  document.getElementById('incidents').classList.toggle('updates-open', open);
  if (open) {
    panelManager.activate('updates', () => {
    activityPanel.classList.remove('open');
    document.getElementById('incidents').classList.remove('activity-open');
    setWeatherOpen(false);
    document.getElementById('credits').classList.remove('open');
    document.getElementById('cr-btn').setAttribute('aria-expanded', 'false');
    document.getElementById('layers').classList.remove('open');
    document.getElementById('layers-btn').setAttribute('aria-expanded', 'false');
    document.getElementById('incidents').classList.remove('credits-open', 'layers-open');
    });
  } else {
    panelManager.deactivate('updates');
  }
}
updatesBtn.addEventListener('click', () => {
  const open = !updatesPanel.classList.contains('open');
  if (open) trackUsage('updates-open');
  setUpdatesOpen(open);
});
document.getElementById('updates-close').addEventListener('click', () => setUpdatesOpen(false));

function setActivityOpen(open, selected = null) {
  const wasOpen = activityPanel.classList.contains('open');
  activityPanel.classList.toggle('open', open);
  document.getElementById('incidents').classList.toggle('activity-open', open);
  activityTip.classList.remove('open');
  if (open) {
    panelManager.activate('activity', () => {
    setWeatherOpen(false);
    setUpdatesOpen(false);
    document.getElementById('credits').classList.remove('open');
    document.getElementById('cr-btn').setAttribute('aria-expanded', 'false');
    document.getElementById('layers').classList.remove('open');
    document.getElementById('layers-btn').setAttribute('aria-expanded', 'false');
    document.getElementById('incidents').classList.remove('credits-open', 'layers-open');
    });
    activityController.drawLarge(selected);
    document.getElementById('activity-panel-close').focus();
  } else if (wasOpen) {
    panelManager.deactivate('activity');
    activityEl.focus({ preventScroll: true });
  }
}
document.getElementById('activity-panel-close').addEventListener('click', () => setActivityOpen(false));

addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    setUpdatesOpen(false);
    if (activityPanel.classList.contains('open')) setActivityOpen(false);
    setWeatherOpen(false);
    if (document.getElementById('credits').classList.contains('open'))
      document.getElementById('cr-btn').click();
    if (document.getElementById('layers').classList.contains('open'))
      document.getElementById('layers-btn').click();
    closePopup();
  }
});

/* Sur ordinateur l'heure suit le centre exact de la frise. Sur téléphone la
 * frise ouvre la feuille du bas : l'heure se pose juste au-dessus, sur la carte.
 * Les hauteurs changent avec le vent et l'ouverture des crédits, d'où la mesure
 * plutôt qu'une valeur figée en CSS. */
function placeClock() {
  const anchor = MOBILE ? document.getElementById('dock') : document.getElementById('timebar');
  const r = anchor.getBoundingClientRect();
  clockEl.style.left = `${r.left + r.width / 2}px`;
  clockEl.style.bottom = `${innerHeight - r.top + (MOBILE ? 10 : 9)}px`;
  if (MOBILE) {
    const legendBtn = document.getElementById('legend-btn');
    const clockH = clockEl.getBoundingClientRect().height;
    const stackBottom = innerHeight - r.top + 18 + clockH;
    legendBtn.style.bottom = `${stackBottom}px`;
    const exportBottom = stackBottom + 50;
    document.getElementById('export-btn').style.bottom = `${exportBottom}px`;
    /* Les panneaux flottants suivent la pile mesuree : le dock peut changer
       de hauteur avec la legende ou les credits sans renvoyer l'export en haut
       de l'ecran. */
    const exportPanel = document.getElementById('export-panel');
    exportPanel.style.bottom = `${exportBottom}px`;
    exportPanel.style.maxHeight = `${Math.max(innerHeight - exportBottom - 60, 160)}px`;
    document.getElementById('export-toast').style.bottom = `${exportBottom}px`;
    document.getElementById('weather-btn').style.bottom = `${stackBottom + 100}px`;
    document.getElementById('layers-btn').style.bottom = `${stackBottom + 150}px`;
  }
}
addEventListener('resize', placeClock);
new ResizeObserver(placeClock).observe(document.getElementById('dock'));
new ResizeObserver(placeClock).observe(document.getElementById('timebar'));

let showMeasurement = null;

/*
 * Surfaces brulees : EFFIS n'archive rien, le WFS ne renvoie que l'etat courant
 * de chaque polygone — une seule geometrie, celle d'aujourd'hui, avec une seule
 * date de publication. On ne peut donc pas rejouer leur croissance : les
 * afficher sur un cran passe montrait l'emprise finale du feu, forcement plus
 * large que les foyers de l'instant. Elles ne sont visibles qu'au cran le plus
 * recent ; ailleurs, seuls les foyers datent la progression.
 */
let renderedAtLatest = true;
const firesController = createFiresController({
  map, ramps: FIRE_RAMPS, zoomScale: ZOOM_SCALE, value: V,
});
const burntController = createBurntController({ map, getState, value: V });

const measurementApi = Object.freeze({
  mapReady: () => !map.isMoving() && map.areTilesLoaded(),
  playbackRunning: () => timelineController.isPlaying(),
  startShowTiming() {
    if (showMeasurement) throw new Error('mesure de show() déjà active');
    showMeasurement = [];
  },
  stopShowTiming() {
    const durations = showMeasurement || [];
    showMeasurement = null;
    return durations;
  },
});

export function getMeasurementApi() {
  return measurementApi;
}

// Le banc local charge l'application dans un iframe avec une CSP stricte :
// exposer son API gelée sur ce seul chemin évite d'y évaluer un import dynamique.
if (new URLSearchParams(location.search).has('lot0')) {
  globalThis.__flamapMeasurement = measurementApi;
}

const applyBurnt = () => burntController.apply();
let psfdfController, aircraftController;

function applyPsfdf() {
  psfdfController.apply();
}

/* Le filtre ne change que quand l'utilisateur coche une source. Il ne doit
 * surtout pas entrer dans `show()` : le réécrire à chaque frame ferait
 * reparser les milliers de foyers pendant l'animation. */
function applyHotspots() {
  const enabled = FIRMS_SOURCES.filter(
    source => getState().layerVisibility.hotspots[source]);
  firesController.setSources(enabled);

  smokeTime(timelineController.getTime(), true, true);
  drawActivity();
}

/* =====================================================================
 * VENT ET FUMEE — contrôleurs à état privé
 * ===================================================================== */

const windCv  = document.getElementById('wind');
const windKey = document.getElementById('windkey');
const windVal = document.getElementById('windval');
const tempKey = document.getElementById('tempkey');
const tempVal = document.getElementById('tempval');
const centerProbe = document.getElementById('center-probe');
const smokeCv = document.getElementById('smoke');

let timelineController;
let smokeController;
const windController = createWindController({
  mobile: MOBILE,
  map,
  canvas: windCv,
  key: windKey,
  value: windVal,
  getManifest: () => zonesController.getManifest(),
  onBadgeChange: () => temperatureBadge(),
  onFieldChange: () => smokeController.loop(),
});
smokeController = createSmokeController({
  mobile: MOBILE,
  canvas: smokeCv,
  // `windController` est déjà construit : passer la fonction telle quelle évite
  // le tableau de reste alloué à chaque lecture du vent, et la fumée en fait une
  // par bouffée et par sous-pas.
  windAt: windController.at,
  getWindProjection: out => windController.getProjection(out),
  getState,
  isPlaying: () => timelineController.isPlaying(),
});
const windAt = (...args) => windController.at(...args);
const windTime = (...args) => windController.setTime(...args);
const windBadge = () => windController.badge();
const windResize = () => windController.resize();
const windSync = () => windController.sync();
const windLoop = () => windController.loop();
const smokeTime = (...args) => smokeController.setTime(...args);
const smokeResize = () => smokeController.resize();
const smokeLoop = () => smokeController.loop();

function temperatureAt(lon, lat) {
  return weatherController.temperatureAt(lon, lat);
}

function temperatureBadge() {
  weatherController.temperatureBadge();
}

const activityController = createActivityController({
  mobile: MOBILE,
  map,
  firmsSources: FIRMS_SOURCES,
  getSteps: () => getState().steps,
  getContext: () => ({
    disabled: zonesController.isDisabled(),
    manifest: zonesController.getManifest(),
    overview: psfdfController.getOverview(),
    hotspots: zonesController.getHotspots(),
    shownHotspots: getState().layerVisibility.hotspots,
  }),
  fmt,
  setOpen: setActivityOpen,
  elements: {
    activityEl,
    activityTip,
    activityPanel,
    activityLarge,
    activityDetail,
    activityMetricInputs,
    activityMetricTabs,
    powerMetricInput,
  },
});
const PLAY_MS = MOBILE ? 19000 : 23000;    // durée d'une lecture complète
timelineController = createTimelineController({
  mobile: MOBILE,
  slider,
  playBtn,
  playMs: PLAY_MS,
  trackUsage,
  getSteps: () => getState().steps,
  getCurrentTime: () => getState().currentTime,
  setCurrentTime,
  show,
  smokeTime,
  smokeLoop,
});

const drawActivity = () => activityController.draw();

activityController.installChartListeners();

function formatUpdate(step) {
  if (step.kind === 'sat') return `${step.n.toLocaleString('fr-FR')} foyers détectés`;
  if (step.kind === 'effis') {
    const area = step.ha ? ` — ${step.ha.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} ha` : '';
    return step.n ? `${step.n.toLocaleString('fr-FR')} périmètres récupérés${area}` : 'Périmètres de zones brûlées actualisés';
  }
  return 'Prévision de vent actualisée';
}

function drawUpdates() {
  const steps = getState().steps;
  const recent = steps.filter(step => step.kind !== 'wind').slice(-40).reverse();
  document.getElementById('updates-list').innerHTML = recent.length ? recent.map(step => {
    const source = step.kind === 'sat' ? step.label : 'Copernicus EFFIS';
    return `<li><time datetime="${new Date(step.ts * 1000).toISOString()}">${fmt(step.ts)}</time><strong>${source}</strong><span>${formatUpdate(step)}</span></li>`;
  }).join('') : '<li id="updates-empty">Aucune mise à jour disponible.</li>';
}

const exportController = createMapExportController({
  mobile: MOBILE,
  map,
  getState,
  getTimelineController: () => timelineController,
  getZonesController: () => zonesController,
  firesController,
  burntController,
  getPsfdfController: () => psfdfController,
  getAircraftController: () => aircraftController,
  windController,
  smokeController,
  appearAt,
  panelManager,
  setUpdatesOpen,
  setActivityOpen,
  setWeatherOpen,
  trackUsage,
});

/* Naissance et mort d'un foyer à l'écran.
 *
 * Le curseur ne saute plus de cran en cran : il balaie le temps en continu (voir
 * `warpTime`). L'âge d'un point est donc lui aussi continu, et on peut le faire
 * naître au lieu de le faire apparaître.
 *
 * La durée de cette naissance est donnée en secondes *de lecture*, pas en
 * secondes de temps modèle : la frise défile à vitesse très variable — dix
 * heures de terrain par seconde dans un creux, une heure et demie dans une
 * rafale — et une constante en temps modèle donnerait tantôt un clignotement,
 * tantôt une éternité. `appearAt()` la reconvertit à chaque frame. */
const BIRTH_S = .55;   // durée à l'écran de la montée d'un foyer

/* Secondes de temps modèle avalées par une seconde de lecture au voisinage de
 * `ts`, converties en durée de naissance. Bornée des deux côtés : sous dix
 * minutes la montée n'est plus lisible, au-delà de quatre heures le foyer
 * finirait d'apparaître alors qu'il a déjà bien viré vers l'orange. */
function appearAt(ts) {
  if (!timelineController.isConfigured()) return 45 * 60;
  const q = timelineController.progressAtTime(ts), h = .004;
  const speed = (timelineController.timeAtProgress(Math.min(q + h, 1))
               - timelineController.timeAtProgress(Math.max(q - h, 0)))
              / (2 * h * timelineController.getPlayDuration() / 1000);
  return Math.min(Math.max(speed * BIRTH_S, 10 * 60), 4 * H);
}

function show(ts) {
  const { atLatest, lastObservedTime } = getState();
  const measuredAt = showMeasurement ? performance.now() : null;
  const APPEAR = appearAt(ts);
  firesController.setTime(ts, lastObservedTime, APPEAR);
  const was = renderedAtLatest;
  renderedAtLatest = atLatest;
  // fondu des surfaces brûlées : le basculement ne se fait qu'au franchissement,
  // sinon la transition MapLibre serait relancée à chaque frame et figée à zéro
  if (was !== renderedAtLatest) {
    document.body.classList.toggle('past', !atLatest);
    applyBurnt();
    applyPsfdf();
    aircraftController.sync();
  }

  const clock = fmtClock(ts);
  if (clock !== clockEl.textContent) clockEl.textContent = clock;
  windTime(ts);
  smokeTime(ts);
  if (showMeasurement) showMeasurement.push(performance.now() - measuredAt);
}

/*
 * La lecture du vent change de largeur au fil de l'animation. On réserve une
 * bonne fois la place de trois chiffres, ce qui couvre ce qui se mesure au sol
 * et empêche le panneau de légende de respirer au rythme des rafales.
 */
function lockWidths() {
  const probe = document.createElement('div');
  probe.id = 'probe';
  document.body.appendChild(probe);

  const widest = (html, model) => {
    const cs = getComputedStyle(model);
    for (const k of ['fontSize', 'fontFamily', 'fontWeight', 'letterSpacing',
                     'fontVariantNumeric']) probe.style[k] = cs[k];
    probe.innerHTML = html;
    return probe.offsetWidth;
  };

  // les chiffres sont tabulaires : trois zéros mesurent comme n'importe quel
  // nombre à trois chiffres. Sans fichier de vent la ligne a été retirée du
  // document, et mesurer un élément détaché ne donnerait rien de bon.
  const wind = windVal.isConnected ? widest('000 km/h (raf. 000 km/h)', windVal) : 0;

  probe.remove();
  const px = document.documentElement.style;
  px.setProperty('--wind-w', Math.ceil(wind) + 2 + 'px');
}

psfdfController = createPsfdfController({
  mobile: MOBILE,
  map,
  getState,
  getHotspots: () => zonesController.getHotspots(),
  activityController,
  powerMetricInput,
  trackUsage,
  stopTimeline: () => timelineController.stop(),
  setTime,
  elements: {
    incidents: document.getElementById('incidents'),
    panel: document.getElementById('psfdf-panel'),
    panelTitle: document.getElementById('psfdf-panel-title'),
    panelSub: document.getElementById('psfdf-panel-sub'),
    panelBody: document.getElementById('psfdf-panel-body'),
    headStatus: document.getElementById('psfdf-head-status'),
    relative: document.getElementById('psfdf-relative'),
    panelToggle: document.getElementById('psfdf-panel-toggle'),
  },
});

aircraftController = createAircraftController({
  map,
  getState,
  nearestActiveFeature: (...args) => psfdfController.nearestActiveFeature(...args),
  openPopup,
  closePopup,
  isPopupKind: kind => popupView.isKind(kind),
  hoverCursor,
  elements: {
    check: document.getElementById('ck-aircraft'),
    labelsCheck: document.getElementById('ck-aircraft-label'),
    status: document.getElementById('aircraft-status'),
  },
});

function fitFrance(duration = 850) {
  const bounds = new maplibregl.LngLatBounds(
    [FRANCE_BBOX[0], FRANCE_BBOX[1]], [FRANCE_BBOX[2], FRANCE_BBOX[3]]);
  const dockH = document.getElementById('dock').offsetHeight;
  map.fitBounds(bounds, {
    padding: {
      top: document.getElementById('head').offsetHeight + (MOBILE ? 22 : 28),
      bottom: (MOBILE ? dockH : 0) + 28,
      left: MOBILE ? 14 : 28, right: MOBILE ? 14 : 28,
    },
    duration,
  });
}

document.getElementById('home-btn').addEventListener('click', () => {
  trackUsage('home-france');
  timelineController.stop();
  fitFrance();
});

/* Le niveau national emploie les cellules agrégées ; dès que les paquets
 * détaillés sont disponibles, chaque pixel FIRMS récent devient un émetteur.
 * Le changement de jeu de sources ne vide jamais les particules existantes :
 * elles gardent leur position géographique pendant et après le zoom. */
function smokeUseVisibleSources() {
  smokeController.useVisibleSources({
    manifest: zonesController.getManifest(),
    zoom: map.getZoom(),
    hotspots: zonesController.getHotspots(),
    bounds: map.getBounds(),
    time: timelineController.getTime(),
  });
}

const zonesController = createZonesController({
  getViewport: () => ({ zoom: map.getZoom(), bounds: map.getBounds() }),
  hasDetailSource: () => !!map.getSource('hs'),
  setLoading: loading => document.body.classList.toggle('loading-detail', loading),
  clearDetail: reason => {
    map.getSource('hs').setData(EMPTY);
    map.getSource('dated').setData(EMPTY);
    map.getSource('nrt').setData(EMPTY);
    windController.setTiles([]);
    smokeUseVisibleSources();
    if (reason === 'empty') windTime(windController.getTime(), true);
    drawActivity();
  },
  applyDetail: ({ zones, hotspots, merge }) => {
    windController.setTiles(zones);
    smokeUseVisibleSources();
    map.getSource('hs').setData(hotspots);
    map.getSource('dated').setData(merge('burnt_dated', true));
    map.getSource('nrt').setData(merge('burnt_nrt', true));
    windTime(windController.getTime(), true);
    windController.clear();
    drawActivity();
  },
  afterDetail: () => {
    // Le chargement des pixels FIRMS précis peut élargir l'emprise estimée
    // du feu : rafraîchir la fiche une fois ces données disponibles.
    const { atLatest, layerVisibility } = getState();
    if (layerVisibility.psfdf && atLatest) psfdfController.updatePanel();
  },
});
const loadVisibleZones = () => zonesController.loadVisibleZones();

/* =====================================================================
 * FICHES AU CLIC
 *
 * Un seul aiguillage pour toute la carte, et une seule fiche ouverte à la fois.
 * Avant, chaque couche posait son propre `map.on('click', id, …)` : les
 * gestionnaires se déclenchaient tous pour un même clic — d'où le garde-fou qui
 * cherchait un appareil depuis la fiche EFFIS — et le fond de carte, lui,
 * n'était cliquable nulle part. L'ordre de priorité est explicite ici, et ce
 * qui ne touche aucune couche tombe sur la sonde météo.
 * ===================================================================== */

/* Le dock (frise, légende) et le bandeau du haut sont des panneaux posés sur la
 * carte : MapLibre ne les connaît pas et laisserait la fiche filer dessous, ce
 * qui est fatal sur téléphone où la barre du bas occupe un bon tiers de l'écran.
 * On remonte donc la carte de ce qu'il faut — la fiche suit son point. */
/* Le curseur de lecture, pas la main du lien : sur une carte, la main promet une
 * navigation alors qu'on ouvre une mesure au point visé. Le réticule dit
 * « je relève ici », et il reste distinct de la main ouverte du déplacement. */
function hoverCursor(id) {
  map.on('mouseenter', id, () => map.getCanvas().style.cursor = 'crosshair');
  map.on('mouseleave', id, () => map.getCanvas().style.cursor = '');
}

// instant réellement représenté : la prévision de vent ne vieillit pas le feu
const shownTs = () => {
  const { currentTime, lastObservedTime, steps } = getState();
  return Math.min(currentTime, steps.length ? lastObservedTime : currentTime);
};

function windPhrase(lon, lat) {
  return windController.phrase(lon, lat);
}

/* Deuxième étage de toutes les fiches : l'air à cet endroit, au cran affiché.
 * Séparé du reste par un filet — ce qui est au-dessus a été observé par un
 * satellite ou publié par EFFIS, ce qui est ici sort d'un modèle. */
function weatherBlock(root, lngLat, { divider = true, stamp = false } = {}) {
  const block = popEl('div', divider ? 'meteo sep' : 'meteo');
  const temperature = temperatureAt(lngLat.lng, lngLat.lat);
  if (Number.isFinite(temperature))
    block.append(popEl('div', 'temp', `${nf(temperature, 1)} °C`));
  const wind = windPhrase(lngLat.lng, lngLat.lat);
  block.append(popEl('div', 'wind',
    wind || 'Modèle de vent non couvert à cet endroit.'));
  if (stamp) block.append(popEl('div', 'row dim', `AROME, au ${fmt(timelineController.getTime())}`));

  const button = popEl('button', '', 'Prévisions météo');
  button.addEventListener('click', () => {
    trackUsage('popup-weather');
    closePopup();
    openWeatherAt(lngLat);
  });
  block.append(button);
  root.append(block);
  return root;
}

function hotspotPopup(feature, lngLat) {
  const p = feature.properties;
  const ts = Number(p.ts);
  const root = popRoot('Foyer détecté', `${p.source} — ${fmt(ts)}`);
  popRow(root, ago(shownTs() - ts));
  const frp = Number(p.frp);
  if (Number.isFinite(frp)) {
    const big = popEl('div', 'big', `${nf(frp, 1)} `);
    big.append(popEl('span', 'unit', 'MW rayonnés'));
    root.append(big);
  }
  popRow(root, confidenceText(p.confidence), 'row dim');
  return weatherBlock(root, lngLat);
}

function overviewPopup(feature, lngLat) {
  const p = feature.properties;
  const ts = Number(p.ts);
  const count = Number(p.n) || 0;
  const root = popRoot(`${nf(count)} foyer${count > 1 ? 's' : ''} en une heure`,
                       `${p.source} — ${fmt(ts)}`);
  const frp = Number(p.frp);
  if (Number.isFinite(frp)) {
    const big = popEl('div', 'big', `${nf(frp, 1)} `);
    big.append(popEl('span', 'unit', 'MW cumulés'));
    root.append(big);
  }
  popRow(root, 'Regroupement de la vue nationale — zoomez pour le détail.',
    'row dim');
  return weatherBlock(root, lngLat);
}

/* Occupation du sol brûlée, telle qu'EFFIS la publie : neuf pourcentages dont
 * la somme fait 100. C'est la donnée la plus parlante du lot — savoir qu'un
 * périmètre a emporté de la pinède, du maquis ou des cultures. */
const BURNT_COVER = [
  ['CONIFER',    'conifères'],
  ['BROADLEA',   'feuillus'],
  ['MIXED',      'forêt mixte'],
  ['SCLEROPH',   'maquis, garrigue'],
  ['TRANSIT',    'landes, recrû'],
  ['OTHERNATLC', 'autres milieux naturels'],
  ['AGRIAREAS',  'surfaces agricoles'],
  ['ARTIFSURF',  'surfaces bâties'],
  ['OTHERLC',    'autres'],
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

function burntPopup(feature, lngLat) {
  const p = feature.properties;
  const place = p.COMMUNE || p.PROVINCE || 'Périmètre brûlé';
  const ts = Number(p.ts);
  const root = popRoot(place, [p.COMMUNE ? p.PROVINCE : '', 'périmètre EFFIS']
    .filter(Boolean).join(' — '));
  const area = Number(p.AREA_HA);
  if (Number.isFinite(area)) {
    const big = popEl('div', 'big', `${nf(area)} `);
    big.append(popEl('span', 'unit', 'ha'));
    root.append(big);
  }
  if (ts) popRow(root, `Départ le ${fmt(ts)} — ${ago(shownTs() - ts)}`);
  const cover = coverBlock(p);
  if (cover) root.append(cover);
  const na2k = Number(p.PERCNA2K);
  if (Number.isFinite(na2k) && na2k >= 1)
    popRow(root, `${nf(na2k)} % en zone Natura 2000`, 'row dim');
  return weatherBlock(root, lngLat);
}

function nrtPopup(lngLat) {
  const root = popRoot('Emprise en cours d\'évaluation', 'EFFIS quasi temps réel');
  popRow(root, 'Publiée sans date ni surface, elle peut englober d\'anciennes'
    + ' cicatrices.', 'row dim');
  return weatherBlock(root, lngLat);
}

/* Fiche du fond de carte : la lecture du modèle à l'endroit cliqué, au cran
 * affiché. Les grilles sont déjà en mémoire pour la nappe de vent et la sonde
 * du centre — rien à télécharger, et les 24 h de contexte restent à un bouton. */
function weatherPopup(lngLat) {
  const root = popRoot('Météo à ce point', weatherCoordinates(lngLat));
  weatherBlock(root, lngLat, { divider: false, stamp: true });

  const popup = openPopup(lngLat, root, 'weather');
  // Le nom de la commune arrive après coup : la fiche est déjà lisible sans lui.
  communeAt(lngLat.lng, lngLat.lat).then(name => {
    if (!name || !popupView.isCurrent(popup)) return;
    root.querySelector('b').textContent = name;
  }).catch(() => {});
  return popup;
}

// Un appareil peut être exactement superposé au point éditorial d'un feu :
// dans ce cas, le clic vise d'abord la fiche PSFDF. Ailleurs, les appareils
// gardent leur fiche propre avant les observations satellitaires et le sol.
const POP_LAYERS = [...PSFDF_HIT_LAYERS, 'aircraft-symbol', 'hotspots',
                    'hotspots-overview', 'recent-fill', 'burnt-fill', 'nrt-fill'];

const popupRouter = createPopupRouter({
  map,
  mobile: MOBILE,
  layers: POP_LAYERS,
  isPointLayer: id => id === 'aircraft-symbol' || isPsfdfLayer(id)
    || id.startsWith('hotspots'),
  isAlwaysVisible: id => id === 'aircraft-symbol',
  getAtLatest: () => getState().atLatest,
  getShownTime: shownTs,
  maxAge: MAX_AGE,
  onGround: event => {
    trackUsage('popup-ground');
    weatherPopup(event.lngLat);
  },
  onFeature: (hit, event) => {
    trackUsage('popup-feature', { layer: hit.id });
    if (hit.id === 'aircraft-symbol')
      return aircraftController.renderPopup(hit.feature, event.lngLat);
    if (isPsfdfLayer(hit.id)) {
      closePopup();
      psfdfController.renderDetail(hit.feature);
      return;
    }
    const content = hit.id === 'hotspots' ? hotspotPopup(hit.feature, event.lngLat)
      : hit.id === 'hotspots-overview' ? overviewPopup(hit.feature, event.lngLat)
      : hit.id === 'nrt-fill' ? nrtPopup(event.lngLat)
      : burntPopup(hit.feature, event.lngLat);
    openPopup(event.lngLat, content, hit.id);
  },
});
const mapClick = event => popupRouter.click(event);

const dataP = loadInitialData(buildSteps);

weatherController.startData();

/*
 * On ne s'accroche pas au seul événement 'load' : il n'est émis qu'après la
 * première frame rendue, et un onglet ouvert en arrière-plan a son
 * requestAnimationFrame gelé — la carte resterait vide indéfiniment. On
 * démarre dès que le style est prêt, avec un sondage en filet de sécurité.
 */
let started = false, destroyed = false, poll = null;
function initializationError(error) {
  console.error('Initialisation de la carte impossible', error);
  document.getElementById('map').setAttribute('aria-label', 'Carte indisponible');
  document.getElementById('init-error').hidden = false;
}

function start() {
  if (started || destroyed || !map.isStyleLoaded()) return;
  started = true;
  clearInterval(poll);
  init().catch(error => {
    if (!destroyed) initializationError(error);
  });
}
map.on('style.load', start);
map.on('load', start);
poll = setInterval(start, 80);

async function init() {
  const data = await dataP;
  if (destroyed) return;
  const { manifest, overview, recent, psfdf: rawPsfdf,
    timeline, wind: windData, detail } = data;
  const psfdf = currentPsfdf(rawPsfdf);
  zonesController.configure(manifest);

  map.addSource('recent', { type: 'geojson', data: recent });
  map.addSource('overview-hs', { type: 'geojson', data: overview });
  map.addSource('psfdf', { type: 'geojson', data: psfdf });
  map.addSource('nrt', { type: 'geojson', data: detail ? detail.nrt : EMPTY });
  map.addSource('dated', { type: 'geojson', data: detail ? detail.dated : EMPTY });
  map.addSource('hs', { type: 'geojson', data: detail ? detail.hotspots : EMPTY });

  burntController.install(manifest);
  firesController.install(manifest);
  psfdfController.install();
  // Les appareils restent au-dessus des foyers et des surfaces : à basse
  // altitude, plusieurs peuvent se superposer exactement au front actif.
  aircraftController.install();

  if (windData && windData.nt > 1) {
    windController.configure(windData);
    centerProbe.hidden = false;
    temperatureBadge();
    windResize();
    smokeResize();
    map.on('move', () => {
      windSync();
      windController.clear();
      windBadge();
      temperatureBadge();
    });
    map.on('resize', () => { windResize(); smokeResize(); });
  } else {
    // fichier absent ou vide : pas de case à cocher sans rien derrière, et pas
    // de ligne réservée dans la légende pour une lecture qui ne viendra jamais
    document.getElementById('ck-wind').closest('label').hidden = true;
    document.getElementById('ck-smoke').closest('label').hidden = true;
    windKey.remove();
    tempKey.remove();
    centerProbe.remove();
    smokeCv.remove();
  }
  if (!manifest.legacy) {
    map.on('moveend', loadVisibleZones);
    // Une rotation ou un redimensionnement change l'emprise à zoom constant,
    // particulièrement sur téléphone : la frise doit suivre la nouvelle vue.
    map.on('resize', loadVisibleZones);
  }

  // dernier cran réellement observé : au-delà, la frise n'est plus qu'une
  // prévision de vent et le feu reste figé dans cet état
  const lastObserved = addForecast(timeline,
    windData && windData.nt > 1 ? windData : null);
  setTimeline(timeline, lastObserved);
  activityController.configureMetrics();
  smokeController.configureOverview(overview.features.length ? overview.features
    : (detail ? detail.hotspots.features : []));
  const shortcuts = psfdfController.configure(overview.features, psfdf.features);
  timelineController.configure();
  drawActivity();
  drawUpdates();
  lockWidths();
  // on ouvre sur le dernier état observé, pas sur le bout de la prévision
  setTime(getState().lastObservedTime);
  aircraftController.sync();

  if (manifest.generated_at) {
    document.getElementById('updated').textContent =
      '— données extraites le ' + fmt(Date.parse(manifest.generated_at) / 1000) + ' (heure de Paris).';
  }

  if (!HAS_MAP_HASH) {
    // Le premier cadrage privilégie la lecture du feu principal, tout en
    // restant sous le zoom 9 où ses disques PSFDF s'effacent.
    if (shortcuts.length) psfdfController.focusIncident(shortcuts[0], 850, 8.8);
    else fitFrance(0);
  }

  // Un seul aiguillage pour tous les clics : voir la section « FICHES AU CLIC ».
  // Le fond de carte est cliquable lui aussi, il répond par la météo du point.
  map.on('click', mapClick);
  map.on('zoom', psfdfController.updatePanelDuringZoom);
  map.on('moveend', psfdfController.updatePanel);
  map.on('resize', psfdfController.updatePanel);
  for (const id of ['recent-fill', 'burnt-fill', 'nrt-fill', ...PSFDF_HIT_LAYERS,
                    'hotspots', 'hotspots-overview']) hoverCursor(id);

  // le conteneur peut avoir été mesuré à zéro avant la mise en page
  map.resize();
  loadVisibleZones();
  exportController.enable();
}

// onglet ouvert en arrière-plan puis affiché : on relance le rendu
function visibilityChange() {
  if (!document.hidden) { map.resize(); map.triggerRepaint(); }
  // onglet masqué : requestAnimationFrame gèle. La lecture reprendrait d'un
  // bond de plusieurs secondes au retour — autant rendre la main proprement.
  else timelineController.stop();
  windLoop();   // rien à animer tant que l'onglet est caché
  smokeLoop();
  aircraftController.sync();
}
document.addEventListener('visibilitychange', visibilityChange);

function destroy() {
  if (destroyed) return;
  destroyed = true;
  clearInterval(poll);
  map.off('style.load', start);
  map.off('load', start);
  document.removeEventListener('visibilitychange', visibilityChange);
  timelineController.stop();
  windController.setEnabled(false);
  smokeController.setEnabled(false);
  aircraftController.setEnabled(false);
  psfdfController.destroy();
  popupView.close();
  map.remove();
}
function pageHide(event) {
  if (!event.persisted) destroy();
}
addEventListener('pagehide', pageHide);

function setTime(ts, fromSlider) {
  timelineController.setTime(ts, fromSlider);
}

timelineController.installSliderListener();

document.getElementById('layers').addEventListener('change', event => {
  const layer = event.target.dataset.analyticsLayer;
  if (layer) trackUsage('layer-toggle', { layer, enabled: event.target.checked });
});

document.getElementById('ck-dated').addEventListener('change', e => {
  setLayerVisibility('dated', e.target.checked); applyBurnt();
});
document.getElementById('ck-nrt').addEventListener('change', e => {
  setLayerVisibility('nrt', e.target.checked); applyBurnt();
});
document.getElementById('ck-psfdf').addEventListener('change', e => {
  setLayerVisibility('psfdf', e.target.checked); applyPsfdf();
});
const hotspotsCheck = document.getElementById('ck-hotspots');
const sourceChecks = [...document.querySelectorAll('.ck-source')];
function syncHotspotsCheck() {
  const shownHotspots = getState().layerVisibility.hotspots;
  const count = FIRMS_SOURCES.filter(source => shownHotspots[source]).length;
  hotspotsCheck.checked = count === FIRMS_SOURCES.length;
  hotspotsCheck.indeterminate = count > 0 && count < FIRMS_SOURCES.length;
}
hotspotsCheck.addEventListener('change', event => {
  for (const source of FIRMS_SOURCES)
    setLayerVisibility(source, event.target.checked);
  for (const check of sourceChecks) check.checked = event.target.checked;
  hotspotsCheck.indeterminate = false;
  applyHotspots();
});
for (const check of sourceChecks) check.addEventListener('change', event => {
  setLayerVisibility(event.target.value, event.target.checked);
  syncHotspotsCheck();
  applyHotspots();
});
activityController.installMetricListeners();
document.getElementById('ck-wind').addEventListener('change', e => {
  windController.setEnabled(e.target.checked);
});
document.getElementById('ck-smoke').addEventListener('change', e => {
  smokeController.setEnabled(e.target.checked);
});
document.getElementById('ck-aircraft').addEventListener('change', event => {
  aircraftController.setEnabled(event.target.checked);
});
document.getElementById('ck-aircraft-label').addEventListener('change', event => {
  aircraftController.setLabels(event.target.checked);
});

timelineController.installPlayListener();
