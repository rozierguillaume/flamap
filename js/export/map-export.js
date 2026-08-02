import { fmtClock } from '../util/format.js';
import { SMOKE_H, SMOKE_LIVE_K, SMOKE_WINDOW } from '../fx/smoke.js';

export function restoreExportEffects(snapshot, windController, smokeController) {
  try {
    windController.restoreExport(snapshot.wind);
  } finally {
    smokeController.restoreExport(snapshot.smoke);
  }
}

export function createMapExportController({
  mobile: MOBILE,
  map,
  getState,
  getTimelineController,
  getZonesController,
  firesController,
  burntController,
  getPsfdfController,
  getAircraftController,
  windController,
  smokeController,
  appearAt,
  panelManager,
  setUpdatesOpen,
  setActivityOpen,
  setWeatherOpen,
  trackUsage,
} = {}) {
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
const WIND_LANE = windController.getExportLanes();
const windAt = (...args) => windController.at(...args);

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
  live = getState().atLatest && !getTimelineController().isPlaying()) {
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

function drawExportFooter(ctx, generatedAt, shownTime = getTimelineController().getTime(), media = 'Image') {
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

  const manifestGeneratedAt = getZonesController().getManifest()?.generated_at;
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
        exportMap.addImage(event.id, getAircraftController().icon(), { pixelRatio: 2 });
      if (event.id === 'fire-helicopter' && !exportMap.hasImage(event.id))
        exportMap.addImage(event.id, getAircraftController().helicopterIcon(), { pixelRatio: 2 });
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
  liveSmoke = getState().atLatest && !getTimelineController().isPlaying(),
  shownTime = getTimelineController().getTime(),
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
  getPsfdfController().paint(exportMap, latest);
  for (const layer of exportMap.getStyle().layers || [])
    if (layer.id.startsWith('aircraft-'))
      exportMap.setLayoutProperty(layer.id, 'visibility', 'none');
}

function saveExportWind() {
  const wind = windController.pauseForExport();
  try {
    return { wind, smoke: smokeController.pauseForExport() };
  } catch (error) {
    windController.restoreExport(wind);
    throw error;
  }
}

function setExportWind(ts) {
  windController.setExportTime(ts);
}

function restoreExportWind(state) {
  restoreExportEffects(state, windController, smokeController);
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
  const resources = await Promise.allSettled([
    loadGifEncoder(), createExportMap(),
  ]);
  const session = resources[1].status === 'fulfilled' ? resources[1].value : null;
  if (resources[0].status === 'rejected' || resources[1].status === 'rejected') {
    destroyExportMap(session);
    throw (resources[0].status === 'rejected' ? resources[0].reason : resources[1].reason);
  }
  const { GIFEncoder, quantize, applyPalette } = resources[0].value;
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
    ? liveSmoke : buildExportSmoke(getTimelineController().getTime());
  try {
    for (let frame = 0; frame < frameCount; frame++) {
      const progress = frame / Math.max(frameCount - 1, 1);
      let shownTime = getTimelineController().getTime();
      if (mode === 'evolution') {
        shownTime = getTimelineController().timeAtProgress(progress);
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
    try {
      restoreExportWind(savedWind);
    } finally {
      destroyExportMap(session);
    }
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
    panelManager.activate('export', () => {
    exportWind.disabled = !windController.hasCurrent();
    setUpdatesOpen(false);
    setActivityOpen(false);
    setWeatherOpen(false);
    document.getElementById('credits').classList.remove('open');
    document.getElementById('cr-btn').setAttribute('aria-expanded', 'false');
    document.getElementById('layers').classList.remove('open');
    document.getElementById('layers-btn').setAttribute('aria-expanded', 'false');
    document.getElementById('incidents').classList.remove('credits-open', 'layers-open');
    });
    requestAnimationFrame(() => exportKindButtons
      .find(button => button.dataset.exportKind === exportKind)?.focus());
  } else {
    panelManager.deactivate('export');
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
  getTimelineController().stop();
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

  return {
    enable: () => { exportBtn.disabled = false; },
    setOpen: setExportOpen,
  };
}
