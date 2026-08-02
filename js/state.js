const DEFAULT_HOTSPOTS = Object.freeze({
  'VIIRS/NOAA-20': true,
  'VIIRS/NOAA-21': true,
  'VIIRS/S-NPP': true,
  MODIS: true,
});

const DEFAULT_LAYER_VISIBILITY = Object.freeze({
  dated: true,
  nrt: true,
  psfdf: true,
  hotspots: DEFAULT_HOTSPOTS,
});

const listeners = new Set();

let state = Object.freeze({
  currentTime: 0,
  lastObservedTime: 0,
  atLatest: true,
  steps: Object.freeze([]),
  layerVisibility: DEFAULT_LAYER_VISIBILITY,
});

function publish(next) {
  const previous = state;
  state = Object.freeze(next);
  for (const listener of [...listeners]) listener(state, previous);
}

export function getState() {
  return state;
}

export function setCurrentTime(timestamp) {
  if (!Number.isFinite(timestamp)) throw new TypeError('timestamp courant invalide');
  if (timestamp === state.currentTime) return;
  publish({
    ...state,
    currentTime: timestamp,
    atLatest: !state.steps.length || timestamp >= state.lastObservedTime,
  });
}

export function setTimeline(steps, lastObservedIndex = steps.length - 1) {
  if (state.steps.length) throw new Error('frise déjà initialisée');
  if (!Array.isArray(steps) || !steps.length) throw new TypeError('frise vide ou invalide');
  if (!Number.isInteger(lastObservedIndex)
      || lastObservedIndex < 0 || lastObservedIndex >= steps.length)
    throw new RangeError('dernier cran observé invalide');

  const frozenSteps = Object.freeze(steps.map(step => Object.freeze({ ...step })));
  const lastObservedTime = frozenSteps[lastObservedIndex].ts;
  publish({
    ...state,
    steps: frozenSteps,
    lastObservedTime,
    atLatest: state.currentTime >= lastObservedTime,
  });
}

export function setLayerVisibility(layer, visible) {
  const enabled = !!visible;
  if (Object.hasOwn(state.layerVisibility, layer) && layer !== 'hotspots') {
    if (state.layerVisibility[layer] === enabled) return;
    publish({
      ...state,
      layerVisibility: Object.freeze({
        ...state.layerVisibility,
        [layer]: enabled,
      }),
    });
    return;
  }
  if (!Object.hasOwn(state.layerVisibility.hotspots, layer))
    throw new RangeError(`couche inconnue : ${layer}`);
  if (state.layerVisibility.hotspots[layer] === enabled) return;
  publish({
    ...state,
    layerVisibility: Object.freeze({
      ...state.layerVisibility,
      hotspots: Object.freeze({
        ...state.layerVisibility.hotspots,
        [layer]: enabled,
      }),
    }),
  });
}

export function subscribe(listener) {
  if (typeof listener !== 'function') throw new TypeError('abonné invalide');
  listeners.add(listener);
  return () => listeners.delete(listener);
}
