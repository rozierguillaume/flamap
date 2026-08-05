// Fonctions pures : convertissent la réponse de `GET /fires/{id}` (voir
// docs/refactor/FRONT_ARCHIVE_INCENDIES.md §4) au format GeoJSON déjà
// consommé par js/features/fires.js, js/features/burnt.js et
// js/timeline/model.js::buildSteps — aucune de ces briques n'est modifiée.

export function toHotspots(firms) {
  const features = (firms || []).map(f => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [f.lon, f.lat] },
    properties: {
      source: f.source, ts: f.ts, frp: f.frp, brightness: f.brightness,
      confidence: f.confidence, daynight: f.daynight, scan: f.scan, track: f.track,
    },
  })).sort((a, b) => a.properties.ts - b.properties.ts);
  return { type: 'FeatureCollection', features };
}

export function toBurnt(effis) {
  const features = (effis || []).map(e => ({
    type: 'Feature',
    geometry: e.geometry,
    properties: { ...e.props, AREA_HA: e.area_ha, ts: e.ts, lu: e.lu },
  }));
  return { type: 'FeatureCollection', features };
}

// `radius_km` n'est pas une géométrie précise (voir doc §6) : le cadrage doit
// rester généreux, d'où la marge de 15 % en plus de celle déjà appliquée côté
// serveur pour les feux rapprochés d'un périmètre EFFIS.
export function fitBoundsFor([lon, lat], radiusKm) {
  const marginKm = radiusKm * 1.15;
  const dLat = marginKm / 111;
  const dLon = marginKm / (111.32 * Math.cos(lat * Math.PI / 180));
  return [[lon - dLon, lat - dLat], [lon + dLon, lat + dLat]];
}

// Cadrage sur la géométrie réellement connue (foyers FIRMS + périmètres
// EFFIS), pour les gros feux où le cercle `center`/`radius_km` — indicatif,
// voir doc §6 — est plus petit que l'étendue réelle (ex. Saumos, 42 100 ha).
function walkCoords(coords, onPoint) {
  if (typeof coords[0] === 'number') { onPoint(coords); return; }
  for (const c of coords) walkCoords(c, onPoint);
}

export function bboxOfFeatures(...collections) {
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  for (const fc of collections) {
    for (const f of fc?.features || []) {
      if (!f.geometry) continue;
      walkCoords(f.geometry.coordinates, ([lon, lat]) => {
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      });
    }
  }
  if (!Number.isFinite(minLon)) return null;
  return [[minLon, minLat], [maxLon, maxLat]];
}

function padBounds([[minLon, minLat], [maxLon, maxLat]], marginRatio = .15) {
  const dLon = (maxLon - minLon) * marginRatio || .01;
  const dLat = (maxLat - minLat) * marginRatio || .01;
  return [[minLon - dLon, minLat - dLat], [maxLon + dLon, maxLat + dLat]];
}

function unionBounds(a, b) {
  if (!a) return b;
  if (!b) return a;
  return [
    [Math.min(a[0][0], b[0][0]), Math.min(a[0][1], b[0][1])],
    [Math.max(a[1][0], b[1][0]), Math.max(a[1][1], b[1][1])],
  ];
}

// Union du cercle indicatif et de la géométrie connue : ne rétrécit jamais le
// cadrage existant pour les petits feux, mais l'étend quand le périmètre
// EFFIS réel dépasse le cercle (le cas courant pour les grands feux).
export function fitBoundsForFire(summary, hotspots, burnt) {
  const circle = Array.isArray(summary.center)
    ? fitBoundsFor(summary.center, summary.radius_km || 15) : null;
  const geometry = bboxOfFeatures(burnt, hotspots);
  return unionBounds(circle, geometry ? padBounds(geometry) : null);
}
