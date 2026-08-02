export function createPopupRouter({
  map,
  mobile,
  layers,
  isPointLayer,
  isAlwaysVisible,
  getAtLatest,
  getShownTime,
  maxAge,
  onGround,
  onFeature,
}) {
  function target(event) {
    const atLatest = getAtLatest();
    const activeLayers = layers.filter(id => map.getLayer(id));
    if (!activeLayers.length) return null;
    // Un foyer fait quelques pixels de rayon : au doigt, un point exact ne
    // l'atteint presque jamais. La tolérance ne vaut que pour les symboles et
    // les disques — un polygone, on est dedans ou on ne l'est pas.
    const pad = mobile ? 13 : 8;
    const box = [[event.point.x - pad, event.point.y - pad],
                 [event.point.x + pad, event.point.y + pad]];
    const near = map.queryRenderedFeatures(box, { layers: activeLayers });
    const under = map.queryRenderedFeatures(event.point, { layers: activeLayers });
    const now = getShownTime();
    // Hors de la fenêtre d'ancienneté, un foyer est peint à opacité nulle mais
    // reste « rendu » pour MapLibre : sans ce test, on ouvrirait la fiche d'un
    // point invisible.
    const visible = feature => {
      const ts = Number(feature.properties.ts);
      return !Number.isFinite(ts) || (ts <= now && now - ts <= maxAge);
    };
    for (const id of activeLayers) {
      const point = isPointLayer(id);
      // Même chose pour les surfaces brûlées : au passé, leur opacité est nulle.
      if (!point && !atLatest) continue;
      const found = (point ? near : under)
        .filter(feature => feature.layer.id === id)
        .find(feature => isAlwaysVisible(id) || visible(feature));
      if (found) return { id, feature: found };
    }
    return null;
  }

  function click(event) {
    const hit = target(event);
    if (!hit) return onGround(event);
    return onFeature(hit, event);
  }

  return Object.freeze({ click, target });
}
