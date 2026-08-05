import { t } from '../i18n.js';
import { EMPTY } from '../data/client.js';
import { nf } from '../util/format.js';
import { aircraftBearing, aircraftCurve, distanceKm } from '../util/geo.js';
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
export function createAircraftController({
  map,
  getState,
  nearestActiveFeature,
  openPopup,
  closePopup,
  isPopupKind,
  hoverCursor,
  fetchImpl = (...args) => fetch(...args),
  elements,
}) {
  const {
    check: aircraftCheck,
    labelsCheck: aircraftLabelsCheck,
    status: aircraftStatus,
  } = elements;

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
    if (isPopupKind('aircraft-symbol')) closePopup();
  }

  function nearestAircraftFire(center) {
    const nearest = nearestActiveFeature(center, AIRCRAFT_FIRE_KM);
    if (!nearest) return null;
    return {
      distance: Math.round(nearest.distance),
      name: nearest.feature.properties.name || t('aircraft.nearFire'),
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
      const response = await fetchImpl(AIRCRAFT_HISTORY_URL, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok)
        throw new Error(t('aircraft.history.http', { status: response.status }));
      const data = await response.json();
      if (!A.on || !getState().atLatest || document.hidden) return;
      if (!data || !Array.isArray(data.aircraft))
        throw new Error(t('aircraft.history.invalid'));

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
    aircraftStatusText(t('aircraft.searching'));
    try {
      const response = await fetchImpl(AIRCRAFT_URL, {
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
        ? t(near ? 'aircraft.flying.near' : 'aircraft.flying',
            { n: fresh.length, near })
        : t('aircraft.none'));
    } catch (error) {
      if (error.name !== 'AbortError' && A.on)
        aircraftStatusText(t('aircraft.unavailable'));
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
      aircraftStatusText(t('aircraft.past'));
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
      [p.altitude !== null ? `${nf(Number(p.altitude))} ft` : '',
       p.speed !== null ? `${Math.round(Number(p.speed) * 1.852)} km/h` : ''],
      [p.near_fire
        ? t('aircraft.distance', { km: p.fire_distance, name: p.fire_name }) : '', ''],
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
      age.textContent = (seconds === null
        ? t('aircraft.age.unknown') : t('aircraft.age', { n: seconds }))
        + t('aircraft.delay',
            { n: AIRCRAFT_DELAY_MS / 1000, icao: p.hex.toUpperCase() });
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


    function setEnabled(enabled) {
      A.on = enabled;
      aircraftSync();
    }

    function setLabels(enabled) {
      A.labels = enabled;
      applyAircraftLabels();
    }

    return {
      install: addAircraftLayers,
      sync: aircraftSync,
      setEnabled,
      setLabels,
      renderPopup: aircraftPopup,
      icon: aircraftIcon,
      helicopterIcon,
    };
}
