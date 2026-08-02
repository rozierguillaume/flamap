const H = 3600, DAY = 86400;

export const MAX_AGE = 10 * DAY;
export const FIRMS_SOURCES = ['VIIRS/NOAA-20', 'VIIRS/NOAA-21', 'VIIRS/S-NPP', 'MODIS'];

/*
 * Anciennete d'un foyer : une echelle continue, du jaune clair de la detection
 * fraiche au brun-rouge des braises de plusieurs jours.
 *
 * Ce fut d'abord quatre paliers francs — d'ou les variables --front / --hot /
 * --recent / --old, qui restent les ancres de la rampe et servent toujours
 * ailleurs dans l'interface. Le probleme d'un palier, c'est qu'a l'animation il
 * fait basculer toute une rafale d'une couleur a l'autre en une frame.
 *
 * Les crans ne sont volontairement pas regulierement espaces : tout se joue
 * dans les premieres heures, ou le feu court, et les trois derniers jours ne
 * sont qu'une longue extinction. On tient donc quatre crans dans les six
 * premieres heures, puis la rampe s'assombrit lentement jusqu'au dixieme jour.
 */
export function createAgeRamps({ mobile, front, hot, recent, old }) {
  const AGE_COLOR = [
    [      0, '#fff3b8'],   // detection de l'instant, presque blanche
    [  1 * H, front],
    [  3 * H, '#ffab2e'],
    [  6 * H, hot],
    [ 12 * H, '#ec481d'],
    [ 24 * H, recent],
    [ 48 * H, '#8f3623'],
    [ 72 * H, old],
    [  5 * DAY, '#4f2a1f'],
    [  7 * DAY, '#352019'],
    [MAX_AGE, '#211714'],   // brun presque noir pour les traces les plus anciennes
  ];

  // rayon de reference a z12, et opacite : memes bornes, moins de crans — l'oeil
  // ne lit pas une taille au dixieme de pixel
  const AGE_SIZE = [
    [0, mobile ? 4.0 : 4.4], [6 * H, mobile ? 3.5 : 3.9],
    [24 * H, mobile ? 3.0 : 3.3], [72 * H, mobile ? 2.5 : 2.7],
    [5 * DAY, mobile ? 2.1 : 2.2], [MAX_AGE, mobile ? 1.6 : 1.7],
  ];
  const AGE_OPACITY = [
    [0, 1], [6 * H, .95], [24 * H, .82], [72 * H, .6],
    [5 * DAY, .45], [7 * DAY, .34], [MAX_AGE, .16],
    [MAX_AGE + 1, 0],   // visible au dixieme jour, eteint juste au-dela
  ];
  return { AGE_COLOR, AGE_SIZE, AGE_OPACITY };
}

// interpolation lineaire dans une table [[age, valeur], …]
export function rampAt(tbl, a) {
  if (a <= tbl[0][0]) return tbl[0][1];
  for (let i = 1; i < tbl.length; i++) {
    const [x1, v1] = tbl[i], [x0, v0] = tbl[i - 1];
    if (a <= x1) return v0 + (v1 - v0) * (a - x0) / (x1 - x0);
  }
  return tbl[tbl.length - 1][1];
}

// les crans strictement au-dela de `a`, aplatis pour `interpolate`
export const rampAfter = (tbl, a, k = 1) =>
  tbl.filter(([x]) => x > a).flatMap(([x, v]) => [x, v * k]);

export const agePos = a => (1 - Math.sqrt(a / MAX_AGE)) * 100;

/* Un pixel VIIRS couvre 375 m au sol : a z9 il vaut 2 px d'ecran, a z14 il en
 * vaut 60. Avec un rayon fixe, la carte dezoomee — le cadrage par defaut sur
 * telephone — devient une flaque de points colles. On fait donc grossir les
 * cercles avec le zoom, en gardant la rampe d'anciennete comme sortie. */
export const zoomScaleFor = mobile => mobile
  ? [[5, .28], [8, .50], [11, .85], [14, 1.35]]
  : [[5, .34], [8, .60], [11, .95], [14, 1.40]];

// La FRP ne remplace pas l'ancienneté : elle module seulement le rayon. La
// médiane observée tourne autour de 7 MW ; même les 1 % de pixels les plus
// puissants restent bornés à environ 1,5 fois le rayon normal.
const FRP_DETAIL_SIZE = ['case', ['has', 'frp'],
  ['interpolate', ['linear'], ['get', 'frp'],
    0, .84, 2, .91, 7, 1, 20, 1.08, 60, 1.18,
    150, 1.29, 400, 1.40, 1200, 1.50],
  1];
// L'aperçu porte déjà un facteur de taille lié au nombre de détections de la
// cellule. Sa FRP totale reçoit donc une modulation encore plus contenue.
const FRP_OVERVIEW_SIZE = ['case', ['has', 'frp'],
  ['interpolate', ['linear'], ['get', 'frp'],
    0, .90, 100, 1, 500, 1.08, 2000, 1.17, 10000, 1.28, 25000, 1.36],
  1];

export function createFiresController({ map, ramps, zoomScale, value }) {
  function install(manifest) {
    // Foyers : sort-key sur la date pour que les plus récents passent au-dessus.
    // Transitions à zéro, contrairement aux polygones : la douceur vient déjà de
    // l'expression d'âge, que `show()` réécrit à chaque frame — une transition
    // par-dessus ne ferait que traîner d'un tiers de seconde sur la précédente.
    const NOW = { duration: 0, delay: 0 };
    map.addLayer({ id: 'hotspots-overview', type: 'circle', source: 'overview-hs',
      maxzoom: manifest.detail_zoom,
      layout: { 'circle-sort-key': ['get', 'ts'] },
      paint: { 'circle-color': value('--front'), 'circle-radius': 4, 'circle-stroke-width': 0,
               'circle-color-transition': NOW, 'circle-radius-transition': NOW,
               'circle-opacity-transition': NOW } });
    map.addLayer({ id: 'hotspots', type: 'circle', source: 'hs',
      minzoom: manifest.legacy ? 0 : manifest.detail_zoom,
      layout: { 'circle-sort-key': ['get', 'ts'] },
      paint: { 'circle-color': value('--front'), 'circle-radius': 4, 'circle-stroke-width': 0,
               'circle-color-transition': NOW, 'circle-radius-transition': NOW,
               'circle-opacity-transition': NOW } });
  }

  function setTime(ts, lastObservedTime, appear, target = map, scale = 1) {
    // le feu ne se prolonge pas dans la prévision : au-delà du dernier passage
    // satellite il reste dans son dernier état observé, le vieillir jusqu'à demain
    // le ferait s'éteindre à l'écran alors qu'on n'en sait tout simplement rien
    const now = Math.min(ts, lastObservedTime);

    // Couleurs recalculées à partir de `now` : MapLibre garde les données en
    // mémoire GPU, on ne repousse jamais le GeoJSON.
    //
    // Il n'y a délibérément plus de `setFilter` : ce sont les bornes de la rampe
    // d'opacité qui masquent le futur et l'au-delà de MAX_AGE — `interpolate`
    // plafonne aux extrémités, donc tout ce qui sort de la fenêtre est à zéro.
    // Un filtre refait invalider les tuiles et repasser les foyers visibles au
    // parseur à chaque frame ; sur cette boucle, il doublait le coût.
    const age = ['-', now, ['get', 'ts']];
    const color = ['interpolate', ['linear'], age, ...ramps.AGE_COLOR.flat()];
    for (const id of ['hotspots-overview', 'hotspots'])
      if (target.getLayer(id)) target.setPaintProperty(id, 'circle-color', color);

    // MapLibre n'accepte 'zoom' qu'en entrée de l'expression la plus externe :
    // c'est donc l'interpolation de zoom qui enveloppe la rampe d'âge, et non
    // l'inverse — un facteur multiplicatif appliqué par-dessus serait refusé.
    //
    // Le début de la rampe est la naissance : le disque sort de rien, dépasse
    // légèrement sa taille de croisière puis s'y pose. Sans ce léger dépassement
    // la rafale s'installe mollement ; avec, elle claque comme une détection. La
    // valeur d'atterrissage est lue dans la rampe elle-même, pour que le raccord
    // se fasse sans marche quelle que soit la durée retenue.
    const land = rampAt(ramps.AGE_SIZE, appear);
    const radiiAt = k => ['interpolate', ['linear'], age,
      0, .25 * land * k * scale,
      appear * .45, 1.18 * land * k * scale,
      appear, land * k * scale,
      ...rampAfter(ramps.AGE_SIZE, appear, k * scale)];
    const detailRadius = ['interpolate', ['linear'], ['zoom'],
      ...zoomScale.flatMap(([z, k]) => [z, ['*', radiiAt(k), FRP_DETAIL_SIZE]])];
    if (target.getLayer('hotspots'))
      target.setPaintProperty('hotspots', 'circle-radius', detailRadius);
    if (target.getLayer('hotspots-overview')) {
      const countScale = ['interpolate', ['linear'], ['get', 'n'],
        1, 1, 10, 1.7, 100, 3.1, 1000, 5.2];
      target.setPaintProperty('hotspots-overview', 'circle-radius',
        ['interpolate', ['linear'], ['zoom'],
          ...zoomScale.flatMap(([z, k]) => [z,
            ['*', ['*', radiiAt(k), countScale], FRP_OVERVIEW_SIZE]])]);
    }
    // Les traces les plus anciennes restent encore légèrement visibles à dix
    // jours ; la collecte ne conserve rien au-delà de cette limite.
    const opacity = ['interpolate', ['linear'], age,
      0, 0, appear, rampAt(ramps.AGE_OPACITY, appear),
      ...rampAfter(ramps.AGE_OPACITY, appear)];
    for (const id of ['hotspots-overview', 'hotspots'])
      if (target.getLayer(id)) target.setPaintProperty(id, 'circle-opacity', opacity);
  }

  function setSources(enabled) {
    const filter = enabled.length === FIRMS_SOURCES.length ? null
      : ['in', ['get', 'source'], ['literal', enabled]];
    for (const id of ['hotspots-overview', 'hotspots'])
      if (map.getLayer(id)) map.setFilter(id, filter);
  }

  return { install, setSources, setTime };
}
