import { ago, confidenceText, fmt, fmtClock, nf } from './util/format.js';
import { aircraftBearing, aircraftCurve, distanceKm } from './util/geo.js';
import { gridAt, gridBilinear } from './util/grid.js';
import { EMPTY, json } from './data/client.js';
import { loadInitialData } from './data/initial.js';
import { createZonesController } from './data/zones.js';
import { createBurntController } from './features/burnt.js';
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
const weatherPanel = document.getElementById('weather-panel');
const weatherBtn = document.getElementById('weather-btn');
const weatherChart = document.getElementById('weather-chart');
const weatherTip = document.getElementById('weather-tip');
const weatherPlace = document.getElementById('weather-place');
const weatherStatus = document.getElementById('weather-status');
const weatherTitle = document.getElementById('weather-title');
const weatherFollow = document.getElementById('weather-follow');

// v4 : le fichier ne porte plus que le vent. La température vit dans
// `thermal.json`, collecté par un workflow de cadence différente.
const WEATHER_URL = 'data/weather_forecast.json?v=4';
const THERMAL_URL = 'data/thermal.json';
let weatherData = null, weatherPromise = null, weatherRows = [];
let thermalData = null;
let weatherCommune = '', weatherPlaceRequest = 0;
const weatherPlaceCache = new Map();
/* Le panneau lit soit le centre de la carte — son comportement d'origine, qui
 * suit les déplacements — soit un point épinglé au clic. Un seul point à la
 * fois : la fiche météo du clic et le panneau parlent du même endroit. */
let weatherPin = null, weatherPinMarker = null;

const weatherTarget = () => weatherPin || map.getCenter();

function weatherCoordinates(point) {
  return `${Math.abs(point.lat).toFixed(3)}° ${point.lat >= 0 ? 'N' : 'S'}`
       + `, ${Math.abs(point.lng).toFixed(3)}° ${point.lng >= 0 ? 'E' : 'O'}`;
}

/* Géocodage inverse mutualisé entre le panneau et la fiche au clic : le service
 * de l'IGN est rapide mais public, et deux lectures du même endroit sont la
 * règle dès qu'on clique puis qu'on ouvre les prévisions. */
async function communeAt(lon, lat) {
  const key = `${lon.toFixed(4)},${lat.toFixed(4)}`;
  if (weatherPlaceCache.has(key)) return weatherPlaceCache.get(key);
  const url = new URL('https://data.geopf.fr/geocodage/reverse/');
  url.searchParams.set('lon', lon.toFixed(6));
  url.searchParams.set('lat', lat.toFixed(6));
  url.searchParams.set('limit', '1');
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Géocodage HTTP ${response.status}`);
  const result = await response.json();
  const properties = result.features?.[0]?.properties || {};
  const name = properties.city || properties.municipality || '';
  if (weatherPlaceCache.size >= 40) weatherPlaceCache.delete(weatherPlaceCache.keys().next().value);
  weatherPlaceCache.set(key, name);
  return name;
}

function renderWeatherPlace(point = weatherTarget()) {
  weatherPlace.textContent = (weatherCommune ? `${weatherCommune} — ` : '')
                           + weatherCoordinates(point);
  weatherTitle.textContent = weatherPin ? 'Météo au point choisi'
                                        : 'Météo au centre de la carte';
  weatherFollow.hidden = !weatherPin;
}

async function updateWeatherPlace() {
  const point = weatherTarget();
  const request = ++weatherPlaceRequest;
  weatherCommune = '';
  renderWeatherPlace(point);
  try {
    const name = await communeAt(point.lng, point.lat);
    if (request !== weatherPlaceRequest || !weatherPanel.classList.contains('open')) return;
    weatherCommune = name;
    renderWeatherPlace(point);
  } catch (_) {
    // Le nom est un enrichissement : les coordonnées restent disponibles si
    // le service est momentanément inaccessible ou hors de France.
  }
}

function setWeatherPin(lngLat) {
  weatherPin = lngLat ? maplibregl.LngLat.convert(lngLat) : null;
  if (!weatherPin) {
    if (weatherPinMarker) { weatherPinMarker.remove(); weatherPinMarker = null; }
    return;
  }
  if (!weatherPinMarker) {
    const element = document.createElement('div');
    element.className = 'weather-pin';
    weatherPinMarker = new maplibregl.Marker({ element }).setLngLat(weatherPin).addTo(map);
  } else {
    weatherPinMarker.setLngLat(weatherPin);
  }
}

/* Le panneau ouvert sur un point épinglé : la fiche au clic y renvoie pour les
 * 24 h de contexte que la lecture instantanée ne donne pas. */
function openWeatherAt(lngLat) {
  setWeatherPin(lngLat);
  if (weatherPanel.classList.contains('open')) {
    updateWeatherPlace();
    if (weatherData) drawWeather(); else loadWeather();
  } else {
    setWeatherOpen(true);
  }
}

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

/* Température et pluie au pas de 20 km quand `thermal.json` couvre l'instant
 * demandé. Sinon la grille du vent prend le relais : plus grossière — elle
 * lisse les reliefs et sous-estime les plaines de plusieurs degrés — mais elle
 * couvre les dix jours de la frise, et elle est là dès le premier déploiement,
 * avant que le workflow météo n'ait tourné une première fois. */
function thermalAt(key, lon, lat, ts) {
  const fine = gridAt(thermalData, key, lon, lat, ts);
  if (Number.isFinite(fine)) return fine;
  return windController.gridValueAt(key, lon, lat, ts);
}

function weatherValue(data, row, lon, lat) {
  const ts = data.t0 + row * data.dt;
  const u = gridBilinear(data, data.u[row], lon, lat);
  const v = gridBilinear(data, data.v[row], lon, lat);
  const gust = gridBilinear(data, data.gust[row], lon, lat);
  const temperature = thermalAt('temperature', lon, lat, ts);
  const precipitation = thermalAt('precipitation', lon, lat, ts);
  if (![u, v, gust, temperature, precipitation].every(Number.isFinite)) return null;
  return { u, v, gust, temperature, precipitation, speed: Math.hypot(u, v) * 3.6 };
}

const svgText = (x, y, text, cls = 'axis', anchor = 'middle') =>
  `<text x="${x}" y="${y}" class="${cls}" text-anchor="${anchor}">${text}</text>`;

function drawWeather() {
  if (!weatherData) return;
  hideWeatherTip();
  const point = weatherTarget();
  const rows = [];
  for (let index = 0; index < weatherData.nt; index++) {
    const value = weatherValue(weatherData, index, point.lng, point.lat);
    if (value) rows.push({ ...value, ts: weatherData.t0 + index * weatherData.dt });
  }
  weatherRows = rows;
  renderWeatherPlace(point);
  if (rows.length < 2) {
    weatherChart.innerHTML = '';
    weatherStatus.textContent = "Prévisions indisponibles à cette localisation.";
    weatherStatus.className = 'error';
    return;
  }

  const left = 40, right = 416, tempTop = 40, tempBottom = 107;
  const windTop = 185, windBottom = 241, precipTop = 315, precipBottom = 368;
  const x = index => left + index * (right - left) / (rows.length - 1);
  const temperatures = rows.map(row => row.temperature);
  let tempMin = Math.floor(Math.min(...temperatures) - 1);
  let tempMax = Math.ceil(Math.max(...temperatures) + 1);
  if (tempMax - tempMin < 4) { tempMin -= 1; tempMax += 1; }
  const windMax = Math.max(10, Math.ceil(Math.max(...rows.map(row => row.gust)) / 10) * 10);
  const precipitationPeak = Math.max(...rows.map(row => row.precipitation));
  const precipitationMax = Math.max(1, Math.ceil(precipitationPeak * 2) / 2);
  const tempY = value => tempBottom - (value - tempMin) / (tempMax - tempMin) * (tempBottom - tempTop);
  const windY = value => windBottom - value / windMax * (windBottom - windTop);
  const precipitationY = value =>
    precipBottom - value / precipitationMax * (precipBottom - precipTop);
  const path = (values, y) => values.map((value, index) =>
    `${index ? 'L' : 'M'}${x(index).toFixed(1)},${y(value).toFixed(1)}`).join(' ');
  const smoothPath = (values, y) => {
    let result = `M${x(0).toFixed(1)},${y(values[0]).toFixed(1)}`;
    for (let index = 1; index < values.length; index++) {
      const middle = (x(index - 1) + x(index)) / 2;
      result += ` C${middle.toFixed(1)},${y(values[index - 1]).toFixed(1)}`
              + ` ${middle.toFixed(1)},${y(values[index]).toFixed(1)}`
              + ` ${x(index).toFixed(1)},${y(values[index]).toFixed(1)}`;
    }
    return result;
  };
  const tickEvery = rows.length > 18 ? 4 : rows.length > 8 ? 2 : 1;
  const timeX = ts => left + (ts - rows[0].ts) / (rows[rows.length - 1].ts - rows[0].ts)
                           * (right - left);
  let svg = '<defs><linearGradient id="temp-fill" x1="0" y1="0" x2="0" y2="1">'
          + '<stop offset="0" stop-color="#ff6b1a" stop-opacity=".27"/>'
          + '<stop offset="1" stop-color="#ff6b1a" stop-opacity="0"/></linearGradient></defs>';
  svg += `<rect x="32" y="4" width="392" height="116" rx="8"`
       + ` class="weather-band temp-band"/>`;
  svg += `<rect x="32" y="140" width="392" height="116" rx="8"`
       + ` class="weather-band wind-band"/>`;
  svg += `<rect x="32" y="276" width="392" height="108" rx="8"`
       + ` class="weather-band precip-band"/>`;
  for (const y of [tempTop, tempBottom, windTop, windBottom, precipTop, precipBottom])
    svg += `<line x1="${left}" y1="${y}" x2="${right}" y2="${y}" class="grid"/>`;
  const now = Date.now() / 1000;
  const manifest = zonesController.getManifest();
  const updated = manifest && manifest.generated_at
    ? Date.parse(manifest.generated_at) / 1000 : NaN;
  if (updated >= rows[0].ts && updated <= rows[rows.length - 1].ts) {
    const markerX = timeX(updated);
    const hour = new Date(updated * 1000).toLocaleTimeString('fr-FR',
      { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' }).replace(':', 'h');
    const anchor = markerX < (left + right) / 2 ? 'start' : 'end';
    const offset = anchor === 'start' ? 5 : -5;
    svg += `<line x1="${markerX.toFixed(1)}" y1="${tempTop}" x2="${markerX.toFixed(1)}"`
         + ` y2="${precipBottom}" class="update-line"/>`;
    svg += svgText((markerX + offset).toFixed(1), 134, `carte ${hour}`, 'update-label', anchor);
  }
  if (now >= rows[0].ts && now <= rows[rows.length - 1].ts) {
    const markerX = timeX(now);
    const anchor = markerX < (left + right) / 2 ? 'start' : 'end';
    const offset = anchor === 'start' ? 5 : -5;
    svg += `<line x1="${markerX.toFixed(1)}" y1="${tempTop}" x2="${markerX.toFixed(1)}"`
         + ` y2="${precipBottom}" class="now-line"/>`;
    svg += svgText((markerX + offset).toFixed(1), 25, 'maintenant', 'now-label', anchor);
  }
  svg += svgText(left, 25, 'Température', 'axis', 'start');
  svg += svgText(4, tempTop + 4, `${tempMax}°`, 'axis', 'start');
  svg += svgText(4, tempBottom + 4, `${tempMin}°`, 'axis', 'start');
  const temperaturePath = smoothPath(temperatures, tempY);
  svg += `<path d="${temperaturePath} L${right},${tempBottom} L${left},${tempBottom} Z"`
       + ` class="temp-area"/>`;
  svg += `<path d="${temperaturePath}" class="temp-line"/>`;
  const peak = temperatures.indexOf(Math.max(...temperatures));
  svg += `<circle cx="${x(peak).toFixed(1)}" cy="${tempY(temperatures[peak]).toFixed(1)}"`
       + ` r="4.5" class="temp-dot"/>`;
  svg += svgText(x(peak).toFixed(1), Math.max(12, tempY(temperatures[peak]) - 10).toFixed(1),
    `${Math.round(temperatures[peak])}°`, 'temp-value');
  svg += svgText(left, 161, 'Vent moyen et rafales', 'axis', 'start');
  svg += svgText(4, windTop + 4, `${windMax}`, 'axis', 'start');
  svg += svgText(4, windBottom + 4, '0', 'axis', 'start');
  svg += `<path d="${path(rows.map(row => row.gust), windY)}" class="gust-line"/>`;
  svg += `<path d="${path(rows.map(row => row.speed), windY)}" class="wind-line"/>`;
  const arrowEvery = rows.length > 18 ? 2 : 1;
  rows.forEach((row, index) => {
    const to = (Math.atan2(row.u, row.v) * 180 / Math.PI + 360) % 360;
    if (index % arrowEvery === 0 || index === rows.length - 1)
      svg += `<path d="M0,-8 L4.5,3 L0,1 L-4.5,3 Z" class="wind-arrow"`
           + ` transform="translate(${x(index).toFixed(1)} 176) rotate(${to.toFixed(0)})"/>`;
  });
  svg += svgText(left, 297, 'Précipitations horaires', 'axis', 'start');
  svg += svgText(4, precipTop + 4,
    precipitationMax.toLocaleString('fr-FR', { maximumFractionDigits: 1 }), 'axis', 'start');
  svg += svgText(4, precipBottom + 4, '0', 'axis', 'start');
  const barWidth = Math.max(2, (right - left) / (rows.length - 1) - 2);
  rows.forEach((row, index) => {
    const y = precipitationY(row.precipitation);
    const empty = row.precipitation <= 0;
    const barY = empty ? precipBottom - 2 : y;
    const barHeight = empty ? 2 : precipBottom - y;
    svg += `<rect x="${(x(index) - barWidth / 2).toFixed(1)}" y="${barY.toFixed(1)}"`
         + ` width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}"`
         + ` rx="1" class="precip-bar${empty ? ' zero' : ''}"/>`;
    if (index % tickEvery === 0 || index === rows.length - 1) {
      const hour = new Date(row.ts * 1000).toLocaleTimeString('fr-FR',
        { hour: '2-digit', timeZone: 'Europe/Paris' }).replace(' h', 'h');
      svg += svgText(x(index).toFixed(1), 405, hour);
    }
  });
  if (precipitationPeak === 0)
    svg += svgText(right - 6, precipBottom - 10, '0 mm', 'precip-zero', 'end');
  svg += svgText(right, 251, 'km/h', 'axis', 'end');
  svg += svgText(right, 421, 'mm', 'axis', 'end');
  svg += '<line class="hover-line" x1="0" y1="40" x2="0" y2="368" visibility="hidden"/>';
  weatherChart.innerHTML = svg;
  const first = rows[0], last = rows[rows.length - 1];
  weatherChart.setAttribute('aria-label',
    `Historique et prévisions météo sur 24 heures. Température de `
    + `${first.temperature.toFixed(1)} à ${last.temperature.toFixed(1)} degrés. `
    + `Vent initial ${Math.round(first.speed)} kilomètres heure, `
    + `rafales ${Math.round(first.gust)} kilomètres heure. `
    + `Précipitations horaires maximales `
    + `${Math.max(...rows.map(row => row.precipitation)).toFixed(2)} millimètres.`);
  weatherStatus.textContent = '';
  weatherStatus.className = '';
}

function showWeatherTip(event) {
  if (!weatherRows.length) return;
  const rect = weatherChart.getBoundingClientRect();
  const viewX = (event.clientX - rect.left) / rect.width * 430;
  const index = Math.min(weatherRows.length - 1, Math.max(0,
    Math.round((viewX - 40) / (416 - 40) * (weatherRows.length - 1))));
  const row = weatherRows[index];
  const x = 40 + index * (416 - 40) / (weatherRows.length - 1);
  const line = weatherChart.querySelector('.hover-line');
  line.setAttribute('x1', x.toFixed(1));
  line.setAttribute('x2', x.toFixed(1));
  line.setAttribute('visibility', 'visible');

  const to = (Math.atan2(row.u, row.v) * 180 / Math.PI + 360) % 360;
  const from = CARD[Math.round(((to + 180) % 360) / 22.5) % 16];
  const hour = new Date(row.ts * 1000).toLocaleString('fr-FR', {
    weekday: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris',
  }).replace(':', 'h');
  const kind = row.ts <= Date.now() / 1000 ? 'historique' : 'prévision';
  weatherTip.innerHTML = `<strong>${hour} — ${kind}</strong>`
    + `<span class="temperature">${row.temperature.toLocaleString('fr-FR',
      { minimumFractionDigits: 1, maximumFractionDigits: 1 })} °C</span>`
    + `<span>Vent de ${from}, ${Math.round(row.speed)} km/h</span>`
    + `<span>Rafales : ${Math.round(row.gust)} km/h</span>`
    + `<span>Précipitations : ${row.precipitation.toLocaleString('fr-FR',
      { minimumFractionDigits: 1, maximumFractionDigits: 2 })} mm</span>`;
  weatherTip.style.left = `${x / 430 * rect.width}px`;
  weatherTip.style.top = (event.clientY - rect.top) < rect.height / 2
    ? `${rect.height * .44}px` : '28px';
  weatherTip.classList.toggle('right', x > 260);
  weatherTip.classList.add('open');
}

function hideWeatherTip() {
  weatherTip.classList.remove('open', 'right');
  const line = weatherChart.querySelector('.hover-line');
  if (line) line.setAttribute('visibility', 'hidden');
}
weatherChart.addEventListener('pointermove', showWeatherTip);
weatherChart.addEventListener('pointerdown', showWeatherTip);
weatherChart.addEventListener('pointerleave', hideWeatherTip);

async function loadWeather() {
  weatherStatus.textContent = 'Chargement des prévisions…';
  weatherStatus.className = '';
  try {
    if (!weatherPromise) weatherPromise = json(WEATHER_URL);
    weatherData = await weatherPromise;
    if (weatherPanel.classList.contains('open')) drawWeather();
  } catch (error) {
    weatherPromise = null;
    weatherStatus.textContent = 'Prévisions momentanément indisponibles.';
    weatherStatus.className = 'error';
  }
}

function setWeatherOpen(open) {
  const wasOpen = weatherPanel.classList.contains('open');
  weatherPanel.classList.toggle('open', open);
  weatherBtn.setAttribute('aria-expanded', open);
  document.getElementById('incidents').classList.toggle('weather-open', open);
  if (open) {
    setUpdatesOpen(false);
    if (activityPanel.classList.contains('open')) setActivityOpen(false);
    document.getElementById('credits').classList.remove('open');
    document.getElementById('cr-btn').setAttribute('aria-expanded', 'false');
    document.getElementById('layers').classList.remove('open');
    document.getElementById('layers-btn').setAttribute('aria-expanded', 'false');
    document.getElementById('incidents').classList.remove('credits-open', 'layers-open');
    updateWeatherPlace();
    if (weatherData) drawWeather(); else loadWeather();
    document.getElementById('weather-close').focus();
  } else if (wasOpen) {
    weatherPlaceRequest++;
    setWeatherPin(null);
    weatherBtn.focus({ preventScroll: true });
  }
}
weatherBtn.addEventListener('click', () => {
  const open = !weatherPanel.classList.contains('open');
  if (open) trackUsage('weather-open');
  // Le bouton parle du centre de la carte : il reprend la main sur un point
  // éventuellement épinglé par un clic précédent.
  setWeatherPin(null);
  setWeatherOpen(open);
});
document.getElementById('weather-close').addEventListener('click', () => setWeatherOpen(false));
weatherFollow.addEventListener('click', () => {
  setWeatherPin(null);
  updateWeatherPlace();
  if (weatherData) drawWeather();
});
map.on('moveend', () => {
  // Un point épinglé ne suit pas la carte : c'est tout l'intérêt du clic.
  if (!weatherPanel.classList.contains('open') || weatherPin) return;
  updateWeatherPlace();
  if (weatherData) drawWeather();
});

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

function applyPsfdf() {
  const { atLatest, layerVisibility } = getState();
  for (const [id] of PSFDF_LAYERS)
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility',
      layerVisibility.psfdf && atLatest ? 'visible' : 'none');
  if (layerVisibility.psfdf) updatePsfdfPanel();
  else setPsfdfPanelVisible(false);
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
  const fine = thermalAt('temperature', lon, lat, windController.getTime());
  if (Number.isFinite(fine)) return fine;
  return windController.legacyTemperatureAt(lon, lat);
}

function temperatureBadge() {
  const center = map.getCenter();
  const value = temperatureAt(center.lng, center.lat);
  tempKey.hidden = !Number.isFinite(value);
  if (tempKey.hidden) return;
  tempVal.textContent = `${Math.round(value)} °C`;
  // Les champs datés suivent la frise ; l'instantané des anciens exports locaux
  // porte sa propre heure.
  const metadata = windController.temperatureMetadata();
  const stamp = thermalData || metadata.dated
    ? windController.getTime() : metadata.ts;
  tempKey.title = 'Température à 2 m au centre de la carte'
                + (stamp ? `, au ${fmt(stamp)}` : '');
}

const activityController = createActivityController({
  mobile: MOBILE,
  map,
  firmsSources: FIRMS_SOURCES,
  getSteps: () => getState().steps,
  getContext: () => ({
    disabled: zonesController.isDisabled(),
    manifest: zonesController.getManifest(),
    overview: FIRE_CONTEXT.overview,
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
const activityValue = step => activityController.value(step);
const activityMovingAverage = passes => activityController.movingAverage(passes);
const activityTickLabel = value => activityController.tickLabel(value);
const activityLabel = step => activityController.label(step);
const countLabel = value => activityController.countLabel(value);
const powerLabel = value => activityController.powerLabel(value);

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
        exportMap.addImage(event.id, aircraftIcon(), { pixelRatio: 2 });
      if (event.id === 'fire-helicopter' && !exportMap.hasImage(event.id))
        exportMap.addImage(event.id, helicopterIcon(), { pixelRatio: 2 });
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
  for (const [id] of PSFDF_LAYERS)
    if (exportMap.getLayer(id))
      exportMap.setLayoutProperty(id, 'visibility', latest ? 'visible' : 'none');
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
    aircraftSync();
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

/*
 * Moyens aériens : catalogue ICAO24 partagé par des observateurs ADS-B pendant
 * la saison 2026. Une adresse identifie un transpondeur, pas une mission :
 * l'interface parle donc de « moyens aériens » et signale seulement leur
 * proximité éventuelle avec un incendie détecté par la carte.
 *
 * La couche est active au chargement. Dès que la case est décochée, aucun appel
 * n'est envoyé à Airplanes.live ; la requête s'arrête aussi dans un onglet
 * masqué ou lorsque la frise montre le passé.
 */
const AIRCRAFT_ICAO = (
  '3b7b65,3b7b66,3f62f6,3b7b64,3b7b73,3b7b72,3b7b6d,3b7b6f,3b7b6e,'
  + '3b7b75,3b7b74,3b7b6c,3b7b76,3b7b71,3b7b70,3b7b6b,3b7b86,3b7b85,'
  + '3b7b63,3b7b3f,3b7b3e,3b7b3d,3b7b3a,3b7b39,3b7baa,3b7ba7,3b7ba6,'
  + '3b7ba5,3b7ba4,3b7ba3,3b7ba2,3b7ba1,3b7ba0,3b7b9f,3b7b9e,3b7b9d,'
  + '3b7b9c,3b7b9b,3b7b9a,3b7b98,3b7b96,3b7b95,3b7b94,3b7b93,3b7b92,'
  + '3b7b91,3b780f,3b7b8e,3b7b8d,3b7b8c,3b7b8b,3b7b52,3b7b51,3b7b50,'
  + '3b7b4b,3b7b4a,3b7b49,3b7b3c,3b7b3b,3b7b38,3b7b37,3b7ba9,3b7ba8,'
  + '3b7b8a,3b7b87,3b7b89,3b7b88,3b7b82,3b7b81,3b7b7f,3b7b84,3b7b7e,'
  + '3b7b7d,3b7b7c,3b7b7b,3b7b7a,7cad89,7cace5,7caeb4,7c4753,7c49bc,'
  + '7caddf,393013,395244,394866,39bea6,393c65,4ab50d,4ab50e,3b775c,'
  + '505d0b,505d16,39a165,39ad12,39c672,4b4315,4b42e3,009343,3e9555,'
  + '39c5c3,3b7601,4ab50f,4d0123,4d0129,396402,39d024,501f9c,348650,'
  + '3464d9,39ddf7,399d82,4c39f2'
).split(',');
const AIRCRAFT_URL = 'https://api.airplanes.live/v2/hex/' + AIRCRAFT_ICAO.join(',');
const AIRCRAFT_HISTORY_URL = 'https://api.flamap.fr/aircraft-history';
// Un relevé toutes les 4 s, affiché 6 s plus tard : le cycle suivant dispose
// ainsi de 2 s supplémentaires pour arriver avant d'épuiser le tampon.
const AIRCRAFT_POLL_MS = 4 * 1000;
const AIRCRAFT_DELAY_MS = 6 * 1000;
const AIRCRAFT_HISTORY_TIMEOUT_MS = 4 * 1000;
// Trente minutes à un relevé toutes les 4 s donnent 450 points ; la marge
// absorbe les réponses irrégulières sans rogner le début de la trace.
const AIRCRAFT_HISTORY_MAX_POINTS = 500;
const AIRCRAFT_TRAIL_MS = 30 * 60 * 1000;
const AIRCRAFT_TRACK_KEEP_MS = AIRCRAFT_TRAIL_MS;
const AIRCRAFT_TRAIL_GAP_MS = 90 * 1000;
const AIRCRAFT_POINT_STALE_MS = 90 * 1000;
const AIRCRAFT_FRAME_MS = 1000 / 20;
const AIRCRAFT_FIRE_KM = 60;
const HELICOPTER_TYPES = new Set([
  'A109', 'A119', 'A139', 'A149', 'A169', 'A189', 'AS32', 'AS50', 'AS55',
  'AS65', 'B06', 'B105', 'B407', 'B412', 'BK17', 'EC20', 'EC25', 'EC30',
  'EC35', 'EC45', 'H125', 'H135', 'H145', 'H160', 'H175', 'H225', 'NH90',
  'R22', 'R44', 'R66', 'S76', 'S92', 'SA32', 'SA34', 'SA36', 'UH1', 'UH60',
]);
const aircraftCheck = document.getElementById('ck-aircraft');
const aircraftLabelsCheck = document.getElementById('ck-aircraft-label');
const aircraftStatus = document.getElementById('aircraft-status');
const A = {
  on: aircraftCheck.checked, timer: null, controller: null, loading: false,
  labels: false,
  tracks: new Map(), features: [], clockOffset: 0,
  historyLoaded: false, historyLoading: false,
  raf: null, lastFrame: 0,
};

function aircraftStatusText(text) {
  aircraftStatus.textContent = text;
  aircraftStatus.hidden = !A.on;
}

function aircraftSource(data = EMPTY) {
  const source = map.getSource('aircraft');
  if (source) source.setData(data);
}

function aircraftTrailsSource(data = EMPTY) {
  const source = map.getSource('aircraft-trails');
  if (source) source.setData(data);
}

function applyAircraftLabels() {
  if (map.getLayer('aircraft-symbol')) {
    map.setLayoutProperty('aircraft-symbol', 'text-field',
      A.labels ? ['get', 'label'] : '');
  }
}

// Les appareils disparaissent dès qu'on quitte le dernier cran, ou qu'on décoche
// la couche : leur fiche ne doit pas rester ouverte sur un symbole absent. Les
// autres fiches, elles, restent valables.
function closeAircraftPopup() {
  if (POP.kind === 'aircraft-symbol') closePopup();
}

function nearestAircraftFire(center) {
  let best = null, distance = Infinity;
  for (const fire of FIRE_CONTEXT.features) {
    if (fire.properties.status === 'Éteint') continue;
    const d = distanceKm(center, fire.properties.center);
    if (d < distance) { best = fire; distance = d; }
  }
  if (!best || distance > AIRCRAFT_FIRE_KM) return null;
  return {
    distance: Math.round(distance),
    name: best.properties.name || 'un incendie récent',
  };
}

function aircraftKind(aircraft) {
  const category = String(aircraft.category || '').toUpperCase();
  const type = String(aircraft.t || '').trim().toUpperCase();
  const description = String(aircraft.desc || '').toUpperCase();
  return category === 'A7' || HELICOPTER_TYPES.has(type)
    || /HELICOPTER|ROTORCRAFT|EUROCOPTER|ECUREUIL|SIKORSKY|ROBINSON/.test(description)
    ? 'helicopter' : 'airplane';
}

function aircraftFeature(aircraft, receivedAt) {
  if (!Number.isFinite(aircraft.lon) || !Number.isFinite(aircraft.lat)) return null;
  if (Number.isFinite(aircraft.seen_pos) && aircraft.seen_pos > 90) return null;
  const fire = nearestAircraftFire([aircraft.lon, aircraft.lat]);
  const callsign = String(aircraft.flight || '').trim();
  const registration = String(aircraft.r || '').trim();
  const seen = Number.isFinite(aircraft.seen_pos) ? Math.round(aircraft.seen_pos) : 0;
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [aircraft.lon, aircraft.lat] },
    properties: {
      hex: String(aircraft.hex || '').replace(/^~/, '').toLowerCase(),
      callsign, registration,
      label: callsign || registration || String(aircraft.hex || '').toUpperCase(),
      aircraft_type: String(aircraft.t || '').trim(),
      description: String(aircraft.desc || '').trim(),
      aircraft_kind: aircraftKind(aircraft),
      altitude: Number.isFinite(aircraft.alt_baro) ? aircraft.alt_baro : null,
      speed: Number.isFinite(aircraft.gs) ? aircraft.gs : null,
      track: Number.isFinite(aircraft.track) ? aircraft.track : 0,
      seen,
      position_ts: receivedAt - seen * 1000,
      near_fire: !!fire,
      fire_name: fire ? fire.name : '',
      fire_distance: fire ? fire.distance : null,
    },
  };
}

/*
 * L'API gratuite ne fournit pas d'historique : chaque navigateur construit le
 * sien à partir des positions reçues après activation. Une interruption de
 * plus de 90 s ouvre une nouvelle trace au lieu de relier artificiellement
 * deux points éloignés.
 */
function updateAircraftTracks(points, now) {
  const active = new Set();
  for (const feature of points) {
    const p = feature.properties;
    const hex = p.hex;
    active.add(hex);
    let track = A.tracks.get(hex) || [];
    const point = { coordinates: feature.geometry.coordinates, ts: p.position_ts };
    const last = track[track.length - 1];
    if (!last || point.ts > last.ts) {
      if (last && point.ts - last.ts > AIRCRAFT_TRAIL_GAP_MS) track = [];
      const previous = track[track.length - 1];
      if (previous && distanceKm(previous.coordinates, point.coordinates) < .02) {
        track[track.length - 1] = point;
      } else {
        track.push(point);
      }
    }
    track = track.filter(item =>
      item.ts >= now - AIRCRAFT_TRACK_KEEP_MS);
    A.tracks.set(hex, track);
  }

  for (const [hex, track] of A.tracks)
    if (!active.has(hex)
        && (!track.length || track[track.length - 1].ts < now - AIRCRAFT_TRACK_KEEP_MS))
      A.tracks.delete(hex);
}

/*
 * Le VPS mutualise la collecte des trente dernières minutes. Cet amorçage
 * reste facultatif : s'il est indisponible, la collecte directe ci-dessous
 * construit exactement la même trace dans le navigateur.
 */
async function loadAircraftHistory() {
  if (A.historyLoaded || A.historyLoading) return;
  A.historyLoading = true;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(), AIRCRAFT_HISTORY_TIMEOUT_MS);
  try {
    const response = await fetch(AIRCRAFT_HISTORY_URL, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok)
      throw new Error(`historique aérien HTTP ${response.status}`);
    const data = await response.json();
    if (!A.on || !getState().atLatest || document.hidden) return;
    if (!data || !Array.isArray(data.aircraft))
      throw new Error('historique aérien invalide');

    const allowed = new Set(AIRCRAFT_ICAO);
    const localNow = Date.now();
    const serverNow = Number(data.now);
    const now = Number.isFinite(serverNow)
      && Math.abs(serverNow - localNow) < 2 * 60 * 1000
      ? serverNow : localNow;
    const oldest = now - AIRCRAFT_TRACK_KEEP_MS;
    for (const aircraft of data.aircraft.slice(0, AIRCRAFT_ICAO.length)) {
      const hex = String(aircraft.hex || '').replace(/^~/, '').toLowerCase();
      if (!allowed.has(hex) || !Array.isArray(aircraft.points)) continue;
      const received = aircraft.points
        .slice(-AIRCRAFT_HISTORY_MAX_POINTS)
        .map(point => ({
          coordinates: [Number(point.lon), Number(point.lat)],
          ts: Number(point.ts),
        }))
        .filter(point =>
          Number.isFinite(point.coordinates[0])
          && Number.isFinite(point.coordinates[1])
          && point.coordinates[0] >= -180 && point.coordinates[0] <= 180
          && point.coordinates[1] >= -90 && point.coordinates[1] <= 90
          && Number.isFinite(point.ts)
          && point.ts >= oldest && point.ts <= now + 10 * 1000)
        .sort((a, b) => a.ts - b.ts);

      // Seule la portion continue la plus récente est utile : une interruption
      // ADS-B ne doit jamais être comblée par une diagonale.
      let start = 0;
      for (let index = 1; index < received.length; index++)
        if (received[index].ts - received[index - 1].ts > AIRCRAFT_TRAIL_GAP_MS)
          start = index;
      const existing = A.tracks.get(hex) || [];
      const merged = [...received.slice(start), ...existing]
        .sort((a, b) => a.ts - b.ts);
      const unique = [];
      for (const point of merged) {
        const previous = unique[unique.length - 1];
        if (previous && point.ts === previous.ts) unique[unique.length - 1] = point;
        else unique.push(point);
      }
      if (unique.length) A.tracks.set(hex, unique);
    }
    A.historyLoaded = true;
    aircraftLoop();
  } catch (error) {
    // L'historique améliore seulement le premier affichage. Les positions
    // directes et la trace construite localement restent la source de repli.
  } finally {
    clearTimeout(timeout);
    A.historyLoading = false;
  }
}

function aircraftPose(track, ts, fallbackHeading = 0) {
  if (!track.length) return null;
  if (track.length === 1 || ts <= track[0].ts)
    return { coordinates: track[0].coordinates, heading: fallbackHeading };
  const last = track[track.length - 1];
  if (ts >= last.ts)
    return { coordinates: last.coordinates, heading: fallbackHeading };

  let index = 1;
  while (index < track.length && track[index].ts < ts) index++;
  const a = track[index - 1], b = track[index];
  const span = Math.max(b.ts - a.ts, 1);
  const t = Math.min(Math.max((ts - a.ts) / span, 0), 1);
  const p0 = track[Math.max(index - 2, 0)].coordinates;
  const p1 = a.coordinates;
  const p2 = b.coordinates;
  const p3 = track[Math.min(index + 1, track.length - 1)].coordinates;
  const coordinates = aircraftCurve(p0, p1, p2, p3, t);
  const delta = .025;
  const before = aircraftCurve(p0, p1, p2, p3, Math.max(t - delta, 0));
  const after = aircraftCurve(p0, p1, p2, p3, Math.min(t + delta, 1));
  return {
    coordinates,
    heading: distanceKm(before, after) > .001
      ? aircraftBearing(before, after) : fallbackHeading,
  };
}

function aircraftTrailCoordinates(track, endTs) {
  if (track.length < 2) return [];
  const startTs = endTs - AIRCRAFT_TRAIL_MS;
  const anchors = [];
  const start = aircraftPose(track, startTs);
  if (start) anchors.push({ coordinates: start.coordinates, ts: startTs });
  for (const point of track)
    if (point.ts > startTs && point.ts < endTs) anchors.push(point);
  const end = aircraftPose(track, endTs);
  if (end) anchors.push({ coordinates: end.coordinates, ts: endTs });
  if (anchors.length < 2) return [];

  const coordinates = [anchors[0].coordinates];
  for (let index = 1; index < anchors.length; index++) {
    const p0 = anchors[Math.max(index - 2, 0)].coordinates;
    const p1 = anchors[index - 1].coordinates;
    const p2 = anchors[index].coordinates;
    const p3 = anchors[Math.min(index + 1, anchors.length - 1)].coordinates;
    // Six sous-segments suffisent à arrondir un virage sans faire passer la
    // courbe loin des positions réellement reçues.
    for (let step = 1; step <= 6; step++)
      coordinates.push(aircraftCurve(p0, p1, p2, p3, step / 6));
  }
  return coordinates;
}

function aircraftFrame(timestamp) {
  A.raf = null;
  const run = A.on && getState().atLatest && !document.hidden;
  if (!run) return;
  if (timestamp - A.lastFrame < AIRCRAFT_FRAME_MS) {
    A.raf = requestAnimationFrame(aircraftFrame);
    return;
  }
  A.lastFrame = timestamp;

  const localNow = Date.now();
  const serverNow = localNow + A.clockOffset;
  const displayTs = serverNow - AIRCRAFT_DELAY_MS;
  const points = [], trails = [];
  for (const feature of A.features) {
    const p = feature.properties;
    const track = A.tracks.get(p.hex) || [];
    const pose = aircraftPose(track, displayTs, p.track);
    if (!pose) continue;
    if (serverNow - p.position_ts <= AIRCRAFT_POINT_STALE_MS) {
      points.push({
        ...feature,
        geometry: { type: 'Point', coordinates: pose.coordinates },
        properties: { ...p, track: pose.heading },
      });
    }
  }
  // Les positions courantes viennent toujours de la collecte directe, mais les
  // traces peuvent déjà exister grâce au VPS. Les parcourir depuis A.tracks les
  // rend visibles dès l'amorçage, même avant la première réponse Airplanes.live.
  for (const [hex, track] of A.tracks) {
    const coordinates = aircraftTrailCoordinates(track, displayTs);
    if (coordinates.length >= 2) {
      trails.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates },
        properties: { hex },
      });
    }
  }
  aircraftSource({ type: 'FeatureCollection', features: points });
  aircraftTrailsSource({ type: 'FeatureCollection', features: trails });
  A.raf = requestAnimationFrame(aircraftFrame);
}

function aircraftLoop() {
  const run = A.on && getState().atLatest && !document.hidden;
  if (run && !A.raf) {
    A.lastFrame = 0;
    A.raf = requestAnimationFrame(aircraftFrame);
  } else if (!run && A.raf) {
    cancelAnimationFrame(A.raf);
    A.raf = null;
  }
}

async function refreshAircraft() {
  if (!A.on || !getState().atLatest || document.hidden || A.loading) return;
  const requestStartedAt = Date.now();
  A.loading = true;
  A.controller = new AbortController();
  aircraftStatusText('Recherche des appareils en vol…');
  try {
    const response = await fetch(AIRCRAFT_URL, {
      cache: 'no-store',
      signal: A.controller.signal,
    });
    if (!response.ok) throw new Error(`Airplanes.live HTTP ${response.status}`);
    const data = await response.json();
    if (!A.on || !getState().atLatest || document.hidden) return;
    const serverNow = Number(data.now);
    const receivedAt = Number.isFinite(serverNow)
      ? (serverNow > 1e12 ? serverNow : serverNow * 1000)
      : Date.now();
    const fresh = (data.ac || [])
      .map(aircraft => aircraftFeature(aircraft, receivedAt))
      .filter(Boolean);
    A.clockOffset = receivedAt - Date.now();
    updateAircraftTracks(fresh, receivedAt);

    // Un appareil peut être entendu sans position pendant quelques réponses,
    // notamment lorsqu'il vole bas. On conserve alors son dernier point fiable
    // et sa trace, sans jamais confondre rr_lat/rr_lon (position du récepteur)
    // avec celle de l'aéronef.
    const latest = new Map(fresh.map(feature => [feature.properties.hex, feature]));
    for (const previous of A.features) {
      const p = previous.properties;
      if (!latest.has(p.hex)
          && p.position_ts >= receivedAt - AIRCRAFT_TRACK_KEEP_MS)
        latest.set(p.hex, previous);
    }
    A.features = [...latest.values()];
    aircraftLoop();
    const near = fresh.filter(feature => feature.properties.near_fire).length;
    aircraftStatusText(fresh.length
      ? `${fresh.length} en vol${near ? `, dont ${near} près d'un incendie` : ''}`
      : 'Aucun appareil suivi actuellement en vol.');
  } catch (error) {
    if (error.name !== 'AbortError' && A.on)
      aircraftStatusText('Positions momentanément indisponibles.');
  } finally {
    A.loading = false;
    A.controller = null;
    clearTimeout(A.timer);
    if (A.on && getState().atLatest && !document.hidden) {
      // Les 4 s sont mesurées entre les départs de requête. Le différé de 6 s
      // laisse donc encore 2 s de marge si une réponse tarde à arriver.
      const wait = Math.max(1000, AIRCRAFT_POLL_MS - (Date.now() - requestStartedAt));
      A.timer = setTimeout(refreshAircraft, wait);
    }
  }
}

function aircraftSync() {
  clearTimeout(A.timer);
  A.timer = null;
  if (A.controller) A.controller.abort();
  if (!A.on) {
    closeAircraftPopup();
    aircraftSource();
    aircraftTrailsSource();
    aircraftStatusText('');
    aircraftLoop();
    return;
  }
  if (!getState().atLatest) {
    closeAircraftPopup();
    aircraftSource();
    aircraftTrailsSource();
    aircraftStatusText('Masqués pendant la lecture du passé.');
    aircraftLoop();
    return;
  }
  aircraftLoop();
  if (document.hidden) return;
  loadAircraftHistory();
  refreshAircraft();
}

function aircraftIcon() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 48;
  const ctx = canvas.getContext('2d');
  ctx.translate(24, 24);
  ctx.beginPath();
  ctx.moveTo(0, -20);
  ctx.bezierCurveTo(3, -16, 3, -10, 3, -5);
  ctx.lineTo(18, 4);
  ctx.lineTo(18, 8);
  ctx.lineTo(3, 5);
  ctx.lineTo(3, 14);
  ctx.lineTo(9, 18);
  ctx.lineTo(9, 20);
  ctx.lineTo(0, 18);
  ctx.lineTo(-9, 20);
  ctx.lineTo(-9, 18);
  ctx.lineTo(-3, 14);
  ctx.lineTo(-3, 5);
  ctx.lineTo(-18, 8);
  ctx.lineTo(-18, 4);
  ctx.lineTo(-3, -5);
  ctx.bezierCurveTo(-3, -10, -3, -16, 0, -20);
  ctx.closePath();
  ctx.fillStyle = '#f4f1eb';
  ctx.strokeStyle = '#111419';
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.fill();
  ctx.stroke();
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

function helicopterIcon() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 48;
  const ctx = canvas.getContext('2d');
  ctx.translate(24, 24);
  ctx.fillStyle = '#f4f1eb';
  ctx.strokeStyle = '#111419';
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Vue de dessus, orientée vers le haut comme l'avion : rotor principal,
  // cabine, poutre de queue et rotor arrière restent lisibles à petite taille.
  ctx.beginPath();
  ctx.moveTo(-20, -5);
  ctx.lineTo(20, 5);
  ctx.moveTo(-20, 5);
  ctx.lineTo(20, -5);
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(0, -4, 6, 11, 0, 0, Math.PI * 2);
  ctx.moveTo(-2.5, 5);
  ctx.lineTo(-1.5, 18);
  ctx.lineTo(1.5, 18);
  ctx.lineTo(2.5, 5);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(-6, 18);
  ctx.lineTo(6, 18);
  ctx.moveTo(0, 13);
  ctx.lineTo(0, 22);
  ctx.stroke();
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

function aircraftPopup(feature, lngLat) {
  const p = feature.properties;
  const root = document.createElement('div');
  root.className = 'pop';
  const title = document.createElement('b');
  title.textContent = p.label;
  root.append(title);
  const rows = [
    [p.description || p.aircraft_type, p.registration],
    [p.altitude !== null ? `${Number(p.altitude).toLocaleString('fr-FR')} ft` : '',
     p.speed !== null ? `${Math.round(Number(p.speed) * 1.852)} km/h` : ''],
    [p.near_fire ? `à ${p.fire_distance} km de ${p.fire_name}` : '', ''],
  ];
  for (const values of rows) {
    const text = values.filter(Boolean).join(' — ');
    if (!text) continue;
    root.append(document.createElement('br'), document.createTextNode(text));
  }
  const age = document.createElement('span');
  age.style.opacity = '.65';
  root.append(document.createElement('br'), age);
  const updateAge = () => {
    const current = A.features.find(feature => feature.properties.hex === p.hex);
    const positionTs = Number(current?.properties.position_ts ?? p.position_ts);
    const seconds = Number.isFinite(positionTs)
      ? Math.max(0, Math.round((Date.now() + A.clockOffset - positionTs) / 1000))
      : null;
    age.textContent = (seconds === null ? 'âge du signal inconnu'
      : `signal ADS-B reçu il y a ${seconds} s`)
      + ` — affichage différé de ${AIRCRAFT_DELAY_MS / 1000} s`
      + ` — ICAO ${p.hex.toUpperCase()}`;
  };
  // Le compteur de l'âge du signal est rafraîchi par le gestionnaire de fiches.
  return openPopup(lngLat, root, 'aircraft-symbol', updateAge);
}

function addAircraftLayers() {
  map.addSource('aircraft', { type: 'geojson', data: EMPTY });
  map.addSource('aircraft-trails', { type: 'geojson', data: EMPTY, lineMetrics: true });
  if (!map.hasImage('fire-aircraft'))
    map.addImage('fire-aircraft', aircraftIcon(), { pixelRatio: 2 });
  if (!map.hasImage('fire-helicopter'))
    map.addImage('fire-helicopter', helicopterIcon(), { pixelRatio: 2 });
  map.addLayer({
    id: 'aircraft-trail-case', type: 'line', source: 'aircraft-trails',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#111419',
      'line-width': ['interpolate', ['linear'], ['zoom'], 5, 2, 10, 3.6, 14, 4.4],
      'line-opacity': .64,
    },
  });
  map.addLayer({
    id: 'aircraft-trail', type: 'line', source: 'aircraft-trails',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-width': ['interpolate', ['linear'], ['zoom'], 5, 1, 10, 2.1, 14, 2.6],
      'line-gradient': ['interpolate', ['linear'], ['line-progress'],
        0, 'rgba(244,197,139,.16)',
        .12, 'rgba(244,197,139,.32)',
        .72, 'rgba(250,211,160,.72)',
        1, 'rgba(255,235,205,.98)'],
    },
  });
  map.addLayer({
    id: 'aircraft-symbol', type: 'symbol', source: 'aircraft',
    layout: {
      'icon-image': ['case',
        ['==', ['get', 'aircraft_kind'], 'helicopter'],
        'fire-helicopter', 'fire-aircraft'],
      // Les appareils restent visibles à petite échelle, sans devenir des
      // repères démesurés quand la carte est dézoomée.
      'icon-size': ['interpolate', ['linear'], ['zoom'],
        2, .42,
        5, .55,
        8, .7,
        11, .84,
        14, .95],
      'icon-rotate': ['get', 'track'],
      'icon-rotation-alignment': 'map',
      'icon-allow-overlap': true,
      'text-field': '',
      'text-font': ['Noto Sans Bold'],
      'text-size': 10.5,
      'text-offset': [0, 2],
      'text-anchor': 'top',
      'text-optional': true,
    },
    paint: {
      'text-color': '#f4f1eb',
      'text-halo-color': 'rgba(10,12,15,.92)',
      'text-halo-width': 1.4,
    },
  });
  applyAircraftLabels();
  hoverCursor('aircraft-symbol');
}

/* Les incendies éditorialisés par PSFDF remplacent la détection heuristique des
 * « gros feux ». Leur statut est courant et non historique : les cercles sont
 * donc masqués quand la frise quitte son dernier cran. */
const PSFDF_COLORS = {
  'Hors de contrôle': '#2f2933',
  'En cours': '#e33b32',
  'Fixé': '#f28c28',
  'Maîtrisé': '#e6c229',
  'Éteint': '#4a9f62',
};
// Ordre de peinture, du fond vers le premier plan. Des calques séparés sont
// plus fiables qu'un `circle-sort-key` composite avec MapLibre 5 et rendent la
// même priorité explicite pour les clics.
const PSFDF_LAYERS = [
  ['psfdf-extinguished', 'Éteint'],
  ['psfdf-controlled', 'Maîtrisé'],
  ['psfdf-fixed', 'Fixé'],
  ['psfdf-active', 'En cours'],
  ['psfdf-uncontrolled', 'Hors de contrôle'],
];
const PSFDF_LAYER_IDS = new Set(PSFDF_LAYERS.map(([id]) => id));
const PSFDF_HIT_LAYERS = PSFDF_LAYERS.map(([id]) => id).reverse();
const PSFDF_MAX_ZOOM = 9;
const PSFDF_MAX_AGE_MS = 7 * 86400000;
const PSFDF_SHORTCUT_STATUSES = new Set(['Hors de contrôle', 'En cours']);
// `overview` reste utilisé par le graphique FIRMS local et `features` par le
// contexte des moyens aériens.
const FIRE_CONTEXT = { overview: [], features: [] };
const incidentsEl = document.getElementById('incidents');
const psfdfPanel = document.getElementById('psfdf-panel');
const psfdfPanelTitle = document.getElementById('psfdf-panel-title');
const psfdfPanelSub = document.getElementById('psfdf-panel-sub');
const psfdfPanelBody = document.getElementById('psfdf-panel-body');
const psfdfHeadStatus = document.getElementById('psfdf-head-status');
const psfdfRelative = document.getElementById('psfdf-relative');
const psfdfPanelToggle = document.getElementById('psfdf-panel-toggle');
let psfdfPanelFeatureId = null;

function psfdfUpdatedTimestamp(value) {
  const text = String(value || '').replace(/\u00a0/g, ' ').replace('à', ' ').trim();
  const match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!match) return NaN;
  const [, first, second, year, hour = 0, minute = 0, seconds = 0] = match;
  const candidates = [[second, first], [first, second]].map(([month, day]) => {
    const date = new Date(Number(year), Number(month) - 1, Number(day),
      Number(hour), Number(minute), Number(seconds));
    return date.getFullYear() === Number(year)
      && date.getMonth() === Number(month) - 1 && date.getDate() === Number(day)
      ? date.getTime() : NaN;
  }).filter(Number.isFinite);
  return candidates.reduce((nearest, candidate) =>
    Math.abs(candidate - Date.now()) < Math.abs(nearest - Date.now())
      ? candidate : nearest, candidates[0] ?? NaN);
}

function currentPsfdf(data) {
  const now = Date.now();
  return {
    ...data,
    features: (data.features || []).filter(feature => {
      const p = feature.properties || {};
      const timestamp = psfdfHasNumber(p.updated_ts)
        ? Number(p.updated_ts) * 1000 : psfdfUpdatedTimestamp(p.updated);
      return Number.isFinite(timestamp)
        && now - timestamp >= 0 && now - timestamp <= PSFDF_MAX_AGE_MS;
    }),
  };
}

function psfdfRelativeLabel(timestamp) {
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
  if (minutes < 1) return 'à l’instant';
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return `il y a ${hours}h${rest ? String(rest).padStart(2, '0') : ''}`;
  }
  const days = Math.floor(hours / 24), rest = hours % 24;
  return `il y a ${days}j${rest ? ` ${rest}h` : ''}`;
}

function refreshPsfdfRelative() {
  const timestamp = Number(psfdfRelative.dataset.timestamp);
  if (!Number.isFinite(timestamp)) return;
  psfdfRelative.textContent = psfdfRelativeLabel(timestamp);
}
setInterval(refreshPsfdfRelative, 30000);

function setPsfdfPanelOpen(open) {
  psfdfPanel.classList.toggle('open', open);
  psfdfPanelToggle.setAttribute('aria-expanded', open);
  psfdfPanelToggle.setAttribute('aria-label',
    open ? 'Masquer les détails du feu' : 'Afficher les détails du feu');
}

function setPsfdfPanelVisible(visible) {
  if (!MOBILE) {
    psfdfPanel.hidden = !visible;
    return;
  }
  // Le panneau reste dans la mise en page pour permettre le fondu inverse.
  // `visibility` et `inert` le retirent tout de même de la navigation tactile
  // et clavier une fois l'animation terminée.
  psfdfPanel.hidden = false;
  document.body.classList.toggle('psfdf-focus', visible);
  psfdfPanel.setAttribute('aria-hidden', visible ? 'false' : 'true');
  incidentsEl.toggleAttribute('inert', visible);
  incidentsEl.setAttribute('aria-hidden', visible ? 'true' : 'false');
  if (!visible) setPsfdfPanelOpen(false);
}
psfdfPanelToggle.addEventListener('click', () => {
  if (!MOBILE) return;
  setPsfdfPanelOpen(!psfdfPanel.classList.contains('open'));
});

function renderIncidentButtons(features) {
  incidentsEl.replaceChildren();
  for (const [index, feature] of features.entries()) {
    const { commune, departement, status, surface } = feature.properties;
    const button = document.createElement('button');
    button.type = 'button';
    const area = Number(surface);
    const hasArea = surface !== null && surface !== '' && Number.isFinite(area);
    const metric = hasArea ? `${nf(area, 1)} ha` : status;
    const place = departement || commune || 'Incendie';
    button.textContent = `${place} — ${metric}`;
    button.style.setProperty('--incident-color', PSFDF_COLORS[status]);
    button.title = `${commune ? `${commune} — ` : ''}${status}`
      + `${hasArea ? ` — ${nf(area, 1)} ha` : ''} — zoomer sur cet incendie`;
    button.setAttribute('aria-label', `Zoomer sur l’incendie de ${place}, ${metric}`);
    button.addEventListener('click', () => {
      trackUsage('incident-shortcut', { place, rank: index + 1, status });
      focusIncident(feature);
    });
    incidentsEl.appendChild(button);
  }
  incidentsEl.hidden = !features.length;
}

function psfdfHasNumber(value) {
  return value !== null && value !== '' && Number.isFinite(Number(value));
}

function psfdfResources(p) {
  const explicitPlanes = ['canadair', 'dash', 'airtractor']
    .reduce((sum, key) => sum + (psfdfHasNumber(p[key]) ? Number(p[key]) : 0), 0);
  const explicitHelicopters = ['hbe', 'hbel']
    .reduce((sum, key) => sum + (psfdfHasNumber(p[key]) ? Number(p[key]) : 0), 0);
  const planes = psfdfHasNumber(p.avions) ? Number(p.avions) : explicitPlanes;
  const helicopters = psfdfHasNumber(p.helicopteres)
    ? Number(p.helicopteres) : explicitHelicopters;
  const parts = [];
  if (planes) parts.push(`${nf(planes)} avion${planes > 1 ? 's' : ''}`);
  if (helicopters) parts.push(`${nf(helicopters)} hélico${helicopters > 1 ? 's' : ''}`);
  return parts.join(', ') || 'non renseigné';
}

function psfdfStat(label, value) {
  const box = document.createElement('div');
  box.className = 'psfdf-stat';
  const caption = document.createElement('small');
  caption.textContent = label;
  const number = document.createElement('b');
  number.textContent = value;
  box.append(caption, number);
  return box;
}

const PSFDF_ACTIVITY_MIN_RADIUS_KM = 3;
const PSFDF_ACTIVITY_MAX_RADIUS_KM = 60;
const PSFDF_ACTIVITY_HOTSPOT_GAP_KM = 4;
const PSFDF_ACTIVITY_HOTSPOT_MARGIN_KM = 2.5;

/* Le disque d'activité part de la surface déclarée par PSFDF, convertie en
 * rayon équivalent puis volontairement élargie : un feu réel n'est presque
 * jamais circulaire. Les périmètres EFFIS déjà rapprochés côté collecte et la
 * dispersion des pixels FIRMS détaillés peuvent seulement l'agrandir. */
function psfdfActivityArea(feature) {
  const p = feature.properties, center = feature.geometry.coordinates;
  const areaHa = psfdfHasNumber(p.surface) ? Math.max(0, Number(p.surface)) : 0;
  const equivalentRadius = areaHa ? Math.sqrt(areaHa / 100 / Math.PI) : 0;
  let radius = areaHa
    ? 1.5 + 1.8 * equivalentRadius
    : PSFDF_ACTIVITY_MIN_RADIUS_KM + 2;
  const basis = areaHa ? ['surface PSFDF'] : [];

  if (psfdfHasNumber(p.effis_radius_km)) {
    // `effis_radius_km` couvre déjà tous les morceaux EFFIS rapprochés ; la
    // marge supplémentaire absorbe l'incertitude du contour et de l'arrondi.
    radius = Math.max(radius, 1.5 + 1.15 * Number(p.effis_radius_km));
    basis.push(`${Number(p.effis_matches) > 1 ? `${nf(Number(p.effis_matches))} périmètres` : 'périmètre'} EFFIS`);
  }
  if (Array.isArray(p.original_center)) {
    // Quand EFFIS a recentré le point, conserver aussi une marge autour de la
    // position PSFDF initiale évite de couper une extension encore non levée.
    radius = Math.max(radius, distanceKm(center, p.original_center) + 2.5);
  }

  const searchLimit = Math.min(PSFDF_ACTIVITY_MAX_RADIUS_KM,
    Math.max(15, radius * 2.2));
  const distances = zonesController.getHotspots()
    .map(hotspot => distanceKm(center, hotspot.geometry.coordinates))
    .filter(distance => distance <= searchLimit)
    .sort((a, b) => a - b);
  let frontier = radius + 3, furthest = 0;
  for (const distance of distances) {
    if (distance > frontier + PSFDF_ACTIVITY_HOTSPOT_GAP_KM) break;
    furthest = distance;
    frontier = Math.max(frontier, distance);
  }
  const hotspotRadius = furthest + PSFDF_ACTIVITY_HOTSPOT_MARGIN_KM;
  if (furthest && hotspotRadius > radius) {
    radius = hotspotRadius;
    basis.push('foyers FIRMS');
  }

  radius = Math.min(PSFDF_ACTIVITY_MAX_RADIUS_KM,
    Math.max(PSFDF_ACTIVITY_MIN_RADIUS_KM, Math.ceil(radius * 2) / 2));
  if (!basis.length) basis.push('marge minimale');
  return { radius, basis: basis.join(' + ') };
}

/* L'aperçu national place chaque agrégat au centre d'une cellule de 0,25°.
 * On teste donc l'intersection du disque avec la cellule, pas seulement avec
 * son centre : cela assume délibérément le léger excès plutôt qu'une coupure. */
function psfdfOverviewCellDistance(center, coordinates) {
  const halfCell = .125;
  const nearest = [
    Math.min(Math.max(center[0], coordinates[0] - halfCell), coordinates[0] + halfCell),
    Math.min(Math.max(center[1], coordinates[1] - halfCell), coordinates[1] + halfCell),
  ];
  return distanceKm(center, nearest);
}

function psfdfActivityPassages(feature, area) {
  const shownHotspots = getState().layerVisibility.hotspots;
  const center = feature.geometry.coordinates;
  const grouped = new Map();
  for (const hotspot of FIRE_CONTEXT.overview) {
    const p = hotspot.properties;
    if (!shownHotspots[p.source]
        || psfdfOverviewCellDistance(center, hotspot.geometry.coordinates) > area.radius) continue;
    const key = `${p.source}/${p.ts}`;
    if (!grouped.has(key))
      grouped.set(key, { ts: p.ts, kind: 'sat', label: p.source, n: 0, frp: 0 });
    grouped.get(key).n += +p.n || 1;
    grouped.get(key).frp += +p.frp || 0;
  }
  return [...grouped.values()].sort((a, b) => a.ts - b.ts);
}

function psfdfActivityAxisValue(value) {
  if (value >= 10000) return `${nf(value / 1000, 1)}k`;
  return activityTickLabel(value);
}

function psfdfActivityAxisDate(timestamp) {
  return new Date(timestamp * 1000).toLocaleDateString('fr-FR', {
    day: '2-digit', month: '2-digit',
  });
}

function renderPsfdfActivity(container, feature) {
  const steps = getState().steps;
  const area = psfdfActivityArea(feature);
  const passes = psfdfActivityPassages(feature, area);
  const activityMetric = activityController.getMetric();
  const head = document.createElement('div');
  head.className = 'psfdf-activity-head';
  const title = document.createElement('strong');
  title.textContent = 'Détections satellite';
  const tabs = document.createElement('div');
  tabs.className = 'psfdf-activity-tabs';
  tabs.setAttribute('aria-label', 'Métrique du graphique local');
  for (const [metric, label] of [['count', 'Foyers'], ['frp', 'Puissance']]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.dataset.metric = metric;
    button.setAttribute('aria-pressed', metric === activityMetric);
    button.disabled = metric === 'frp' && powerMetricInput.disabled;
    button.addEventListener('click', () => {
      activityController.setMetric(metric);
      renderPsfdfActivity(container, feature);
    });
    tabs.append(button);
  }
  head.append(title, tabs);

  if (!passes.length) {
    const empty = document.createElement('div');
    empty.className = 'psfdf-activity-empty';
    empty.textContent = 'Aucune détection récente à proximité.';
    const caption = document.createElement('p');
    caption.className = 'psfdf-activity-caption';
    caption.textContent = `Zone estimée : rayon ${nf(area.radius, 1)} km (${area.basis}).`;
    container.replaceChildren(head, empty, caption);
    return;
  }

  const t0 = steps[0]?.ts ?? passes[0].ts;
  const span = (steps[steps.length - 1]?.ts ?? passes[passes.length - 1].ts) - t0 || 1;
  const peak = Math.max(...passes.map(activityValue), 1);
  const averages = activityMovingAverage(passes);
  const bars = passes.map(step => {
    const left = ((step.ts - t0) / span * 100).toFixed(3);
    const value = activityValue(step);
    const height = (100 * value / peak).toFixed(2);
    const opacity = (.34 + .58 * value / peak).toFixed(2);
    return `<b title="${activityLabel(step)}" style="left:${left}%;height:${height}%;opacity:${opacity}"></b>`;
  }).join('');
  const averagePath = averages.map((point, index) => {
    const x = ((point.ts - t0) / span * 100).toFixed(3);
    const y = (100 - 100 * point.value / peak).toFixed(3);
    return `${index ? 'L' : 'M'} ${x} ${y}`;
  }).join(' ');
  const line = averages.length > 1
    ? `<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path d="${averagePath}"></path></svg>`
    : '';
  const chart = document.createElement('div');
  chart.className = 'psfdf-activity-chart';
  chart.setAttribute('role', 'img');
  const startDate = psfdfActivityAxisDate(t0);
  const endDate = psfdfActivityAxisDate(t0 + span);
  const peakLabel = activityMetric === 'frp' ? powerLabel(peak) : countLabel(peak);
  chart.setAttribute('aria-label', `${passes.length} passages satellite du ${startDate} au ${endDate}, maximum ${peakLabel}, dans une zone estimée de ${nf(area.radius, 1)} kilomètres de rayon`);
  chart.innerHTML = `<span class="psfdf-activity-y" title="Maximum : ${peakLabel}">${psfdfActivityAxisValue(peak)}</span>`
    + `<div class="psfdf-activity-plot">${bars}${line}</div>`
    + `<div class="psfdf-activity-x" aria-hidden="true"><time>${startDate}</time><time>${endDate}</time></div>`;
  const caption = document.createElement('p');
  caption.className = 'psfdf-activity-caption';
  caption.textContent = `Zone estimée : rayon ${nf(area.radius, 1)} km (${area.basis}) · pic : ${
    activityMetric === 'frp' ? powerLabel(peak) : countLabel(peak)}`;
  container.replaceChildren(head, chart, caption);
}

function renderPsfdfDetail(feature) {
  if (!feature) return;
  const featureId = feature.properties.id || feature.properties.commune;
  if (MOBILE && featureId !== psfdfPanelFeatureId) setPsfdfPanelOpen(false);
  psfdfPanelFeatureId = featureId;
  setPsfdfPanelVisible(true);
  const p = feature.properties;
  const accent = PSFDF_COLORS[p.status] || '#a8a29c';
  const accentRgb = accent.match(/[\da-f]{2}/gi).map(part => parseInt(part, 16)).join(',');
  psfdfPanel.style.setProperty('--psfdf-accent', accent);
  psfdfPanel.style.setProperty('--psfdf-glow', `rgba(${accentRgb}, .28)`);
  psfdfPanel.style.setProperty('--psfdf-tint', `rgba(${accentRgb}, .105)`);
  psfdfPanel.style.setProperty('--psfdf-border', `rgba(${accentRgb}, .58)`);
  psfdfPanel.style.setProperty('--psfdf-shadow', `rgba(${accentRgb}, .14)`);
  const place = p.commune || 'Incendie signalé';
  const updatedTimestamp = psfdfHasNumber(p.updated_ts)
    ? Number(p.updated_ts) * 1000 : psfdfUpdatedTimestamp(p.updated);
  psfdfRelative.hidden = !Number.isFinite(updatedTimestamp);
  if (Number.isFinite(updatedTimestamp)) {
    psfdfRelative.dataset.timestamp = updatedTimestamp;
    psfdfRelative.dateTime = new Date(updatedTimestamp).toISOString();
    psfdfRelative.title = p.updated ? `Mis à jour le ${p.updated}` : '';
    refreshPsfdfRelative();
  } else {
    delete psfdfRelative.dataset.timestamp;
  }
  psfdfPanelTitle.textContent = MOBILE && p.departement
    ? `${place} (${p.departement})` : place;
  psfdfPanelSub.textContent = p.departement
    ? `${p.departement}, suivi actuel PSFDF` : 'Suivi actuel PSFDF';
  psfdfHeadStatus.querySelector('i').style.background = accent;
  psfdfHeadStatus.querySelector('span').textContent = p.status;

  const content = document.createElement('div');
  const status = document.createElement('div');
  status.className = 'psfdf-detail-status';
  const dot = document.createElement('i');
  dot.style.background = accent;
  status.append(dot, document.createTextNode(p.status));

  const stats = document.createElement('div');
  stats.className = 'psfdf-stats';
  const area = psfdfHasNumber(p.surface) ? `${nf(Number(p.surface), 1)} ha` : 'non renseignée';
  const personnel = psfdfHasNumber(p.personnel)
    ? nf(Number(p.personnel)) : 'non renseigné';
  stats.append(
    psfdfStat('Surface', area),
    psfdfStat('Personnel', personnel),
    psfdfStat('Moyens aériens', psfdfResources(p)),
    psfdfStat('Département', p.departement || 'Non renseigné'),
  );
  content.append(status, stats);

  const localActivity = document.createElement('section');
  localActivity.className = 'psfdf-activity';
  renderPsfdfActivity(localActivity, feature);
  content.append(localActivity);

  if (p.other_info) {
    const note = document.createElement('p');
    note.className = 'psfdf-note';
    note.textContent = p.other_info;
    content.append(note);
  }
  const dates = document.createElement('p');
  dates.className = 'psfdf-dates';
  dates.textContent = [p.reported ? `Signalé le ${p.reported}` : '',
                       p.updated ? `Mis à jour le ${p.updated}` : '']
    .filter(Boolean).join('. ');
  if (dates.textContent) content.append(dates);

  const link = document.createElement('a');
  link.className = 'psfdf-more';
  link.href = `https://association-psfdf.fr/pages/incendie-details.html?id=${encodeURIComponent(p.id)}`;
  link.target = '_blank';
  link.rel = 'noopener';
  link.append(document.createTextNode('Plus d’information'));
  const source = document.createElement('small');
  source.textContent = 'Association PSFDF';
  link.append(source);
  const externalIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  externalIcon.setAttribute('viewBox', '0 0 24 24');
  externalIcon.setAttribute('aria-hidden', 'true');
  const externalPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  externalPath.setAttribute('d', 'M7 17 17 7M7 7h10v10');
  externalIcon.append(externalPath);
  link.append(externalIcon);
  link.addEventListener('click', () => trackUsage('psfdf-more', {
    place: p.commune || 'unknown', id: p.id || 'unknown',
  }));
  content.append(link);
  psfdfPanelBody.replaceChildren(content);
}

function psfdfFeatureNearCenter() {
  const center = map.getCenter();
  let nearest = null, distance = Infinity;
  for (const feature of FIRE_CONTEXT.features) {
    const current = distanceKm([center.lng, center.lat], feature.properties.center);
    if (current < distance) { nearest = feature; distance = current; }
  }
  const limit = Math.max(8, 45 / 2 ** (map.getZoom() - 7));
  return nearest && distance <= limit ? nearest : null;
}

function updatePsfdfPanel() {
  const { atLatest, layerVisibility } = getState();
  if (!layerVisibility.psfdf || !atLatest || !FIRE_CONTEXT.features.length
      || map.getZoom() < 7) {
    setPsfdfPanelVisible(false);
    return;
  }
  const nearest = psfdfFeatureNearCenter();
  if (nearest) renderPsfdfDetail(nearest);
  else setPsfdfPanelVisible(false);
}

let psfdfZoomFrame = 0;
function updatePsfdfPanelDuringZoom() {
  if (!MOBILE || psfdfZoomFrame) return;
  psfdfZoomFrame = requestAnimationFrame(() => {
    const { atLatest, layerVisibility } = getState();
    psfdfZoomFrame = 0;
    if (!layerVisibility.psfdf || !atLatest || !FIRE_CONTEXT.features.length
        || map.getZoom() < 7) {
      setPsfdfPanelVisible(false);
      return;
    }
    const nearest = psfdfFeatureNearCenter();
    if (!nearest) {
      setPsfdfPanelVisible(false);
      return;
    }
    const featureId = nearest.properties.id || nearest.properties.commune;
    if (featureId !== psfdfPanelFeatureId) renderPsfdfDetail(nearest);
    else setPsfdfPanelVisible(true);
  });
}

function focusIncident(feature, duration = 850, targetZoom = 8.5) {
  timelineController.stop();
  const { lastObservedTime, steps } = getState();
  if (steps.length) setTime(lastObservedTime);
  map.easeTo({
    center: feature.properties.center,
    zoom: Math.max(map.getZoom(), targetZoom),
    duration,
  });
}

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
    if (layerVisibility.psfdf && atLatest) updatePsfdfPanel();
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
    const isPoint = id === 'aircraft-symbol' || PSFDF_LAYER_IDS.has(id)
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
  if (hit.id === 'aircraft-symbol') return aircraftPopup(hit.feature, event.lngLat);
  if (PSFDF_LAYER_IDS.has(hit.id)) {
    closePopup();
    renderPsfdfDetail(hit.feature);
    return;
  }
  const content = hit.id === 'hotspots' ? hotspotPopup(hit.feature, event.lngLat)
    : hit.id === 'hotspots-overview' ? overviewPopup(hit.feature, event.lngLat)
    : hit.id === 'nrt-fill' ? nrtPopup(event.lngLat)
    : burntPopup(hit.feature, event.lngLat);
  openPopup(event.lngLat, content, hit.id);
}

const dataP = loadInitialData(buildSteps);

/* Le badge de température lit le champ fin : il ne peut donc plus attendre
 * l'ouverture du volet météo. Les deux fichiers partent en parallèle des données
 * nationales sans les retarder, et leur échec reste sans conséquence —
 * `thermalAt` retombe sur la grille du vent. `thermal.json` peut d'ailleurs
 * manquer légitimement : il appartient à un workflow de cadence plus lente. */
weatherPromise = json(WEATHER_URL);
weatherPromise.then(data => { weatherData = data; },
                    () => { weatherPromise = null; });
json(THERMAL_URL).then(data => {
  thermalData = data;
  temperatureBadge();
  if (weatherPanel.classList.contains('open') && weatherData) drawWeather();
}, () => {});

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
  // Une aire devient un rayon par racine carrée. Cette échelle visuelle garde
  // un feu sans surface renseignée cliquable, sans faire passer 1 000 ha pour
  // cent fois le diamètre de 10 ha.
  const psfdfSizeRadius = scale => ['*', scale,
    ['interpolate', ['linear'],
      ['sqrt', ['max', 0, ['coalesce', ['get', 'surface'], 0]]],
      0, 8, 10, 11, 31.63, 16, 100, 26,
    ],
  ];
  for (const [id, status] of PSFDF_LAYERS) map.addLayer({
    id, type: 'circle', source: 'psfdf', maxzoom: PSFDF_MAX_ZOOM,
    filter: ['==', ['get', 'status'], status],
    paint: {
      // La taille visuelle suit la surface PSFDF. Lorsqu'un rapprochement EFFIS
      // existe, son rayon kilométrique peut l'agrandir mais jamais le réduire.
      // Une expression composite MapLibre doit garder `zoom` au niveau
      // supérieur ; l'enfouir dans `max` rendait tous les disques invisibles.
      'circle-radius': ['interpolate', ['exponential', 2], ['zoom'],
        4, ['max', psfdfSizeRadius(1),
                    ['*', ['coalesce', ['get', 'effis_radius_km'], 0], .30]],
        7, ['max', psfdfSizeRadius(1.3),
                    ['*', ['coalesce', ['get', 'effis_radius_km'], 0], 2.4]],
        10, ['max', psfdfSizeRadius(1.7),
                     ['*', ['coalesce', ['get', 'effis_radius_km'], 0], 19.2]],
        13, ['max', psfdfSizeRadius(2.2),
                     ['*', ['coalesce', ['get', 'effis_radius_km'], 0], 153.6]],
      ],
      'circle-color': PSFDF_COLORS[status],
      'circle-opacity': .20,
      'circle-stroke-color': PSFDF_COLORS[status],
      'circle-stroke-width': 2.5,
      'circle-stroke-opacity': .98,
      'circle-blur': .04,
    } });
  // Les appareils restent au-dessus des foyers et des surfaces : à basse
  // altitude, plusieurs peuvent se superposer exactement au front actif.
  addAircraftLayers();

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
  FIRE_CONTEXT.overview = overview.features;
  smokeController.configureOverview(overview.features.length ? overview.features
    : (detail ? detail.hotspots.features : []));
  FIRE_CONTEXT.features = psfdf.features.map(feature => {
    feature.properties.center = feature.geometry.coordinates;
    feature.properties.name = feature.properties.commune
      || feature.properties.departement || 'un incendie signalé';
    return feature;
  });
  const shortcuts = FIRE_CONTEXT.features
    .filter(feature => PSFDF_SHORTCUT_STATUSES.has(feature.properties.status))
    .sort((a, b) => {
      const left = a.properties.surface, right = b.properties.surface;
      const leftArea = left !== null && left !== '' && Number.isFinite(Number(left))
        ? Number(left) : -1;
      const rightArea = right !== null && right !== '' && Number.isFinite(Number(right))
        ? Number(right) : -1;
      return rightArea - leftArea;
    });
  renderIncidentButtons(shortcuts);
  updatePsfdfPanel();
  timelineController.configure();
  drawActivity();
  drawUpdates();
  lockWidths();
  // on ouvre sur le dernier état observé, pas sur le bout de la prévision
  setTime(getState().lastObservedTime);
  aircraftSync();

  if (manifest.generated_at) {
    document.getElementById('updated').textContent =
      '— données extraites le ' + fmt(Date.parse(manifest.generated_at) / 1000) + ' (heure de Paris).';
  }

  if (!HAS_MAP_HASH) {
    // Le premier cadrage privilégie la lecture du feu principal, tout en
    // restant sous le zoom 9 où ses disques PSFDF s'effacent.
    if (shortcuts.length) focusIncident(shortcuts[0], 850, 8.8);
    else fitFrance(0);
  }

  // Un seul aiguillage pour tous les clics : voir la section « FICHES AU CLIC ».
  // Le fond de carte est cliquable lui aussi, il répond par la météo du point.
  map.on('click', mapClick);
  map.on('zoom', updatePsfdfPanelDuringZoom);
  map.on('moveend', updatePsfdfPanel);
  map.on('resize', updatePsfdfPanel);
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
  aircraftSync();
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
aircraftCheck.addEventListener('change', event => {
  A.on = event.target.checked;
  aircraftSync();
});
aircraftLabelsCheck.addEventListener('change', event => {
  A.labels = event.target.checked;
  applyAircraftLabels();
});

timelineController.installPlayListener();
