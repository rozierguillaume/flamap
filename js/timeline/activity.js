const H = 3600;
export const ACTIVITY_AVERAGE_H = 48;


export function activityValue(step, metric = 'count') {
  return metric === 'frp' ? (+step.frp || 0) : step.n;
}

/* Les passages ne sont pas espacés régulièrement : une moyenne sur un nombre
 * fixe de barres changerait de durée selon la zone et la période affichées.
 * La fenêtre est bornée par le temps et centrée sur chaque passage, avec
 * 24 heures de données de chaque côté. Chaque passage compte une fois. */
export function activityMovingAverage(
  passes,
  windowMs = ACTIVITY_AVERAGE_H * H,
  valueOf = step => activityValue(step),
) {
  const averages = [];
  const halfWindow = windowMs / 2;
  let first = 0, last = 0, sum = 0;
  for (let i = 0; i < passes.length; i++) {
    const start = passes[i].ts - halfWindow;
    const end = passes[i].ts + halfWindow;
    while (last < passes.length && passes[last].ts <= end)
      sum += valueOf(passes[last++]);
    while (first < last && passes[first].ts < start)
      sum -= valueOf(passes[first++]);
    averages.push({ ts: passes[i].ts, value: sum / (last - first) });
  }
  return averages;
}

export function activityScale(peak, metric = 'count', intervals = 4) {
  const rawStep = Math.max(peak, Number.EPSILON) / intervals;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  const step = metric === 'count' ? Math.max(1, factor * magnitude) : factor * magnitude;
  const max = Math.max(step, Math.ceil(peak / step) * step);
  const ticks = [];
  for (let value = 0; value <= max + step / 2; value += step) ticks.push(value);
  return { max, ticks };
}

export function activityTickLabel(value, metric = 'count') {
  return value.toLocaleString('fr-FR', {
    maximumFractionDigits: metric === 'frp' && value < 10 ? 1 : 0,
  });
}

export function createActivityController({
  mobile,
  map,
  firmsSources,
  getSteps,
  getContext,
  fmt,
  setOpen,
  elements,
}) {
  const {
    activityEl,
    activityTip,
    activityPanel,
    activityLarge,
    activityDetail,
    activityMetricInputs,
    activityMetricTabs,
    powerMetricInput,
  } = elements;

  let activityMetric =
    activityMetricInputs.find(input => input.checked)?.value || 'count';
  let renderedActivity = [], renderedActivityAverages = [];
  let activityPeak = 1, activityT0 = 0, activitySpan = 1;
  const activityAverageText = `moyenne centrée sur ${ACTIVITY_AVERAGE_H} h`;

  function syncActivityMetricControls() {
    for (const input of activityMetricInputs)
      input.checked = input.value === activityMetric;
    for (const tab of activityMetricTabs) {
      const selected = tab.dataset.activityMetric === activityMetric;
      tab.setAttribute('aria-selected', selected);
      tab.tabIndex = selected ? 0 : -1;
    }
  }

  function setActivityMetric(metric) {
    if (!['count', 'frp'].includes(metric)) return;
    const changed = activityMetric !== metric;
    activityMetric = metric;
    syncActivityMetricControls();
    if (changed) drawActivity();
  }

  /* La frise n'est d'ensemble que lorsque l'emprise de la carte contient
   * réellement toute la bbox du manifeste. Un seuil de zoom ne suffit pas : à
   * zoom égal, un téléphone montre beaucoup moins de territoire qu'un
   * ordinateur. Dès qu'une partie du domaine sort de l'écran, la frise suit
   * donc l'emprise visible et les sources cochées.
   *
   * Les passages locaux sont reconstruits séparément pour chaque satellite :
   * deux détections distantes de moins de 25 minutes appartiennent à la même
   * orbite. C'est la même définition que celle de la timeline nationale. */
  function activityIsNational(bounds = map.getBounds()) {
    const { disabled, manifest } = getContext();
    if (disabled || !manifest) return true;
    const box = manifest.bbox;
    return bounds.getWest() <= box[0] && bounds.getEast() >= box[2]
      && bounds.getSouth() <= box[1] && bounds.getNorth() >= box[3];
  }

  function activityPassages() {
    const { manifest, overview, hotspots, shownHotspots } = getContext();
    const enabled = source => shownHotspots[source];
    const bounds = map.getBounds();
    if (activityIsNational(bounds))
      return getSteps().filter(step => step.kind === 'sat' && enabled(step.label));

    const inside = ([lon, lat]) =>
      lon >= bounds.getWest() && lon <= bounds.getEast()
      && lat >= bounds.getSouth() && lat <= bounds.getNorth();

    // Sous le seuil de chargement des cellules détaillées, l'aperçu national
    // contient déjà une somme par cellule de 0,25°, heure et satellite. On peut
    // donc le découper spatialement sans télécharger tout le domaine.
    if (map.getZoom() < manifest.detail_zoom) {
      const grouped = new Map();
      for (const feature of overview) {
        const p = feature.properties;
        if (!enabled(p.source) || !inside(feature.geometry.coordinates)) continue;
        const key = `${p.source}/${p.ts}`;
        if (!grouped.has(key))
          grouped.set(key, { ts: p.ts, kind: 'sat', label: p.source, n: 0, frp: 0 });
        grouped.get(key).n += +p.n || 1;
        grouped.get(key).frp += +p.frp || 0;
      }
      return [...grouped.values()].sort((a, b) => a.ts - b.ts);
    }

    const bySource = new Map(firmsSources.map(source => [source, []]));
    for (const feature of hotspots) {
      const p = feature.properties, source = p.source;
      if (enabled(source) && inside(feature.geometry.coordinates))
        bySource.get(source)?.push({ ts: p.ts, frp: +p.frp || 0 });
    }

    const passages = [], gap = 25 * 60;
    for (const [label, detections] of bySource) {
      detections.sort((a, b) => a.ts - b.ts);
      let current = null;
      for (const detection of detections) {
        if (current && detection.ts - current.last <= gap) {
          current.n++;
          current.frp += detection.frp;
          current.last = detection.ts;
        } else {
          current = {
            ts: detection.ts, last: detection.ts, kind: 'sat', label,
            n: 1, frp: detection.frp,
          };
          passages.push(current);
        }
      }
    }
    return passages.sort((a, b) => a.ts - b.ts);
  }

  const value = step => activityValue(step, activityMetric);
  const movingAverage = (passes, windowMs = ACTIVITY_AVERAGE_H * H) =>
    activityMovingAverage(passes, windowMs, value);
  const countLabel = n => `${n.toLocaleString('fr-FR')} foyer${n > 1 ? 's' : ''}`;
  const powerLabel = frp => `${frp.toLocaleString('fr-FR', {
    maximumFractionDigits: frp < 100 ? 1 : 0,
  })} MW`;
  const primaryActivityLabel = step =>
    activityMetric === 'frp' ? powerLabel(+step.frp || 0) : countLabel(step.n);
  const secondaryActivityLabel = step =>
    activityMetric === 'frp' ? countLabel(step.n) : powerLabel(+step.frp || 0);
  const label = step =>
    `${fmt(step.ts)} — ${primaryActivityLabel(step)} — ${secondaryActivityLabel(step)} — ${step.label}`;

  function showActivityDetail(index) {
    const step = renderedActivity[index];
    if (!step) return;
    for (const bar of activityLarge.querySelectorAll('b.selected'))
      bar.classList.remove('selected');
    activityLarge.querySelector(`b[data-i="${index}"]`)?.classList.add('selected');
    const strong = document.createElement('strong');
    strong.textContent = primaryActivityLabel(step);
    const meta = document.createElement('span');
    const average = renderedActivityAverages[index]?.value || 0;
    meta.textContent = `${fmt(step.ts)} — ${step.label} — ${secondaryActivityLabel(step)} — ${activityAverageText} : ${activityMetric === 'frp' ? powerLabel(average) : countLabel(Math.round(average))}`;
    activityDetail.replaceChildren(strong, meta);
  }

  function drawLargeActivity(selected = null) {
    if (!activityPanel.classList.contains('open')) return;
    document.getElementById('activity-scope').textContent =
      activityEl.dataset.scope === 'local'
        ? `Passages dans la zone visible — échelle adaptée au pic local — ligne jaune : ${activityAverageText}.`
        : `Passages sur l'ensemble du domaine couvert — ligne jaune : ${activityAverageText}.`;
    document.getElementById('activity-title').textContent =
      activityMetric === 'frp' ? 'Puissance radiative détectée' : 'Nombre de foyers détectés';
    activityLarge.setAttribute('aria-label',
      `${renderedActivity.length} passages satellite — ${activityEl.getAttribute('aria-label')} — ligne de ${activityAverageText}`);

    if (!renderedActivity.length) {
      activityLarge.innerHTML = '<span id="activity-empty">Aucun foyer détecté dans cette zone.</span>';
      renderedActivityAverages = [];
      activityDetail.replaceChildren();
      return;
    }
    const panelPeak = Math.max(...renderedActivity.map(value), 1);
    const scale = activityScale(panelPeak, activityMetric);
    renderedActivityAverages = movingAverage(renderedActivity);
    const averagePath = renderedActivityAverages.map((point, index) => {
      const x = ((point.ts - activityT0) / activitySpan * 100).toFixed(3);
      const y = (100 - 100 * point.value / scale.max).toFixed(3);
      return `${index ? 'L' : 'M'} ${x} ${y}`;
    }).join(' ');
    const averageLine = renderedActivityAverages.length > 1
      ? `<svg id="activity-average" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">`
        + `<path class="halo" d="${averagePath}"></path><path class="line" d="${averagePath}"></path></svg>`
      : '';
    const bars = renderedActivity.map((step, index) => {
      const left = ((step.ts - activityT0) / activitySpan * 100).toFixed(3);
      const activity = value(step);
      const height = (100 * activity / scale.max).toFixed(2);
      const opacity = (.28 + .36 * activity / panelPeak).toFixed(2);
      return `<b data-i="${index}" title="${label(step)}" `
        + `style="left:${left}%;height:${height}%;min-height:${activity ? 3 : 0}px;opacity:${opacity}"></b>`;
    }).join('');
    const grid = scale.ticks.map(tick =>
      `<i class="activity-gridline" style="bottom:${(100 * tick / scale.max).toFixed(2)}%"></i>`
    ).join('');
    const axis = scale.ticks.map((tick, index) => {
      const top = 100 - 100 * tick / scale.max;
      const edge = index === 0 ? ' last' : index === scale.ticks.length - 1 ? ' first' : '';
      return `<span class="activity-y-tick${edge}" style="top:${top.toFixed(2)}%">`
        + `${activityTickLabel(tick, activityMetric)}</span>`;
    }).join('');
    activityLarge.innerHTML = `<div class="activity-y-axis" aria-hidden="true">${axis}</div>`
      + `<div class="activity-plot">${grid}${bars}${averageLine}</div>`;
    const fallback = renderedActivity.reduce(
      (best, step, index) => value(step) > value(renderedActivity[best]) ? index : best, 0);
    showActivityDetail(Number.isInteger(selected) ? selected : fallback);
  }

  function drawActivity() {
    const steps = getSteps();
    if (!steps.length) return;
    const t0 = steps[0].ts, span = steps[steps.length - 1].ts - t0 || 1;
    const passages = activityPassages();
    // Échelle nationale fixe : zoomer ne transforme pas artificiellement un
    // petit passage local en pic maximal.
    const peak = Math.max(...steps.filter(s => s.kind === 'sat').map(value), 1);
    const local = !activityIsNational();
    const scope = local ? 'dans la zone visible' : "sur l'ensemble du domaine couvert";
    const metric = activityMetric === 'frp' ? 'puissance radiative' : 'nombre de foyers';
    renderedActivity = passages;
    activityPeak = peak;
    activityT0 = t0;
    activitySpan = span;
    activityEl.dataset.scope = local ? 'local' : 'national';
    activityEl.setAttribute('aria-label',
      `Ouvrir le graphique de ${metric} ${scope}`);
    activityEl.innerHTML = passages.map((step, index) => {
      const left = ((step.ts - t0) / span * 100).toFixed(3);
      const activity = value(step);
      const height = activity ? (2 + 20 * activity / peak).toFixed(1) : 0;
      const opacity = (.42 + .5 * activity / peak).toFixed(2);
      return `<b data-i="${index}" `
        + `style="left:${left}%;height:${height}px;min-height:${activity ? 2 : 0}px;opacity:${opacity}"></b>`;
    }).join('');
    drawLargeActivity();
  }

  function installChartListeners() {
    if (!mobile) {
      activityEl.addEventListener('pointermove', event => {
        const bar = event.target.closest('b[data-i]');
        if (!bar) { activityTip.classList.remove('open'); return; }
        const step = renderedActivity[+bar.dataset.i];
        if (!step) return;
        activityTip.innerHTML = `<strong>${primaryActivityLabel(step)}</strong>`
          + `<span>${fmt(step.ts)} — ${step.label}<br>${secondaryActivityLabel(step)}</span>`;
        activityTip.classList.add('open');
        const r = activityTip.getBoundingClientRect();
        activityTip.style.left = `${Math.min(event.clientX + 12, innerWidth - r.width - 8)}px`;
        activityTip.style.top = `${Math.max(event.clientY - r.height - 10, 8)}px`;
      });
      activityEl.addEventListener('pointerleave', () => activityTip.classList.remove('open'));
    }
    activityEl.addEventListener('click', event => {
      const bar = event.target.closest('b[data-i]');
      setOpen(true, bar ? +bar.dataset.i : null);
    });
    activityEl.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        setOpen(true);
      }
    });
    activityLarge.addEventListener('pointermove', event => {
      const bar = event.target.closest('b[data-i]');
      if (bar && event.pointerType !== 'touch') showActivityDetail(+bar.dataset.i);
    });
    activityLarge.addEventListener('click', event => {
      const bar = event.target.closest('b[data-i]');
      if (bar) showActivityDetail(+bar.dataset.i);
    });
  }

  function installMetricListeners() {
    for (const input of activityMetricInputs) input.addEventListener('change', event => {
      if (!event.target.checked) return;
      setActivityMetric(event.target.value);
    });
    for (const tab of activityMetricTabs) tab.addEventListener('click', event => {
      setActivityMetric(event.currentTarget.dataset.activityMetric);
    });
  }

  function configureMetrics() {
    const satelliteSteps = getSteps().filter(step => step.kind === 'sat');
    const hasNationalFrp = satelliteSteps.length
      && satelliteSteps.every(step => Number.isFinite(step.frp));
    powerMetricInput.disabled = !hasNationalFrp;
    if (!hasNationalFrp) {
      powerMetricInput.closest('label').title =
        'La puissance sera disponible après la prochaine actualisation des données.';
      activityMetric = 'count';
      activityMetricInputs.find(input => input.value === 'count').checked = true;
    }
  }

  syncActivityMetricControls();

  return Object.freeze({
    configureMetrics,
    countLabel,
    draw: drawActivity,
    drawLarge: drawLargeActivity,
    getMetric: () => activityMetric,
    installChartListeners,
    installMetricListeners,
    label,
    movingAverage,
    powerLabel,
    scale: (peak, metric = activityMetric, intervals = 4) =>
      activityScale(peak, metric, intervals),
    setMetric: setActivityMetric,
    tickLabel: (tick, metric = activityMetric) => activityTickLabel(tick, metric),
    value,
  });
}
