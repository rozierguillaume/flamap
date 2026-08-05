import { EMPTY, json } from './client.js';


/* Champs de vent des autres régions, annoncés par le manifeste. Le premier est
 * déjà chargé avec l'aperçu : c'est celui de référence, qui porte aussi la
 * température de repli. Un champ manquant se perd sans bruit — la nappe
 * s'arrête simplement sur cette région, comme partout où le modèle ne couvre
 * pas. */
export function loadRegionalWind(manifest, loadJson = json) {
  const fields = (manifest && manifest.wind_fields) || [];
  return Promise.all(fields.slice(1).map(
    field => loadJson(`data/${field.file}`).catch(() => null)
  ));
}


// Les donnees nationales partent tout de suite, sans attendre MapLibre.
export function loadInitialData(buildSteps, loadJson = json) {
  return Promise.all([
    loadJson('data/manifest.json'),
    loadJson('data/overview_hotspots.geojson'),
    loadJson('data/burnt_recent.geojson'),
    loadJson('data/psfdf_fires.geojson').catch(() => EMPTY),
    loadJson('data/timeline.json'),
    loadJson('data/wind_coarse.json?v=2'),
  ]).then(([manifest, overview, recent, psfdf, timeline, wind]) => ({
    manifest, overview, recent, psfdf, timeline, wind, detail: null,
  })).catch(async () => {
    // Le clone conserve les anciens exemples Gironde : il reste affichable avant
    // le premier `python3 fetch_fires.py`, sans simuler le chargement national.
    const [nrt, dated, hotspots, meta, wind] = await Promise.all([
      loadJson('data/burnt_nrt.geojson'), loadJson('data/burnt_dated.geojson'),
      loadJson('data/hotspots.geojson'), loadJson('data/meta.json'),
      loadJson('data/wind.json').catch(() => null),
    ]);
    return {
      manifest: {
        bbox: meta.bbox, generated_at: meta.generated_at, detail_zoom: 99,
        zones: [], zone_template: '', legacy: true,
      },
      overview: EMPTY, recent: EMPTY, psfdf: EMPTY,
      timeline: buildSteps(hotspots, dated),
      wind, detail: { nrt, dated, hotspots },
    };
  });
}
