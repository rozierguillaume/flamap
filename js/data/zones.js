import { json } from './client.js';
import { zoneId } from '../util/geo.js';


export function visibleZoneIds(manifest, available, zoom, bounds) {
  if (!manifest || zoom < manifest.detail_zoom) return [];
  const box = manifest.bbox;
  const west = Math.max(bounds.getWest(), box[0]);
  const east = Math.min(bounds.getEast(), box[2]);
  const south = Math.max(bounds.getSouth(), box[1]);
  const north = Math.min(bounds.getNorth(), box[3]);
  if (east <= west || north <= south) return [];
  const ids = [];
  for (let y = Math.floor(south); y <= Math.floor(north - 1e-9); y++)
    for (let x = Math.floor(west); x <= Math.floor(east - 1e-9); x++) {
      const id = zoneId(x, y);
      if (available.has(id)) ids.push(id);
    }
  return ids;
}

export function mergedZones(zones, key, dedupe) {
  const features = [], seen = new Set();
  for (const zone of zones) for (const feature of zone[key].features) {
    const id = feature.properties && feature.properties._id;
    if (dedupe && id) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    features.push(feature);
  }
  return { type: 'FeatureCollection', features };
}

/* Cellules detaillees. Le cache applicatif reste borne ; le cache HTTP garde
 * les octets des cellules visitees sans laisser leurs gros objets JS en vie. */
export function createZonesController({
  loadJson = json,
  getViewport,
  hasDetailSource,
  setLoading,
  clearDetail,
  applyDetail,
  afterDetail,
  warn = (...args) => console.warn(...args),
  cacheLimit = 20,
} = {}) {
  const Z = {
    manifest: null, available: new Set(), cache: new Map(), visible: new Set(),
    hotspots: [], token: 0, disabled: false,
  };

  function configure(manifest) {
    Z.manifest = manifest;
    Z.available = new Set(manifest.zones);
    Z.disabled = !!manifest.legacy;
  }

  function loadZone(id) {
    if (Z.cache.has(id)) {
      const hit = Z.cache.get(id);
      Z.cache.delete(id); Z.cache.set(id, hit);
      return hit;
    }
    const url = Z.manifest.zone_template.replace('{id}', id);
    const promise = loadJson(url).catch(error => {
      Z.cache.delete(id);
      throw error;
    });
    Z.cache.set(id, promise);
    return promise;
  }

  async function loadVisibleZones() {
    if (Z.disabled || !hasDetailSource()) return;
    const { zoom, bounds } = getViewport();
    const ids = visibleZoneIds(Z.manifest, Z.available, zoom, bounds);
    const token = ++Z.token;
    Z.visible = new Set(ids);
    if (!ids.length) {
      setLoading(false);
      Z.hotspots = [];
      clearDetail('empty');
      return;
    }

    setLoading(true);
    try {
      const zones = await Promise.all(ids.map(loadZone));
      if (token !== Z.token) return;
      const hotspots = mergedZones(zones, 'hotspots', false);
      Z.hotspots = hotspots.features;
      applyDetail({
        zones,
        hotspots,
        merge: (key, dedupe) => mergedZones(zones, key, dedupe),
      });
    } catch (error) {
      warn('Détail indisponible', error);
      if (token === Z.token) {
        Z.hotspots = [];
        clearDetail('error');
      }
    } finally {
      if (token === Z.token) {
        setLoading(false);
        afterDetail();
      }
    }

    while (Z.cache.size > cacheLimit) {
      const oldest = [...Z.cache.keys()].find(id => !Z.visible.has(id));
      if (!oldest) break;
      Z.cache.delete(oldest);
    }
  }

  return {
    configure,
    getManifest: () => Z.manifest,
    getHotspots: () => Z.hotspots,
    isDisabled: () => Z.disabled,
    loadVisibleZones,
  };
}
