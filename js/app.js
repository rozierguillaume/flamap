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
import {
  agePos,
  createAgeRamps,
  createFiresController,
  FIRMS_SOURCES,
  MAX_AGE,
  zoomScaleFor,
} from './features/fires.js';
import { createSmokeController, SMOKE_H, SMOKE_LIVE_K, SMOKE_WINDOW } from './fx/smoke.js';
import { CARD, createWindController } from './fx/wind.js';
import { createActivityController } from './timeline/activity.js';
import { createTimelineController } from './timeline/controller.js';
import { addForecast, buildSteps } from './timeline/model.js';
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
// OpenMapTiles expose les traductions sous la forme `name_fr`. Le nom local
// reste le meilleur repli lorsqu'une traduction française n'existe pas.
const LABEL_FR = ['coalesce', ['get', 'name_fr'], ['get', 'name'], ['get', 'name_en']];
const LABEL_PAINT = {
  'text-color': '#dce1e5',
  'text-halo-color': 'rgba(10,12,15,.88)',
  'text-halo-width': 1.5,
  'text-halo-blur': .4,
};
const map = new maplibregl.Map({
  container: 'map',
  attributionControl: false,
  hash: 'map',
  center: [2.2, 46.5], zoom: 5,
  style: {
    version: 8,
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {
      // Base mondiale : mosaïque Sentinel-2 sans nuages (10 m), libre et sans clé.
      sat: {
        type: 'raster', tileSize: 256, maxzoom: 15,
        tiles: ['https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg'],
      },
      // Par-dessus, l'ortho-photo IGN : jusqu'à 20 cm, bien plus nette, mais
      // couverture France seulement — ailleurs le service répond 404 et
      // MapLibre laisse simplement voir la couche Sentinel-2 en dessous.
      ortho: {
        type: 'raster', tileSize: 256, maxzoom: 19,
        tiles: ['https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0'
              + '&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&TILEMATRIXSET=PM'
              + '&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=image/jpeg'],
      },
      // Libellés vectoriels : contrairement aux anciennes tuiles raster CARTO,
      // leur langue peut être choisie côté client.
      toponyms: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' },
    },
    layers: [
      { id: 'sat', type: 'raster', source: 'sat' },
      { id: 'ortho', type: 'raster', source: 'ortho' },
      { id: 'label-water-point', type: 'symbol', source: 'toponyms', 'source-layer': 'water_name',
        filter: ['match', ['geometry-type'], ['Point', 'MultiPoint'], true, false],
        layout: {
          'text-field': LABEL_FR, 'text-font': ['Noto Sans Italic'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 4, 10, 10, 14],
          'text-letter-spacing': .12, 'text-max-width': 7,
        },
        paint: { ...LABEL_PAINT, 'text-color': '#b9d8ef' } },
      { id: 'label-water-line', type: 'symbol', source: 'toponyms', 'source-layer': 'water_name',
        filter: ['match', ['geometry-type'], ['LineString', 'MultiLineString'], true, false],
        layout: {
          'symbol-placement': 'line', 'symbol-spacing': 350,
          'text-field': LABEL_FR, 'text-font': ['Noto Sans Italic'],
          'text-size': 13, 'text-letter-spacing': .12,
        },
        paint: { ...LABEL_PAINT, 'text-color': '#b9d8ef' } },
      { id: 'label-country', type: 'symbol', source: 'toponyms', 'source-layer': 'place',
        minzoom: 2, maxzoom: 8, filter: ['==', ['get', 'class'], 'country'],
        layout: {
          'text-field': LABEL_FR, 'text-font': ['Noto Sans Bold'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 2, 10, 6, 17],
          'text-letter-spacing': .12, 'text-transform': 'uppercase', 'text-max-width': 7,
        },
        paint: LABEL_PAINT },
      { id: 'label-state', type: 'symbol', source: 'toponyms', 'source-layer': 'place',
        minzoom: 4, maxzoom: 9, filter: ['==', ['get', 'class'], 'state'],
        layout: {
          'text-field': LABEL_FR, 'text-font': ['Noto Sans Italic'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 4, 9, 8, 14],
          'text-letter-spacing': .16, 'text-transform': 'uppercase', 'text-max-width': 9,
        },
        paint: { ...LABEL_PAINT, 'text-color': '#b9c0c6' } },
      { id: 'label-city', type: 'symbol', source: 'toponyms', 'source-layer': 'place',
        minzoom: 3, filter: ['==', ['get', 'class'], 'city'],
        layout: {
          'text-field': LABEL_FR, 'text-font': ['Noto Sans Bold'],
          'text-size': ['interpolate', ['exponential', 1.2], ['zoom'], 4, 11, 8, 16, 12, 20],
          'text-max-width': 8,
        },
        paint: LABEL_PAINT },
      { id: 'label-town', type: 'symbol', source: 'toponyms', 'source-layer': 'place',
        minzoom: 6, filter: ['==', ['get', 'class'], 'town'],
        layout: {
          'text-field': LABEL_FR, 'text-font': ['Noto Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 6, 10, 11, 14],
          'text-max-width': 8,
        },
        paint: LABEL_PAINT },
      { id: 'label-village', type: 'symbol', source: 'toponyms', 'source-layer': 'place',
        minzoom: 9, filter: ['==', ['get', 'class'], 'village'],
        layout: {
          'text-field': LABEL_FR, 'text-font': ['Noto Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 9, 10, 13, 13],
          'text-max-width': 8,
        },
        paint: LABEL_PAINT },
      { id: 'label-local', type: 'symbol', source: 'toponyms', 'source-layer': 'place',
        minzoom: 10,
        filter: ['match', ['get', 'class'],
          ['suburb', 'quarter', 'neighbourhood', 'hamlet', 'isolated_dwelling'], true, false],
        layout: {
          'text-field': LABEL_FR, 'text-font': ['Noto Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 10, 9, 15, 12],
          'text-max-width': 8,
        },
        paint: { ...LABEL_PAINT, 'text-color': '#c3c9ce' } },
      { id: 'label-road', type: 'symbol', source: 'toponyms',
        'source-layer': 'transportation_name', minzoom: 12,
        filter: ['match', ['geometry-type'], ['LineString', 'MultiLineString'], true, false],
        layout: {
          'symbol-placement': 'line', 'symbol-spacing': 300,
          'text-field': LABEL_FR, 'text-font': ['Noto Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 12, 10, 16, 13],
          'text-rotation-alignment': 'map',
        },
        paint: { ...LABEL_PAINT, 'text-color': '#c9ced2', 'text-halo-width': 1.2 } },
    ],
  },
});
if (!MOBILE) map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
map.touchZoomRotate.disableRotation();

document.getElementById('cr-btn').addEventListener('click', e => {
  const open = document.getElementById('credits').classList.toggle('open');
  e.currentTarget.setAttribute('aria-expanded', open);
  document.getElementById('incidents').classList.toggle('credits-open', open);
  if (open) {
    setUpdatesOpen(false);
    setActivityOpen(false);
    setWeatherOpen(false);
    document.getElementById('layers').classList.remove('open');
    document.getElementById('layers-btn').setAttribute('aria-expanded', 'false');
    document.getElementById('incidents').classList.remove('layers-open');
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
    trackUsage('layers-open');
    setUpdatesOpen(false);
    setActivityOpen(false);
    setWeatherOpen(false);
    document.getElementById('credits').classList.remove('open');
    document.getElementById('cr-btn').setAttribute('aria-expanded', 'false');
    document.getElementById('incidents').classList.remove('credits-open');
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
    activityPanel.classList.remove('open');
    document.getElementById('incidents').classList.remove('activity-open');
    setWeatherOpen(false);
    document.getElementById('credits').classList.remove('open');
    document.getElementById('cr-btn').setAttribute('aria-expanded', 'false');
    document.getElementById('layers').classList.remove('open');
    document.getElementById('layers-btn').setAttribute('aria-expanded', 'false');
    document.getElementById('incidents').classList.remove('credits-open', 'layers-open');
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
    setWeatherOpen(false);
    setUpdatesOpen(false);
    document.getElementById('credits').classList.remove('open');
    document.getElementById('cr-btn').setAttribute('aria-expanded', 'false');
    document.getElementById('layers').classList.remove('open');
    document.getElementById('layers-btn').setAttribute('aria-expanded', 'false');
    document.getElementById('incidents').classList.remove('credits-open', 'layers-open');
    activityController.drawLarge(selected);
    document.getElementById('activity-panel-close').focus();
  } else if (wasOpen) {
    activityEl.focus({ preventScroll: true });
  }
}
document.getElementById('activity-panel-close').addEventListener('click', () => setActivityOpen(false));

addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    setUpdatesOpen(false);
    if (activityPanel.classList.contains('open')) setActivityOpen(false);
    setWeatherOpen(false);
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
  windAt: (...args) => windController.at(...args),
  getWindProjection: out => windController.getProjection(out),
  getState,
  isPlaying: () => timelineController.isPlaying(),
});
const WIND_LANE = windController.getExportLanes();

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

/* =====================================================================
 * EXPORT IMAGE — composition 16:9 pour X (1920 x 1080)
 *
 * Une carte hors écran reprend le style, les données et l'emprise courante.
 * Le viewport MapLibre mesure réellement 1920 px : il choisit ainsi les tuiles
 * raster correspondant à la définition finale, au lieu de rendre à 960 px puis
 * d'agrandir un fond déjà échantillonné. Les nappes atmosphériques, qui vivent
 * hors de MapLibre, sont recomposées ensuite dans le même repère géographique.
 * ===================================================================== */

const EXPORT_W = 1920, EXPORT_H = 1080, EXPORT_UI_SCALE = 2;
const GIF_W = 800, GIF_H = 450, GIF_FPS = 4;
const GIF_FRAMES = { instant: 12, evolution: 18 };
const GIF_END_PAUSE_MS = 900;
const exportBtn = document.getElementById('export-btn');
const exportPanel = document.getElementById('export-panel');
const exportWind = document.getElementById('export-wind');
const exportKindButtons = [...document.querySelectorAll('[data-export-kind]')];
const exportGifOptions = document.getElementById('export-gif-options');
const exportGenerate = document.getElementById('export-generate');
const exportToast = document.getElementById('export-toast');
let exportToastTimer = null;
let exportKind = 'still';
let gifEncoderPromise = null;

function exportMessage(message) {
  exportToast.textContent = message;
  exportToast.classList.add('open');
  clearTimeout(exportToastTimer);
  exportToastTimer = setTimeout(() => exportToast.classList.remove('open'), 3200);
}

function exportDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return 'indisponible';
  return date.toLocaleString('fr-FR', {
    timeZone: 'Europe/Paris', day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).replace(' à ', ', ');
}

function exportFilename(now, extension = 'png') {
  const parts = new Intl.DateTimeFormat('fr-CA', {
    timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).reduce((out, part) => (out[part.type] = part.value, out), {});
  return `flamap-${parts.year}-${parts.month}-${parts.day}-${parts.hour}${parts.minute}.${extension}`;
}

function roundedRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
}

/* Le viewport deux fois plus large force MapLibre à demander les tuiles raster
 * nettes. Les éléments vectoriels sont doublés séparément pour garder dans le
 * PNG la même taille apparente que dans l'ancien repère logique de 960 px. */
function scaleExportStyle(style) {
  const layout = ['text-size', 'icon-size'];
  const paint = ['line-width', 'circle-radius', 'circle-stroke-width',
                 'text-halo-width', 'text-halo-blur'];
  const output = value => typeof value === 'number' ? value * EXPORT_UI_SCALE
    : ['*', value, EXPORT_UI_SCALE];
  const hasZoom = value => Array.isArray(value)
    && (value[0] === 'zoom' || value.some(hasZoom));
  const twice = value => {
    if (value == null) return value;
    if (typeof value === 'number') return value * EXPORT_UI_SCALE;
    if (!Array.isArray(value)) return value;
    // Une expression de caméra doit garder `interpolate`/`step` au sommet :
    // MapLibre interdit de placer `zoom` dans une multiplication englobante.
    if (value[0] === 'interpolate' && hasZoom(value)) {
      const scaled = value.slice();
      for (let i = 4; i < scaled.length; i += 2) scaled[i] = output(scaled[i]);
      return scaled;
    }
    if (value[0] === 'step' && hasZoom(value)) {
      const scaled = value.slice();
      scaled[2] = output(scaled[2]);
      for (let i = 4; i < scaled.length; i += 2) scaled[i] = output(scaled[i]);
      return scaled;
    }
    return hasZoom(value) ? value : output(value);
  };
  for (const layer of style.layers || []) {
    for (const property of layout)
      if (layer.layout && property in layer.layout)
        layer.layout[property] = twice(layer.layout[property]);
    for (const property of paint)
      if (layer.paint && property in layer.paint)
        layer.paint[property] = twice(layer.paint[property]);
  }
}

function drawExportSmoke(ctx, exportMap, parts = null,
  live = getState().atLatest && !timelineController.isPlaying()) {
  const sprite = smokeController.getSprite();
  if (parts === null) parts = smokeController.copyParts();
  if (!smokeController.isEnabled() || !sprite || !parts.length) return;
  for (const p of parts) {
    const point = exportMap.project([p.lon, p.lat]);
    if (point.x < -200 || point.y < -200 || point.x > EXPORT_W + 200 || point.y > EXPORT_H + 200)
      continue;
    const q = Math.min(Math.max(p.age / p.life, 0), 1);
    const fade = Math.pow(1 - q, 1.45) * Math.min(p.age / (12 * 60), 1);
    const radiusKm = (.30 + 2.35 * Math.sqrt(q)) * p.size * (live ? 1.18 : 1);
    const cos = Math.max(Math.cos(p.lat * Math.PI / 180), .2);
    const edge = exportMap.project([p.lon + radiusKm / (111.32 * cos), p.lat]);
    const radius = Math.min(Math.max(Math.abs(edge.x - point.x), 6), 210);
    ctx.globalAlpha = (live ? .48 : .20) * fade * p.alpha;
    ctx.drawImage(sprite, point.x - radius, point.y - radius, radius * 2, radius * 2);
  }
  ctx.globalAlpha = 1;
}

function drawExportWind(ctx, exportMap, enabled, phase = 0) {
  if (!enabled || !windController.hasCurrent()) return;
  const lanes = WIND_LANE.map(() => []), out = {};
  const cols = 37, rows = 21;
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    // Décalage déterministe : une trame régulière se lirait comme un quadrillage.
    const baseX = (i + .18 + ((i * 37 + j * 17) % 61) / 96) / cols * EXPORT_W;
    const baseY = (j + .18 + ((i * 19 + j * 43) % 59) / 94) / rows * EXPORT_H;
    const ll = exportMap.unproject([baseX, baseY]);
    if (!windAt(ll.lng, ll.lat, out)) continue;
    const speed = Math.hypot(out.u, out.v);
    if (!speed) continue;
    const seconds = 420;
    const cos = Math.max(Math.cos(ll.lat * Math.PI / 180), .2);
    const next = exportMap.project([
      ll.lng + out.u * seconds / (111320 * cos),
      ll.lat + out.v * seconds / 110570,
    ]);
    const dx = next.x - baseX, dy = next.y - baseY, d = Math.hypot(dx, dy) || 1;
    const length = 12 + Math.min(speed, 18) * 1.05;
    const lane = speed < WIND_LANE[0][0] ? 0 : speed < WIND_LANE[1][0] ? 1 : 2;
    const ux = dx / d, uy = dy / d;
    // Dans le GIF, les flèches glissent d'une demi-maille puis rebouclent. Le
    // motif reste stable dans l'espace mais donne au champ une direction nette.
    const travel = phase * Math.min(EXPORT_W / cols, EXPORT_H / rows) * .72;
    const x = ((baseX + ux * travel + EXPORT_W) % EXPORT_W);
    const y = ((baseY + uy * travel + EXPORT_H) % EXPORT_H);
    const sx = x - ux * length * .38, sy = y - uy * length * .38;
    const ex = x + ux * length * .62, ey = y + uy * length * .62;
    const head = Math.min(7.5, 4.5 + speed * .18), wing = head * .48;
    lanes[lane].push(sx, sy, ex, ey,
      ex - ux * head + uy * wing, ey - uy * head - ux * wing,
      ex - ux * head - uy * wing, ey - uy * head + ux * wing);
  }
  for (let lane = 0; lane < lanes.length; lane++) {
    const points = lanes[lane];
    ctx.strokeStyle = WIND_LANE[lane][1];
    ctx.lineWidth = WIND_LANE[lane][2] * 1.45;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = 0; i < points.length; i += 8) {
      ctx.moveTo(points[i], points[i + 1]);
      ctx.lineTo(points[i + 2], points[i + 3]);
      ctx.moveTo(points[i + 2], points[i + 3]);
      ctx.lineTo(points[i + 4], points[i + 5]);
      ctx.moveTo(points[i + 2], points[i + 3]);
      ctx.lineTo(points[i + 6], points[i + 7]);
    }
    ctx.stroke();
  }
}

function drawExportBrand(ctx) {
  const x = 18, y = 18, width = 180, height = 52;
  roundedRect(ctx, x, y, width, height, 11);
  ctx.fillStyle = 'rgba(13,15,18,.88)'; ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,.14)'; ctx.lineWidth = .7; ctx.stroke();

  const ox = x + 18, oy = y + 8, k = .95;
  const dots = [[19,13,7,'#ffd84d'], [9,22,5,'#ff6b1a'], [27,25,5.2,'#b1341f'],
    [8.5,6.5,1.6,'#ffd84d'], [25,3.5,1.4,'#b1341f'], [34,11.5,1.5,'#b1341f'],
    [2,29.5,1.4,'#ff6b1a'], [17,31.5,1.5,'#ffd84d'], [34,30,1.4,'#ff6b1a']];
  for (const [cx, cy, r, color] of dots) {
    ctx.beginPath(); ctx.arc(ox + cx * k, oy + cy * k, r * k, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.fill();
  }
  ctx.font = '700 25px "Instrument Sans", sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ff6b1a'; ctx.fillText('Fla', x + 63, y + height / 2);
  const fla = ctx.measureText('Fla').width;
  ctx.fillStyle = '#e8e6e3'; ctx.fillText('map', x + 63 + fla, y + height / 2);
  const flamap = fla + ctx.measureText('map').width;
  ctx.font = '600 15px "Instrument Sans", sans-serif';
  ctx.fillStyle = '#aaa49e'; ctx.fillText('.fr', x + 63 + flamap + 2, y + height / 2 + 3);
}

function drawExportFooter(ctx, generatedAt, shownTime = timelineController.getTime(), media = 'Image') {
  const gradient = ctx.createLinearGradient(0, 444, 0, EXPORT_H);
  gradient.addColorStop(0, 'rgba(8,10,12,0)');
  gradient.addColorStop(.5, 'rgba(8,10,12,.70)');
  gradient.addColorStop(1, 'rgba(8,10,12,.95)');
  ctx.fillStyle = gradient; ctx.fillRect(0, 444, EXPORT_W, EXPORT_H - 444);

  ctx.textBaseline = 'alphabetic';
  ctx.font = '500 9.5px "Instrument Sans", sans-serif';
  ctx.fillStyle = 'rgba(232,230,227,.88)';
  ctx.fillText('Foyers : NASA FIRMS — Périmètres : Copernicus EFFIS — Vent : Météo-France / Open-Meteo', 20, 509);
  ctx.fillText('Fond : IGN et Sentinel-2 / EOX — Toponymes : OpenStreetMap / OpenFreeMap', 20, 525);

  const manifestGeneratedAt = zonesController.getManifest()?.generated_at;
  const extracted = manifestGeneratedAt
    ? Date.parse(manifestGeneratedAt) : getState().lastObservedTime * 1000;
  const lines = [
    `État affiché — ${exportDate(shownTime * 1000)}`,
    `Données actualisées — ${exportDate(extracted)}`,
    `${media} généré${media === 'Image' ? 'e' : ''} — ${exportDate(generatedAt)} (Paris)`,
  ];
  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(232,230,227,.92)';
  for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], 940, 493 + i * 16);
  ctx.textAlign = 'left';
}

function drawExportGifTime(ctx, shownTime) {
  const label = fmtClock(shownTime);
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '700 28px "Instrument Sans", sans-serif';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(8,10,12,.90)';
  ctx.lineWidth = 7;
  ctx.strokeText(label, EXPORT_W / (2 * EXPORT_UI_SCALE), 478);
  ctx.fillStyle = '#fff';
  ctx.fillText(label, EXPORT_W / (2 * EXPORT_UI_SCALE), 478);
  ctx.restore();
}

function waitExportMap(exportMap) {
  return new Promise(resolve => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    exportMap.once('idle', finish);
    // Une tuile IGN hors couverture répond 404 : l'image reste exploitable avec
    // Sentinel-2 en dessous, sans garder le bouton bloqué indéfiniment.
    setTimeout(finish, 14000);
  });
}

function renderExportMap(exportMap, timeout = 1500) {
  return new Promise(resolve => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    exportMap.once('render', finish);
    exportMap.triggerRepaint();
    setTimeout(finish, timeout);
  });
}

async function createExportMap() {
  const holder = document.createElement('div');
  holder.className = 'export-map';
  document.body.appendChild(holder);
  const style = JSON.parse(JSON.stringify(map.getStyle()));
  style.transition = { duration: 0, delay: 0 };
  scaleExportStyle(style);
  let exportMap = null;
  try {
    exportMap = new maplibregl.Map({
      container: holder, style, interactive: false, attributionControl: false,
      bounds: map.getBounds().toArray(), fitBoundsOptions: { padding: 0 },
      bearing: map.getBearing(), pitch: map.getPitch(), fadeDuration: 0,
      pixelRatio: 1,
      canvasContextAttributes: { preserveDrawingBuffer: true },
    });
    exportMap.on('styleimagemissing', event => {
      if (event.id === 'fire-aircraft' && !exportMap.hasImage(event.id))
        exportMap.addImage(event.id, aircraftController.icon(), { pixelRatio: 2 });
      if (event.id === 'fire-helicopter' && !exportMap.hasImage(event.id))
        exportMap.addImage(event.id, aircraftController.helicopterIcon(), { pixelRatio: 2 });
    });
    await waitExportMap(exportMap);
    await renderExportMap(exportMap);
    await document.fonts.ready;
    return { holder, exportMap };
  } catch (error) {
    exportMap?.remove();
    holder.remove();
    throw error;
  }
}

function destroyExportMap(session) {
  session?.exportMap?.remove();
  session?.holder?.remove();
}

function drawExportFrame(canvas, exportMap, {
  includeWind = true, windPhase = 0, smokeParts = null,
  liveSmoke = getState().atLatest && !timelineController.isPlaying(),
  shownTime = timelineController.getTime(),
  generatedAt = new Date(), media = 'Image', showLargeTime = false,
} = {}) {
  const ctx = canvas.getContext('2d');
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, EXPORT_W, EXPORT_H);
  ctx.drawImage(exportMap.getCanvas(), 0, 0, EXPORT_W, EXPORT_H);
  drawExportSmoke(ctx, exportMap, smokeParts, liveSmoke);
  drawExportWind(ctx, exportMap, includeWind, windPhase);
  ctx.save();
  ctx.scale(EXPORT_UI_SCALE, EXPORT_UI_SCALE);
  drawExportBrand(ctx);
  drawExportFooter(ctx, generatedAt, shownTime, media);
  if (showLargeTime) drawExportGifTime(ctx, shownTime);
  ctx.restore();
}

async function exportImageBlob({ includeWind = true } = {}) {
  const session = await createExportMap();
  try {
    const canvas = document.createElement('canvas');
    canvas.width = EXPORT_W;
    canvas.height = EXPORT_H;
    const generatedAt = new Date();
    drawExportFrame(canvas, session.exportMap, { includeWind, generatedAt });

    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('Le navigateur n’a pas pu encoder l’image.');
    return { blob, filename: exportFilename(generatedAt) };
  } finally {
    destroyExportMap(session);
  }
}

function setExportMapTime(exportMap, ts) {
  const { lastObservedTime } = getState();
  const APPEAR = appearAt(ts);
  firesController.setTime(ts, lastObservedTime, APPEAR, exportMap, EXPORT_UI_SCALE);

  const latest = ts >= lastObservedTime;
  burntController.paint(exportMap, latest);

  // Les statuts PSFDF n'ont pas d'historique propre. Les conserver figés au
  // dessus d'une séquence passée ferait croire qu'ils appartiennent au cran.
  psfdfController.paint(exportMap, latest);
  for (const layer of exportMap.getStyle().layers || [])
    if (layer.id.startsWith('aircraft-'))
      exportMap.setLayoutProperty(layer.id, 'visibility', 'none');
}

function saveExportWind() {
  return {
    wind: windController.pauseForExport(),
    smoke: smokeController.pauseForExport(),
  };
}

function setExportWind(ts) {
  windController.setExportTime(ts);
}

function restoreExportWind(state) {
  windController.restoreExport(state.wind);
  smokeController.restoreExport(state.smoke);
}

function exportRandom(seed) {
  let value = seed >>> 0;
  return () => ((value = Math.imul(value, 1664525) + 1013904223 >>> 0) / 4294967296);
}

function exportSmokeAdvect(p, seconds) {
  const out = {};
  if (!windController.hasCurrent() || !windAt(p.lon, p.lat, out)) return false;
  p.lat += (out.v + p.tv) * seconds / 110570;
  p.lon += (out.u + p.tu) * seconds
         / (111320 * Math.max(Math.cos(p.lat * Math.PI / 180), .2));
  return true;
}

function advanceExportSmoke(parts, seconds) {
  const count = Math.min(8, Math.max(1, Math.ceil(seconds / (3 * 60))));
  const dt = seconds / count;
  for (let step = 0; step < count; step++) {
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      p.age += dt;
      if (p.age >= p.life) { parts.splice(i, 1); continue; }
      exportSmokeAdvect(p, dt);
    }
  }
  return parts;
}

function buildExportSmoke(ts, limit = 320) {
  if (!smokeController.isEnabled()) return [];
  const { lastObservedTime, layerVisibility } = getState();
  const now = Math.min(ts, lastObservedTime);
  const features = smokeController.getSources().filter(feature => {
    const p = feature.properties || {};
    return p.ts <= now && p.ts > now - SMOKE_WINDOW
        && layerVisibility.hotspots[p.source] !== false;
  });
  if (!features.length) return [];
  const random = exportRandom(Math.floor(ts / (15 * 60)) ^ 0x51f15e);
  const stride = Math.max(1, features.length / limit);
  const parts = [];
  for (let n = 0; n < Math.min(limit, features.length); n++) {
    const feature = features[Math.min(features.length - 1, Math.floor(n * stride))];
    const prop = feature.properties || {};
    const [lon, lat] = feature.geometry.coordinates;
    const spread = prop.overview ? 9
      : Math.max(.18, Math.min(1.2, Math.max(+prop.scan || 0, +prop.track || 0) * .65));
    const jitterKm = spread * (random() + random() - 1);
    const angle = random() * Math.PI * 2;
    const life = SMOKE_H * (.72 + random() * .56);
    const p = {
      lon: lon + Math.cos(angle) * jitterKm
         / (111.32 * Math.max(Math.cos(lat * Math.PI / 180), .2)),
      lat: lat + Math.sin(angle) * jitterKm / 110.57,
      age: life * (.08 + random() * .68),
      tu: (random() * 2 - 1) * .7, tv: (random() * 2 - 1) * .7,
      life, size: .72 + random() * .58, alpha: .62 + random() * .38,
    };
    const age = p.age, dt = age / 6;
    p.age = 0;
    for (let i = 0; i < 6; i++) { exportSmokeAdvect(p, dt); p.age += dt; }
    parts.push(p);
  }
  return parts;
}

function loadGifEncoder() {
  gifEncoderPromise ||= import('https://unpkg.com/gifenc@1.0.3/dist/gifenc.esm.js')
    .catch(error => { gifEncoderPromise = null; throw error; });
  return gifEncoderPromise;
}

function ditherGifPixels(data, width) {
  // Un GIF reste limité à 256 couleurs par image. Ce très léger tramage ordonné
  // répartit l'erreur entre pixels voisins : les fumées et les voiles sombres
  // gardent un dégradé visuel au lieu de se découper en aplats concentriques.
  const bayer = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  const out = new Uint8ClampedArray(data.length);
  for (let p = 0, i = 0; i < data.length; p++, i += 4) {
    const x = p % width, y = (p / width) | 0;
    const delta = (bayer[(y & 3) * 4 + (x & 3)] - 7.5) * 1.15;
    out[i] = data[i] + delta;
    out[i + 1] = data[i + 1] + delta;
    out[i + 2] = data[i + 2] + delta;
    out[i + 3] = data[i + 3];
  }
  return out;
}

async function exportGifBlob({ includeWind = true, mode = 'instant' } = {}) {
  const [{ GIFEncoder, quantize, applyPalette }, session] = await Promise.all([
    loadGifEncoder(), createExportMap(),
  ]);
  const savedWind = saveExportWind();
  const generatedAt = new Date();
  const frameCount = GIF_FRAMES[mode] || GIF_FRAMES.instant;
  const master = document.createElement('canvas');
  master.width = EXPORT_W; master.height = EXPORT_H;
  const small = document.createElement('canvas');
  small.width = GIF_W; small.height = GIF_H;
  const smallCtx = small.getContext('2d', { willReadFrequently: true });
  smallCtx.imageSmoothingEnabled = true;
  smallCtx.imageSmoothingQuality = 'high';
  const gif = GIFEncoder();
  const liveSmoke = smokeController.copyParts();
  let smokeParts = liveSmoke.length
    ? liveSmoke : buildExportSmoke(timelineController.getTime());
  try {
    for (let frame = 0; frame < frameCount; frame++) {
      const progress = frame / Math.max(frameCount - 1, 1);
      let shownTime = timelineController.getTime();
      if (mode === 'evolution') {
        shownTime = timelineController.timeAtProgress(progress);
        setExportWind(shownTime);
        setExportMapTime(session.exportMap, shownTime);
        await renderExportMap(session.exportMap, 800);
        smokeParts = buildExportSmoke(shownTime, 260);
      } else if (frame) {
        advanceExportSmoke(smokeParts, SMOKE_LIVE_K / GIF_FPS);
      }

      drawExportFrame(master, session.exportMap, {
        includeWind, windPhase: progress, smokeParts,
        liveSmoke: mode === 'instant', shownTime, generatedAt, media: 'GIF',
        showLargeTime: mode === 'evolution',
      });
      smallCtx.clearRect(0, 0, GIF_W, GIF_H);
      smallCtx.drawImage(master, 0, 0, GIF_W, GIF_H);
      const pixels = smallCtx.getImageData(0, 0, GIF_W, GIF_H);
      const dithered = ditherGifPixels(pixels.data, GIF_W);
      // Palette locale maximale : chaque image dispose de ses propres 256
      // couleurs, au lieu de partager les 96 couleurs de toute la séquence.
      const palette = quantize(dithered, 256, { format: 'rgb565' });
      const index = applyPalette(dithered, palette, 'rgb565');
      const baseDelay = Math.round(1000 / GIF_FPS);
      const endPause = mode === 'evolution' && frame === frameCount - 1
        ? GIF_END_PAUSE_MS : 0;
      gif.writeFrame(index, GIF_W, GIF_H, {
        palette, delay: baseDelay + endPause, repeat: frame ? undefined : 0,
      });
      exportMessage(`Création du GIF — ${frame + 1}/${frameCount}`);
      if (frame % 2) await new Promise(requestAnimationFrame);
    }
    gif.finish();
    const blob = new Blob([gif.bytes()], { type: 'image/gif' });
    if (!blob.size) throw new Error('Le navigateur n’a pas pu encoder le GIF.');
    return { blob, filename: exportFilename(generatedAt, 'gif') };
  } finally {
    restoreExportWind(savedWind);
    destroyExportMap(session);
  }
}

async function deliverExport(blob, filename) {
  const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
  if (MOBILE && navigator.share && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({
        files: [file], title: 'Flamap.fr — carte des incendies',
        text: 'Carte des incendies en France — flamap.fr',
      });
      return 'share';
    } catch (error) {
      if (error.name === 'AbortError') return 'cancel';
      // Une feuille de partage indisponible ne doit pas perdre l'image prête.
    }
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = filename;
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  return 'download';
}

function setExportKind(kind) {
  exportKind = kind === 'gif' ? 'gif' : 'still';
  for (const button of exportKindButtons)
    button.setAttribute('aria-selected', button.dataset.exportKind === exportKind);
  exportGifOptions.hidden = exportKind !== 'gif';
  exportGenerate.textContent = exportKind === 'gif' ? 'Générer le GIF' : 'Générer l’image';
}

for (const button of exportKindButtons) {
  button.addEventListener('click', () => setExportKind(button.dataset.exportKind));
  button.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const next = exportKind === 'still' ? 'gif' : 'still';
    setExportKind(next);
    exportKindButtons.find(item => item.dataset.exportKind === next)?.focus();
  });
}

function setExportOpen(open) {
  if (exportBtn.disabled) open = false;
  exportPanel.classList.toggle('open', open);
  exportBtn.setAttribute('aria-expanded', open);
  document.getElementById('incidents').classList.toggle('export-open', open);
  if (open) {
    exportWind.disabled = !windController.hasCurrent();
    setUpdatesOpen(false);
    setActivityOpen(false);
    setWeatherOpen(false);
    document.getElementById('credits').classList.remove('open');
    document.getElementById('cr-btn').setAttribute('aria-expanded', 'false');
    document.getElementById('layers').classList.remove('open');
    document.getElementById('layers-btn').setAttribute('aria-expanded', 'false');
    document.getElementById('incidents').classList.remove('credits-open', 'layers-open');
    requestAnimationFrame(() => exportKindButtons
      .find(button => button.dataset.exportKind === exportKind)?.focus());
  }
}

exportBtn.addEventListener('click', () => {
  if (exportBtn.disabled) return;
  setExportOpen(!exportPanel.classList.contains('open'));
});

document.addEventListener('pointerdown', event => {
  if (!exportPanel.classList.contains('open')) return;
  if (!exportPanel.contains(event.target) && !exportBtn.contains(event.target)) setExportOpen(false);
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && exportPanel.classList.contains('open')) {
    setExportOpen(false);
    exportBtn.focus({ preventScroll: true });
  }
});

exportGenerate.addEventListener('click', async () => {
  const includeWind = exportWind.checked && !exportWind.disabled;
  const kind = exportKind;
  const gifMode = document.querySelector('input[name="export-gif-mode"]:checked')?.value || 'instant';
  setExportOpen(false);
  if (exportBtn.disabled) return;
  timelineController.stop();
  exportBtn.disabled = true;
  exportBtn.classList.add('busy');
  exportBtn.setAttribute('aria-busy', 'true');
  exportMessage(kind === 'gif' ? 'Préparation du GIF animé…' : 'Préparation de l’image 16:9…');
  try {
    const { blob, filename } = kind === 'gif'
      ? await exportGifBlob({ includeWind, mode: gifMode })
      : await exportImageBlob({ includeWind });
    const action = await deliverExport(blob, filename);
    const label = kind === 'gif' ? 'GIF' : 'Image';
    if (action === 'share') exportMessage(`${label} prêt${kind === 'gif' ? '' : 'e'} à partager.`);
    else if (action === 'download') exportMessage(`${label} enregistré${kind === 'gif' ? '' : 'e'}.`);
    else exportMessage('Partage annulé.');
    if (action !== 'cancel') trackUsage(kind === 'gif' ? 'gif-export' : 'image-export',
      { action, wind: includeWind, ...(kind === 'gif' ? { mode: gifMode } : {}) });
  } catch (error) {
    console.error(error);
    exportMessage('L’export a échoué. Réessayez dans un instant.');
  } finally {
    exportBtn.disabled = false;
    exportBtn.classList.remove('busy');
    exportBtn.removeAttribute('aria-busy');
  }
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
  isPopupKind: kind => POP.kind === kind,
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
const POP = { popup: null, timer: null, kind: null };

function closePopup() {
  if (POP.popup) POP.popup.remove();   // le gestionnaire 'close' fait le ménage
}

/* Le dock (frise, légende) et le bandeau du haut sont des panneaux posés sur la
 * carte : MapLibre ne les connaît pas et laisserait la fiche filer dessous, ce
 * qui est fatal sur téléphone où la barre du bas occupe un bon tiers de l'écran.
 * On remonte donc la carte de ce qu'il faut — la fiche suit son point. */
function fitPopup(popup) {
  const element = popup.getElement();
  if (!element) return;
  const view = map.getContainer().getBoundingClientRect();
  const dock = document.getElementById('dock').getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  const floor = Math.min(view.bottom, dock.top) - 10;
  const ceiling = view.top + 10;
  let dy = 0;
  if (rect.bottom > floor) dy = rect.bottom - floor;
  // Une fiche plus haute que la bande disponible : on privilégie son en-tête.
  if (rect.top - dy < ceiling) dy = rect.top - ceiling;
  if (Math.abs(dy) > 2) map.panBy([0, dy], { duration: 240 });
}

function openPopup(lngLat, content, kind, tick) {
  closePopup();
  // Ancrage figé : sans lui, MapLibre le recalcule pendant le recadrage de
  // `fitPopup()` et la fiche saute d'un côté à l'autre de son point.
  const anchor = map.project(lngLat).y > map.getContainer().clientHeight * .45
    ? 'bottom' : 'top';
  const popup = new maplibregl.Popup({ closeButton: true, maxWidth: '290px', anchor })
    .setLngLat(lngLat)
    .setDOMContent(content)
    .addTo(map);
  fitPopup(popup);
  POP.popup = popup;
  POP.kind = kind;
  if (tick) {
    tick();
    POP.timer = setInterval(tick, 1000);
  }
  popup.on('close', () => {
    if (POP.popup !== popup) return;
    clearInterval(POP.timer);
    POP.popup = null; POP.timer = null; POP.kind = null;
  });
  return popup;
}

/* Le curseur de lecture, pas la main du lien : sur une carte, la main promet une
 * navigation alors qu'on ouvre une mesure au point visé. Le réticule dit
 * « je relève ici », et il reste distinct de la main ouverte du déplacement. */
function hoverCursor(id) {
  map.on('mouseenter', id, () => map.getCanvas().style.cursor = 'crosshair');
  map.on('mouseleave', id, () => map.getCanvas().style.cursor = '');
}

const popEl = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

function popRoot(title, subtitle) {
  const root = popEl('div', 'pop');
  root.append(popEl('b', '', title));
  if (subtitle) root.append(popEl('span', 'sub', subtitle));
  return root;
}

function popRow(root, text, cls = 'row') {
  if (text) root.append(popEl('div', cls, text));
  return root;
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
    if (!name || POP.popup !== popup) return;
    root.querySelector('b').textContent = name;
  }).catch(() => {});
  return popup;
}

// Un appareil peut être exactement superposé au point éditorial d'un feu :
// dans ce cas, le clic vise d'abord la fiche PSFDF. Ailleurs, les appareils
// gardent leur fiche propre avant les observations satellitaires et le sol.
const POP_LAYERS = [...PSFDF_HIT_LAYERS, 'aircraft-symbol', 'hotspots',
                    'hotspots-overview', 'recent-fill', 'burnt-fill', 'nrt-fill'];

function popTarget(event) {
  const { atLatest } = getState();
  const layers = POP_LAYERS.filter(id => map.getLayer(id));
  if (!layers.length) return null;
  // Un foyer fait quelques pixels de rayon : au doigt, un point exact ne
  // l'atteint presque jamais. La tolérance ne vaut que pour les symboles et les
  // disques — un polygone, on est dedans ou on ne l'est pas.
  const pad = MOBILE ? 13 : 8;
  const box = [[event.point.x - pad, event.point.y - pad],
               [event.point.x + pad, event.point.y + pad]];
  const near = map.queryRenderedFeatures(box, { layers });
  const under = map.queryRenderedFeatures(event.point, { layers });
  const now = shownTs();
  // Hors de la fenêtre d'ancienneté, un foyer est peint à opacité nulle mais
  // reste « rendu » pour MapLibre : sans ce test, on ouvrirait la fiche d'un
  // point invisible (voir le commentaire de `show()` sur l'absence de filtre).
  const visible = feature => {
    const ts = Number(feature.properties.ts);
    return !Number.isFinite(ts) || (ts <= now && now - ts <= MAX_AGE);
  };
  for (const id of layers) {
    const isPoint = id === 'aircraft-symbol' || isPsfdfLayer(id)
      || id.startsWith('hotspots');
    // Même chose pour les surfaces brûlées : au passé, `applyBurnt()` les rend
    // transparentes sans les masquer.
    if (!isPoint && !atLatest) continue;
    const found = (isPoint ? near : under)
      .filter(feature => feature.layer.id === id)
      .find(feature => id === 'aircraft-symbol' || visible(feature));
    if (found) return { id, feature: found };
  }
  return null;
}

function mapClick(event) {
  const hit = popTarget(event);
  if (!hit) {
    trackUsage('popup-ground');
    weatherPopup(event.lngLat);
    return;
  }
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
}

const dataP = loadInitialData(buildSteps);

weatherController.startData();

/*
 * On ne s'accroche pas au seul événement 'load' : il n'est émis qu'après la
 * première frame rendue, et un onglet ouvert en arrière-plan a son
 * requestAnimationFrame gelé — la carte resterait vide indéfiniment. On
 * démarre dès que le style est prêt, avec un sondage en filet de sécurité.
 */
let started = false, poll = null;
function start() {
  if (started || !map.isStyleLoaded()) return;
  started = true;
  clearInterval(poll);
  init().catch(error => {
    console.error('Initialisation de la carte impossible', error);
    document.getElementById('map').setAttribute('aria-label', 'Carte indisponible');
    document.getElementById('init-error').hidden = false;
  });
}
map.on('style.load', start);
map.on('load', start);
poll = setInterval(start, 80);

async function init() {
  const data = await dataP;
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
  exportBtn.disabled = false;
}

// onglet ouvert en arrière-plan puis affiché : on relance le rendu
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { map.resize(); map.triggerRepaint(); }
  // onglet masqué : requestAnimationFrame gèle. La lecture reprendrait d'un
  // bond de plusieurs secondes au retour — autant rendre la main proprement.
  else timelineController.stop();
  windLoop();   // rien à animer tant que l'onglet est caché
  smokeLoop();
  aircraftController.sync();
});

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
