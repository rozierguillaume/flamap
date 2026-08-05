import { getLocale, t } from '../i18n.js';
import { fmtHour, fmtHourMinute, fmtWeekdayTime } from '../util/format.js';
import { gridAt, gridBilinear } from '../util/grid.js';


// v4 : le fichier ne porte plus que le vent. La température vit dans
// `thermal.json`, collecté par un workflow de cadence différente.
const WEATHER_URL = 'data/weather_forecast.json?v=4';
const THERMAL_URL = 'data/thermal.json';
// Emprise du géocodage inverse de la Géoplateforme, qui ne couvre que la France.
const BAN_BBOX = [-5.5, 41.0, 10.0, 51.5];

export function weatherCoordinates(point) {
  const meridian = t(point.lat >= 0 ? 'format.compass.north' : 'format.compass.south');
  const parallel = t(point.lng >= 0 ? 'format.compass.east' : 'format.compass.west');
  return `${Math.abs(point.lat).toFixed(3)}° ${meridian}`
       + `, ${Math.abs(point.lng).toFixed(3)}° ${parallel}`;
}

export function createWeatherController({
  map,
  maplibregl,
  loadJson,
  fetchImpl,
  cardinals,
  fmt,
  getManifest,
  gridValueAt,
  getWindTime,
  legacyTemperatureAt,
  temperatureMetadata,
  getTempKey,
  getTempValue,
  closeUpdates,
  isActivityOpen,
  closeActivity,
  activatePanel = () => {},
  deactivatePanel = () => {},
  trackUsage,
  elements,
}) {
  const {
    panel: weatherPanel,
    button: weatherBtn,
    chart: weatherChart,
    tip: weatherTip,
    place: weatherPlace,
    status: weatherStatus,
    title: weatherTitle,
    follow: weatherFollow,
    close: weatherClose,
    incidents,
    credits,
    creditsButton,
    layers,
    layersButton,
  } = elements;

  let weatherData = null, weatherPromise = null, weatherRows = [];
  let thermalData = null;
  let weatherCommune = '', weatherPlaceRequest = 0;
  const weatherPlaceCache = new Map();
  /* Le panneau lit soit le centre de la carte — son comportement d'origine, qui
   * suit les déplacements — soit un point épinglé au clic. Un seul point à la
   * fois : la fiche météo du clic et le panneau parlent du même endroit. */
  let weatherPin = null, weatherPinMarker = null;

  const weatherTarget = () => weatherPin || map.getCenter();

  /* Géocodage inverse mutualisé entre le panneau et la fiche au clic : le service
   * de l'IGN est rapide mais public, et deux lectures du même endroit sont la
   * règle dès qu'on clique puis qu'on ouvre les prévisions. */
  async function communeAt(lon, lat) {
    const key = `${lon.toFixed(4)},${lat.toFixed(4)}`;
    if (weatherPlaceCache.has(key)) return weatherPlaceCache.get(key);
    // La carte déborde le domaine de la BAN : hors de France, le service
    // répond sans erreur et sans résultat. Autant ne pas l'appeler.
    if (!(lon >= BAN_BBOX[0] && lon <= BAN_BBOX[2]
          && lat >= BAN_BBOX[1] && lat <= BAN_BBOX[3])) {
      weatherPlaceCache.set(key, '');
      return '';
    }
    const url = new URL('https://data.geopf.fr/geocodage/reverse/');
    url.searchParams.set('lon', lon.toFixed(6));
    url.searchParams.set('lat', lat.toFixed(6));
    url.searchParams.set('limit', '1');
    const response = await fetchImpl(url);
    if (!response.ok)
      throw new Error(t('weather.geocode.error', { status: response.status }));
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
    weatherTitle.textContent =
      t(weatherPin ? 'weather.title.pin' : 'weather.title.center');
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

  /* Température et pluie au pas de 20 km quand `thermal.json` couvre l'instant
   * demandé. Sinon la grille du vent prend le relais : plus grossière — elle
   * lisse les reliefs et sous-estime les plaines de plusieurs degrés — mais elle
   * couvre les dix jours de la frise, et elle est là dès le premier déploiement,
   * avant que le workflow météo n'ait tourné une première fois. */
  function thermalAt(key, lon, lat, ts) {
    const fine = gridAt(thermalData, key, lon, lat, ts);
    if (Number.isFinite(fine)) return fine;
    return gridValueAt(key, lon, lat, ts);
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

  function hideWeatherTip() {
    weatherTip.classList.remove('open', 'right');
    const line = weatherChart.querySelector('.hover-line');
    if (line) line.setAttribute('visibility', 'hidden');
  }

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
      weatherStatus.textContent = t('weather.nodata');
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
    const manifest = getManifest();
    const updated = manifest && manifest.generated_at
      ? Date.parse(manifest.generated_at) / 1000 : NaN;
    if (updated >= rows[0].ts && updated <= rows[rows.length - 1].ts) {
      const markerX = timeX(updated);
      const hour = fmtHourMinute(updated);
      const anchor = markerX < (left + right) / 2 ? 'start' : 'end';
      const offset = anchor === 'start' ? 5 : -5;
      svg += `<line x1="${markerX.toFixed(1)}" y1="${tempTop}" x2="${markerX.toFixed(1)}"`
           + ` y2="${precipBottom}" class="update-line"/>`;
      svg += svgText((markerX + offset).toFixed(1), 134,
        t('weather.mapAt', { hour }), 'update-label', anchor);
    }
    if (now >= rows[0].ts && now <= rows[rows.length - 1].ts) {
      const markerX = timeX(now);
      const anchor = markerX < (left + right) / 2 ? 'start' : 'end';
      const offset = anchor === 'start' ? 5 : -5;
      svg += `<line x1="${markerX.toFixed(1)}" y1="${tempTop}" x2="${markerX.toFixed(1)}"`
           + ` y2="${precipBottom}" class="now-line"/>`;
      svg += svgText((markerX + offset).toFixed(1), 25, t('weather.now'), 'now-label', anchor);
    }
    svg += svgText(left, 25, t('weather.axis.temperature'), 'axis', 'start');
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
    svg += svgText(left, 161, t('weather.axis.wind'), 'axis', 'start');
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
    svg += svgText(left, 297, t('weather.axis.precipitation'), 'axis', 'start');
    svg += svgText(4, precipTop + 4,
      precipitationMax.toLocaleString(getLocale(), { maximumFractionDigits: 1 }), 'axis', 'start');
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
        const hour = fmtHour(row.ts);
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
    weatherChart.setAttribute('aria-label', t('weather.chart.summary', {
      first: first.temperature.toFixed(1), last: last.temperature.toFixed(1),
      speed: Math.round(first.speed), gust: Math.round(first.gust),
      precipitation: Math.max(...rows.map(row => row.precipitation)).toFixed(2),
    }));
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
    const from = cardinals[Math.round(((to + 180) % 360) / 22.5) % 16];
    const hour = fmtWeekdayTime(row.ts);
    const kind = t(row.ts <= Date.now() / 1000
      ? 'weather.kind.past' : 'weather.kind.forecast');
    weatherTip.innerHTML = `<strong>${hour} — ${kind}</strong>`
      + `<span class="temperature">${row.temperature.toLocaleString(getLocale(),
        { minimumFractionDigits: 1, maximumFractionDigits: 1 })} °C</span>`
      + `<span>${t('weather.tip.wind', { dir: from, kmh: Math.round(row.speed) })}</span>`
      + `<span>${t('weather.tip.gust', { kmh: Math.round(row.gust) })}</span>`
      + `<span>${t('weather.tip.precipitation', {
        mm: row.precipitation.toLocaleString(getLocale(),
          { minimumFractionDigits: 1, maximumFractionDigits: 2 }) })}</span>`;
    weatherTip.style.left = `${x / 430 * rect.width}px`;
    weatherTip.style.top = (event.clientY - rect.top) < rect.height / 2
      ? `${rect.height * .44}px` : '28px';
    weatherTip.classList.toggle('right', x > 260);
    weatherTip.classList.add('open');
  }

  weatherChart.addEventListener('pointermove', showWeatherTip);
  weatherChart.addEventListener('pointerdown', showWeatherTip);
  weatherChart.addEventListener('pointerleave', hideWeatherTip);

  async function loadWeather() {
    weatherStatus.textContent = t('weather.loading');
    weatherStatus.className = '';
    try {
      if (!weatherPromise) weatherPromise = loadJson(WEATHER_URL);
      weatherData = await weatherPromise;
      if (weatherPanel.classList.contains('open')) drawWeather();
    } catch (error) {
      weatherPromise = null;
      weatherStatus.textContent = t('weather.unavailable');
      weatherStatus.className = 'error';
    }
  }

  function setOpen(open) {
    const wasOpen = weatherPanel.classList.contains('open');
    weatherPanel.classList.toggle('open', open);
    weatherBtn.setAttribute('aria-expanded', open);
    incidents.classList.toggle('weather-open', open);
    if (open) {
      activatePanel();
      closeUpdates();
      if (isActivityOpen()) closeActivity();
      credits.classList.remove('open');
      creditsButton.setAttribute('aria-expanded', 'false');
      layers.classList.remove('open');
      layersButton.setAttribute('aria-expanded', 'false');
      incidents.classList.remove('credits-open', 'layers-open');
      updateWeatherPlace();
      if (weatherData) drawWeather(); else loadWeather();
      weatherClose.focus();
    } else if (wasOpen) {
      deactivatePanel();
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
    setOpen(open);
  });
  weatherClose.addEventListener('click', () => setOpen(false));
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

  /* Le panneau ouvert sur un point épinglé : la fiche au clic y renvoie pour les
   * 24 h de contexte que la lecture instantanée ne donne pas. */
  function openAt(lngLat) {
    setWeatherPin(lngLat);
    if (weatherPanel.classList.contains('open')) {
      updateWeatherPlace();
      if (weatherData) drawWeather(); else loadWeather();
    } else {
      setOpen(true);
    }
  }

  function temperatureAt(lon, lat) {
    const fine = thermalAt('temperature', lon, lat, getWindTime());
    if (Number.isFinite(fine)) return fine;
    return legacyTemperatureAt(lon, lat);
  }

  function temperatureBadge() {
    const center = map.getCenter();
    const value = temperatureAt(center.lng, center.lat);
    const tempKey = getTempKey();
    tempKey.hidden = !Number.isFinite(value);
    if (tempKey.hidden) return;
    getTempValue().textContent = `${Math.round(value)} °C`;
    // Les champs datés suivent la frise ; l'instantané des anciens exports locaux
    // porte sa propre heure.
    const metadata = temperatureMetadata();
    const stamp = thermalData || metadata.dated
      ? getWindTime() : metadata.ts;
    tempKey.title = stamp
      ? t('weather.badge.title.at', { date: fmt(stamp) })
      : t('weather.badge.title');
  }

  /* Le badge de température lit le champ fin : il ne peut donc plus attendre
   * l'ouverture du volet météo. Les deux fichiers partent en parallèle des données
   * nationales sans les retarder, et leur échec reste sans conséquence —
   * `thermalAt` retombe sur la grille du vent. `thermal.json` peut d'ailleurs
   * manquer légitimement : il appartient à un workflow de cadence plus lente. */
  function startData() {
    weatherPromise = loadJson(WEATHER_URL);
    weatherPromise.then(data => { weatherData = data; },
                        () => { weatherPromise = null; });
    loadJson(THERMAL_URL).then(data => {
      thermalData = data;
      temperatureBadge();
      if (weatherPanel.classList.contains('open') && weatherData) drawWeather();
    }, () => {});
  }

  return {
    communeAt,
    coordinates: weatherCoordinates,
    openAt,
    setOpen,
    startData,
    temperatureAt,
    temperatureBadge,
  };
}
