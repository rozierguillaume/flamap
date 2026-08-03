import { nf } from '../util/format.js';
import { distanceKm } from '../util/geo.js';


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
export const PSFDF_HIT_LAYERS = Object.freeze(PSFDF_LAYERS.map(([id]) => id).reverse());
export const isPsfdfLayer = id => PSFDF_LAYER_IDS.has(id);
const PSFDF_MAX_ZOOM = 9;
const PSFDF_MAX_AGE_MS = 7 * 86400000;
const PSFDF_SHORTCUT_STATUSES = new Set(['Hors de contrôle', 'En cours']);
const PSFDF_ACTIVITY_MIN_RADIUS_KM = 3;
const PSFDF_ACTIVITY_MAX_RADIUS_KM = 60;
const PSFDF_ACTIVITY_HOTSPOT_GAP_KM = 4;
const PSFDF_ACTIVITY_HOTSPOT_MARGIN_KM = 2.5;

function psfdfHasNumber(value) {
  return value !== null && value !== '' && Number.isFinite(Number(value));
}

export function psfdfUpdatedTimestamp(value) {
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

export function currentPsfdf(data) {
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

export function createPsfdfController({
  mobile,
  map,
  getState,
  getHotspots,
  activityController,
  powerMetricInput,
  trackUsage,
  stopTimeline,
  setTime,
  elements,
}) {
  const {
    incidents: incidentsEl,
    panel: psfdfPanel,
    panelTitle: psfdfPanelTitle,
    panelSub: psfdfPanelSub,
    panelBody: psfdfPanelBody,
    headStatus: psfdfHeadStatus,
    relative: psfdfRelative,
    panelToggle: psfdfPanelToggle,
  } = elements;

  // `overview` reste utilisé par le graphique FIRMS local et `features` par le
  // contexte des moyens aériens.
  let overview = [], features = [];
  let psfdfPanelFeatureId = null;
  let psfdfZoomFrame = 0;

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
  const relativeTimer = setInterval(refreshPsfdfRelative, 30000);

  function setPsfdfPanelOpen(open) {
    psfdfPanel.classList.toggle('open', open);
    psfdfPanelToggle.setAttribute('aria-expanded', open);
    psfdfPanelToggle.setAttribute('aria-label',
      open ? 'Masquer les détails du feu' : 'Afficher les détails du feu');
  }

  function setPsfdfPanelVisible(visible) {
    if (!mobile) {
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
    if (!mobile) return;
    setPsfdfPanelOpen(!psfdfPanel.classList.contains('open'));
  });

  function focusIncident(feature, duration = 850, targetZoom = 8.5) {
    stopTimeline();
    const { lastObservedTime, steps } = getState();
    if (steps.length) setTime(lastObservedTime);
    map.easeTo({
      center: feature.properties.center,
      zoom: Math.max(map.getZoom(), targetZoom),
      duration,
    });
  }

  function renderIncidentButtons(shortcuts) {
    incidentsEl.replaceChildren();
    for (const [index, feature] of shortcuts.entries()) {
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
    incidentsEl.hidden = !shortcuts.length;
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
    const distances = getHotspots()
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
    for (const hotspot of overview) {
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
    return activityController.tickLabel(value);
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
    const peak = Math.max(...passes.map(step => activityController.value(step)), 1);
    const averages = activityController.movingAverage(passes);
    const bars = passes.map(step => {
      const left = ((step.ts - t0) / span * 100).toFixed(3);
      const value = activityController.value(step);
      const height = (100 * value / peak).toFixed(2);
      const opacity = (.34 + .58 * value / peak).toFixed(2);
      return `<b title="${activityController.label(step)}" style="left:${left}%;height:${height}%;opacity:${opacity}"></b>`;
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
    const peakLabel = activityMetric === 'frp'
      ? activityController.powerLabel(peak) : activityController.countLabel(peak);
    chart.setAttribute('aria-label', `${passes.length} passages satellite du ${startDate} au ${endDate}, maximum ${peakLabel}, dans une zone estimée de ${nf(area.radius, 1)} kilomètres de rayon`);
    chart.innerHTML = `<span class="psfdf-activity-y" title="Maximum : ${peakLabel}">${psfdfActivityAxisValue(peak)}</span>`
      + `<div class="psfdf-activity-plot">${bars}${line}</div>`
      + `<div class="psfdf-activity-x" aria-hidden="true"><time>${startDate}</time><time>${endDate}</time></div>`;
    const caption = document.createElement('p');
    caption.className = 'psfdf-activity-caption';
    caption.textContent = `Zone estimée : rayon ${nf(area.radius, 1)} km (${area.basis}) · pic : ${
      activityMetric === 'frp' ? activityController.powerLabel(peak) : activityController.countLabel(peak)}`;
    container.replaceChildren(head, chart, caption);
  }

  function renderPsfdfDetail(feature) {
    if (!feature) return;
    const featureId = feature.properties.id || feature.properties.commune;
    if (mobile && featureId !== psfdfPanelFeatureId) setPsfdfPanelOpen(false);
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
    psfdfPanelTitle.textContent = mobile && p.departement
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
    for (const feature of features) {
      const current = distanceKm([center.lng, center.lat], feature.properties.center);
      if (current < distance) { nearest = feature; distance = current; }
    }
    const limit = Math.max(8, 45 / 2 ** (map.getZoom() - 7));
    return nearest && distance <= limit ? nearest : null;
  }

  function nearestActiveFeature(center, maxDistance) {
    let best = null, distance = Infinity;
    for (const feature of features) {
      if (feature.properties.status === 'Éteint') continue;
      const current = distanceKm(center, feature.properties.center);
      if (current < distance) { best = feature; distance = current; }
    }
    return best && distance <= maxDistance ? { feature: best, distance } : null;
  }

  function updatePsfdfPanel() {
    const { atLatest, layerVisibility } = getState();
    if (!layerVisibility.psfdf || !atLatest || !features.length
        || map.getZoom() < 7) {
      setPsfdfPanelVisible(false);
      return;
    }
    const nearest = psfdfFeatureNearCenter();
    if (nearest) renderPsfdfDetail(nearest);
    else setPsfdfPanelVisible(false);
  }

  function updatePsfdfPanelDuringZoom() {
    if (!mobile || psfdfZoomFrame) return;
    psfdfZoomFrame = requestAnimationFrame(() => {
      const { atLatest, layerVisibility } = getState();
      psfdfZoomFrame = 0;
      if (!layerVisibility.psfdf || !atLatest || !features.length
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

  function install() {
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
  }

  function apply() {
    const { atLatest, layerVisibility } = getState();
    for (const [id] of PSFDF_LAYERS)
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility',
        layerVisibility.psfdf && atLatest ? 'visible' : 'none');
    if (layerVisibility.psfdf) updatePsfdfPanel();
    else setPsfdfPanelVisible(false);
  }

  function paint(targetMap, latest) {
    for (const [id] of PSFDF_LAYERS)
      if (targetMap.getLayer(id))
        targetMap.setLayoutProperty(id, 'visibility', latest ? 'visible' : 'none');
  }

  function configure(nextOverview, nextFeatures) {
    overview = nextOverview;
    features = nextFeatures.map(feature => {
      feature.properties.center = feature.geometry.coordinates;
      feature.properties.name = feature.properties.commune
        || feature.properties.departement || 'un incendie signalé';
      return feature;
    });
    const shortcuts = features
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
    return shortcuts;
  }

  function destroy() {
    clearInterval(relativeTimer);
    if (psfdfZoomFrame) cancelAnimationFrame(psfdfZoomFrame);
  }

  return Object.freeze({
    apply,
    configure,
    destroy,
    focusIncident,
    getOverview: () => overview,
    install,
    nearestActiveFeature,
    paint,
    renderDetail: renderPsfdfDetail,
    updatePanel: updatePsfdfPanel,
    updatePanelDuringZoom: updatePsfdfPanelDuringZoom,
  });
}
