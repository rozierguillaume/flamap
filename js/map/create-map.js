import { createBaseStyle } from './base-style.js';

export function createMap({ maplibregl, mobile, container = 'map', hash = 'map' }) {
  const map = new maplibregl.Map({
    container,
    attributionControl: false,
    hash,
    center: [2.2, 46.5], zoom: 5,
    style: createBaseStyle(),
  });
  if (!mobile)
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.touchZoomRotate.disableRotation();
  return map;
}
