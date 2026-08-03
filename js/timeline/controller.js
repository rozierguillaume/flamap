import { buildWarp, ease, unease, warpProgress, warpTime } from './model.js';


export function createTimelineController({
  mobile,
  slider,
  playBtn,
  playMs,
  trackUsage,
  getSteps,
  getCurrentTime,
  setCurrentTime,
  show,
  smokeTime,
  smokeLoop,
}) {
  let playing = null;
  let warp = null;

  function configure() {
    const steps = getSteps();
    // Le pas d'une seconde garde atteignables les publications EFFIS, dont
    // LASTUPDATE n'est pas nécessairement aligné sur une minute.
    slider.min = steps[0].ts;
    slider.max = steps[steps.length - 1].ts;
    slider.step = 1;
    warp = buildWarp(steps);
  }

  /* Le curseur porte maintenant un instant, pas un numéro de cran : il se déplace
   * proportionnellement au temps, donc il passe exactement sur les marques de la
   * frise — ce qui n'était pas le cas avec une valeur indicielle et des marques
   * placées à la date. */
  function setTime(ts, fromSlider) {
    const steps = getSteps();
    const currentTime = Math.min(Math.max(ts, steps[0].ts), steps[steps.length - 1].ts);
    setCurrentTime(currentTime);
    if (!fromSlider) slider.value = currentTime;
    show(currentTime);
  }

  function installSliderListener() {
    slider.addEventListener('input', () => {
      const steps = getSteps();
      if (!steps.length) return;
      stop();                           // prendre la main sur la frise met en pause
      setTime(+slider.value, true);
      smokeTime(getCurrentTime(), true, true);
    });
  }

  function stop() {
    if (!playing) return;
    cancelAnimationFrame(playing.raf);
    playing = null;
    playBtn.textContent = '▶';
    playBtn.setAttribute('aria-label', "Lancer l'animation");
    smokeLoop();
  }

  /* Chaque frame réécrit trois expressions de peinture, que MapLibre réévalue sur
   * les quelques milliers de foyers chargés. C'est tenable — 2 à 3 ms par frame
   * sur un portable — mais inutile de le faire 120 fois par seconde sur un écran
   * qui rafraîchit à 120 Hz : la nappe de vent, elle, a besoin de ces frames. */
  const PAINT_MS = mobile ? 1000 / 30 : 1000 / 50;

  function playFrame(now) {
    if (!playing) return;
    const steps = getSteps();
    const p = Math.min((now - playing.start) / playMs, 1);
    if (p >= 1) { setTime(steps[steps.length - 1].ts); stop(); return; }
    if (now - playing.paint >= PAINT_MS) {
      playing.paint = now;
      setTime(warpTime(warp, ease(p)));
    }
    playing.raf = requestAnimationFrame(playFrame);
  }

  function installPlayListener() {
    playBtn.addEventListener('click', () => {
      if (playing) {
        trackUsage('timeline-pause');
        stop();
        return;
      }
      const steps = getSteps();
      if (!steps.length) return;
      trackUsage('timeline-play');

      // une lecture terminée — ou lâchée tout au bout — repart du début ; ailleurs
      // on reprend là où le curseur a été laissé, sans le renvoyer à gauche
      let p = unease(warpProgress(warp, getCurrentTime()));
      if (p > .995) p = 0;

      playBtn.textContent = '❚❚';
      playBtn.setAttribute('aria-label', "Suspendre l'animation");
      // le premier instant s'affiche tout de suite, la boucle ne fait que continuer
      setTime(warpTime(warp, ease(p)));
      playing = { start: performance.now() - p * playMs, paint: 0, raf: 0 };
      playing.raf = requestAnimationFrame(playFrame);
      smokeLoop();
    });
  }

  return Object.freeze({
    configure,
    getPlayDuration: () => playMs,
    getTime: getCurrentTime,
    installPlayListener,
    installSliderListener,
    isConfigured: () => !!warp?.C,
    isPlaying: () => !!playing,
    progressAtTime: ts => unease(warpProgress(warp, ts)),
    setTime,
    stop,
    timeAtProgress: progress => warpTime(warp, ease(progress)),
  });
}
