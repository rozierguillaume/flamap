export function burntPaintAt(ts, lastObservedTime) {
  const k = ts >= lastObservedTime ? 1 : 0;
  return {
    fill: .70 * k,
    nrtFill: .30 * k,
    line: .95 * k,
    nrtLine: .55 * k,
  };
}

export function createBurntController({ map, getState, value }) {
  function install(manifest) {
    // surfaces brûlées datées : la « terre brûlée » de référence
    const FADE = { duration: 450, delay: 0 };
    // NRT est une emprise de travail, sans date ni surface : voile discret sous
    // le périmètre daté, assez visible pour le distinguer de l'imagerie mais sans
    // suggérer le même niveau de confirmation.
    map.addLayer({ id: 'nrt-fill', type: 'fill', source: 'nrt',
      minzoom: manifest.legacy ? 0 : manifest.detail_zoom,
      paint: { 'fill-color': value('--nrt'), 'fill-opacity': .30,
               'fill-opacity-transition': FADE } });
    map.addLayer({ id: 'recent-fill', type: 'fill', source: 'recent',
      maxzoom: manifest.detail_zoom,
      paint: { 'fill-color': value('--burnt'), 'fill-opacity': .70, 'fill-opacity-transition': FADE } });
    map.addLayer({ id: 'recent-line', type: 'line', source: 'recent',
      maxzoom: manifest.detail_zoom,
      paint: { 'line-color': value('--burnt-edge'), 'line-width': 1.2,
               'line-opacity': .95, 'line-opacity-transition': FADE } });
    map.addLayer({ id: 'burnt-fill', type: 'fill', source: 'dated',
      minzoom: manifest.legacy ? 0 : manifest.detail_zoom,
      paint: { 'fill-color': value('--burnt'), 'fill-opacity': .70, 'fill-opacity-transition': FADE } });
    map.addLayer({ id: 'burnt-line', type: 'line', source: 'dated',
      minzoom: manifest.legacy ? 0 : manifest.detail_zoom,
      paint: { 'line-color': value('--burnt-edge'), 'line-width': 1.2,
               'line-opacity': .95, 'line-opacity-transition': FADE } });

    // Le contour NRT garde une lecture distincte, mais son absence de date et la
    // présence possible d'anciennes cicatrices interdisent de le dater.
    map.addLayer({ id: 'nrt-line', type: 'line', source: 'nrt',
      minzoom: manifest.legacy ? 0 : manifest.detail_zoom,
      paint: { 'line-color': value('--nrt-edge'), 'line-width': 1,
               'line-opacity': .55, 'line-opacity-transition': FADE } });
  }

  function paint(target, atLatest) {
    const opacity = burntPaintAt(atLatest ? 1 : 0, 1);
    for (const id of ['recent-fill', 'burnt-fill'])
      if (target.getLayer(id)) target.setPaintProperty(id, 'fill-opacity', opacity.fill);
    if (target.getLayer('nrt-fill'))
      target.setPaintProperty('nrt-fill', 'fill-opacity', opacity.nrtFill);
    for (const id of ['recent-line', 'burnt-line'])
      if (target.getLayer(id)) target.setPaintProperty(id, 'line-opacity', opacity.line);
    if (target.getLayer('nrt-line'))
      target.setPaintProperty('nrt-line', 'line-opacity', opacity.nrtLine);
  }

  /* La case à cocher coupe la couche net ; le passage au passé, lui, se fait en
   * fondu (transitions déclarées à la création des couches). Deux leviers
   * différents pour deux gestes différents : décocher, c'est éteindre, alors que
   * remonter la frise, c'est glisser. */
  function apply() {
    const { atLatest, layerVisibility } = getState();
    const vis = k => layerVisibility[k] ? 'visible' : 'none';
    for (const id of ['recent-fill', 'recent-line', 'burnt-fill', 'burnt-line'])
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis('dated'));
    for (const id of ['nrt-fill', 'nrt-line'])
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis('nrt'));
    paint(map, atLatest);
  }

  return { apply, install, paint };
}
