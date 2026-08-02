import { createBaseStyle } from './base-style.js';

export function createMap({ maplibregl, mobile }) {
  const map = new maplibregl.Map({
    container: 'map',
    attributionControl: false,
    hash: 'map',
    center: [2.2, 46.5], zoom: 5,
    style: createBaseStyle(),
  });
  if (!mobile)
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.touchZoomRotate.disableRotation();
  return map;
}
