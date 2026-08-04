// Store minimal propre à un feu ouvert dans la page archive : une instance
// par sélection, pas de singleton (contrairement à js/state.js, dont
// `setTimeline` lève une erreur au deuxième appel — inadapté à une page où
// l'on passe d'un feu à l'autre sans recharger).
export function createFireState() {
  let state = { currentTime: 0, lastObservedTime: 0, atLatest: true, steps: [] };

  return {
    getState: () => state,
    setTimeline(steps) {
      const lastObservedTime = steps[steps.length - 1].ts;
      state = { ...state, steps, lastObservedTime, currentTime: lastObservedTime, atLatest: true };
    },
    setCurrentTime(ts) {
      state = { ...state, currentTime: ts, atLatest: ts >= state.lastObservedTime };
    },
  };
}
