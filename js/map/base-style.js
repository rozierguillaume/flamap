// OpenMapTiles expose les traductions sous la forme `name_fr`. Le nom local
// reste le meilleur repli lorsqu'une traduction française n'existe pas.
const LABEL_FR = ['coalesce', ['get', 'name_fr'], ['get', 'name'], ['get', 'name_en']];
const LABEL_PAINT = {
  'text-color': '#dce1e5',
  'text-halo-color': 'rgba(10,12,15,.88)',
  'text-halo-width': 1.5,
  'text-halo-blur': .4,
};

export function createBaseStyle() {
  return {
    version: 8,
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {
      // Base mondiale : mosaïque Sentinel-2 sans nuages (10 m), libre et sans clé.
      sat: {
        type: 'raster', tileSize: 256, maxzoom: 15,
        tiles: ['https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg'],
      },
      // Par-dessus, l'ortho-photo IGN : jusqu'à 20 cm, bien plus nette, mais
      // couverture France seulement — ailleurs le service répond 404 et
      // MapLibre laisse simplement voir la couche Sentinel-2 en dessous.
      ortho: {
        type: 'raster', tileSize: 256, maxzoom: 19,
        tiles: ['https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0'
              + '&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&TILEMATRIXSET=PM'
              + '&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=image/jpeg'],
      },
      // Libellés vectoriels : contrairement aux anciennes tuiles raster CARTO,
      // leur langue peut être choisie côté client.
      toponyms: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' },
    },
    layers: [
      { id: 'sat', type: 'raster', source: 'sat' },
      { id: 'ortho', type: 'raster', source: 'ortho' },
      { id: 'label-water-point', type: 'symbol', source: 'toponyms', 'source-layer': 'water_name',
        filter: ['match', ['geometry-type'], ['Point', 'MultiPoint'], true, false],
        layout: {
          'text-field': LABEL_FR, 'text-font': ['Noto Sans Italic'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 4, 10, 10, 14],
          'text-letter-spacing': .12, 'text-max-width': 7,
        },
        paint: { ...LABEL_PAINT, 'text-color': '#b9d8ef' } },
      { id: 'label-water-line', type: 'symbol', source: 'toponyms', 'source-layer': 'water_name',
        filter: ['match', ['geometry-type'], ['LineString', 'MultiLineString'], true, false],
        layout: {
          'symbol-placement': 'line', 'symbol-spacing': 350,
          'text-field': LABEL_FR, 'text-font': ['Noto Sans Italic'],
          'text-size': 13, 'text-letter-spacing': .12,
        },
        paint: { ...LABEL_PAINT, 'text-color': '#b9d8ef' } },
      { id: 'label-country', type: 'symbol', source: 'toponyms', 'source-layer': 'place',
        minzoom: 2, maxzoom: 8, filter: ['==', ['get', 'class'], 'country'],
        layout: {
          'text-field': LABEL_FR, 'text-font': ['Noto Sans Bold'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 2, 10, 6, 17],
          'text-letter-spacing': .12, 'text-transform': 'uppercase', 'text-max-width': 7,
        },
        paint: LABEL_PAINT },
      { id: 'label-state', type: 'symbol', source: 'toponyms', 'source-layer': 'place',
        minzoom: 4, maxzoom: 9, filter: ['==', ['get', 'class'], 'state'],
        layout: {
          'text-field': LABEL_FR, 'text-font': ['Noto Sans Italic'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 4, 9, 8, 14],
          'text-letter-spacing': .16, 'text-transform': 'uppercase', 'text-max-width': 9,
        },
        paint: { ...LABEL_PAINT, 'text-color': '#b9c0c6' } },
      { id: 'label-city', type: 'symbol', source: 'toponyms', 'source-layer': 'place',
        minzoom: 3, filter: ['==', ['get', 'class'], 'city'],
        layout: {
          'text-field': LABEL_FR, 'text-font': ['Noto Sans Bold'],
          'text-size': ['interpolate', ['exponential', 1.2], ['zoom'], 4, 11, 8, 16, 12, 20],
          'text-max-width': 8,
        },
        paint: LABEL_PAINT },
      { id: 'label-town', type: 'symbol', source: 'toponyms', 'source-layer': 'place',
        minzoom: 6, filter: ['==', ['get', 'class'], 'town'],
        layout: {
          'text-field': LABEL_FR, 'text-font': ['Noto Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 6, 10, 11, 14],
          'text-max-width': 8,
        },
        paint: LABEL_PAINT },
      { id: 'label-village', type: 'symbol', source: 'toponyms', 'source-layer': 'place',
        minzoom: 9, filter: ['==', ['get', 'class'], 'village'],
        layout: {
          'text-field': LABEL_FR, 'text-font': ['Noto Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 9, 10, 13, 13],
          'text-max-width': 8,
        },
        paint: LABEL_PAINT },
      { id: 'label-local', type: 'symbol', source: 'toponyms', 'source-layer': 'place',
        minzoom: 10,
        filter: ['match', ['get', 'class'],
          ['suburb', 'quarter', 'neighbourhood', 'hamlet', 'isolated_dwelling'], true, false],
        layout: {
          'text-field': LABEL_FR, 'text-font': ['Noto Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 10, 9, 15, 12],
          'text-max-width': 8,
        },
        paint: { ...LABEL_PAINT, 'text-color': '#c3c9ce' } },
      { id: 'label-road', type: 'symbol', source: 'toponyms',
        'source-layer': 'transportation_name', minzoom: 12,
        filter: ['match', ['geometry-type'], ['LineString', 'MultiLineString'], true, false],
        layout: {
          'symbol-placement': 'line', 'symbol-spacing': 300,
          'text-field': LABEL_FR, 'text-font': ['Noto Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 12, 10, 16, 13],
          'text-rotation-alignment': 'map',
        },
        paint: { ...LABEL_PAINT, 'text-color': '#c9ced2', 'text-halo-width': 1.2 } },
    ],
  };
}
