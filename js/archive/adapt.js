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
