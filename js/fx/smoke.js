const H = 3600;

/* =====================================================================
 * FUMEE — bouffées émises par les foyers puis advectées dans le champ de vent
 *
 * Contrairement aux traits du vent, une bouffée vit en longitude/latitude.
 * Elle réinterroge `windAt()` après chaque déplacement : si elle rencontre plus
 * loin un vent d'une autre direction, sa trajectoire se courbe réellement.
 *
 * Ce rendu reste une indication visuelle, pas un modèle de qualité de l'air :
 * ni relief, ni stabilité atmosphérique, ni hauteur d'injection ne sont connus.
 * La FRP (énergie radiative) et le nombre de pixels déterminent toutefois la
 * fréquence d'émission, puis chaque bouffée s'élargit et s'efface avec l'âge.
 * ===================================================================== */

// La lecture accélérée condense plusieurs heures d'émission en quelques
// secondes murales : le plafond doit laisser cette masse supplémentaire se
// former, tout en restant plus bas sur mobile.
export const SMOKE_N = mobile => mobile ? 900 : 2200;
export const SMOKE_H = 6 * H;                   // disparition physique du panache
export const SMOKE_WINDOW = 6 * H;              // zone jaune de la rampe d'anciennete
export const SMOKE_LIVE_K = 180;                // dernier instant : 3 min physiques/s
const SMOKE_LIVE_DENSITY = 2.2;                 // compense le peu de passages récents

// Latitude → y de Mercator. Hissée hors de la boucle de rendu, qui la
// reconstruisait à chaque frame pour la rappeler une fois par bouffée.
const merc = lat => Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));

export function createSmokeController({
  mobile,
  canvas,
  windAt,
  getWindProjection,
  getState,
  isPlaying,
} = {}) {
  const ctx = canvas.getContext('2d');
  const particleCount = SMOKE_N(mobile);
  const wind = {};
  const S = {
    on: true, overview: [], sources: [], emitters: [], total: 0,
    parts: [], target: 0, pick: 0, raf: null, last: 0, ts: 0,
    bucket: null, ready: false, pending: 0, emitCarry: 0,
    w: 0, h: 0, sprite: null,
  };

  function sprite() {
    const cv = document.createElement('canvas'), n = 96;
    cv.width = cv.height = n;
    const c = cv.getContext('2d');
    const g = c.createRadialGradient(n * .47, n * .47, 0, n / 2, n / 2, n / 2);
    g.addColorStop(0,   'rgba(226,222,214,.34)');
    g.addColorStop(.24, 'rgba(218,214,206,.25)');
    g.addColorStop(.58, 'rgba(202,200,195,.12)');
    g.addColorStop(1,   'rgba(194,194,192,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, n, n);
    return cv;
  }

  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, mobile ? 1.25 : 1.5);
    S.w = canvas.clientWidth; S.h = canvas.clientHeight;
    canvas.width = Math.round(S.w * dpr);
    canvas.height = Math.round(S.h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    S.sprite ||= sprite();
  }

  function pick() {
    // Une part de tirage uniforme garantit que toute la lisiere jaune émet. Le
    // reste est pondéré par FRP/nombre : les secteurs puissants sont plus denses,
    // sans aspirer toute la fumée vers un unique maximum.
    if (Math.random() < .58)
      return S.emitters[S.pick++ % S.emitters.length];
    let r = Math.random() * S.total;
    for (const emitter of S.emitters) {
      r -= emitter.weight;
      if (r <= 0) return emitter;
    }
    return S.emitters[S.emitters.length - 1];
  }

  /* Lecture du vent réutilisée d'un appel à l'autre : `advect()` est appelée une
   * fois par bouffée et par sous-pas, soit jusqu'à quelques dizaines de milliers
   * de fois par frame en lecture accélérée. La valeur ne sert jamais au-delà de
   * l'appel qui la remplit. */
  const sampled = { u: 0, v: 0, g: 0 };

  function advect(p, seconds) {
    const out = sampled;
    if (!windAt(p.lon, p.lat, out)) return false;
    // Diffusion turbulente lente. Deux particules parties du même front ne
    // parcourent ainsi jamais exactement la même ligne de courant : la nappe
    // s'ouvre latéralement et ne dessine plus de rails parallèles.
    const keep = Math.exp(-seconds / (28 * 60));
    const kick = Math.sqrt(1 - keep * keep) * (1.15 + Math.min(out.g / 80, .85));
    p.tu = p.tu * keep + (Math.random() * 2 - 1) * kick;
    p.tv = p.tv * keep + (Math.random() * 2 - 1) * kick;
    // u/v sont en m/s. La conversion locale suffit sur les quelques heures de
    // vie d'une bouffée et évite une projection complète à chaque sous-pas.
    p.lat += (out.v + p.tv) * seconds / 110570;
    p.lon += (out.u + p.tu) * seconds
           / (111320 * Math.max(Math.cos(p.lat * Math.PI / 180), .2));
    return true;
  }

  function spawn(seed = false, emitter = null) {
    emitter ||= pick();
    if (!emitter) return null;
    // Les agrégats nationaux représentent une cellule de 0,25°, pas un point :
    // leur naissance est étalée sur cette emprise. Au zoom détaillé, la largeur
    // scan/track du pixel satellite donne une dispersion initiale plus resserrée.
    const jitterKm = emitter.spread * (Math.random() + Math.random() - 1);
    const angle = Math.random() * Math.PI * 2;
    const p = {
      lon: emitter.lon + Math.cos(angle) * jitterKm
         / (111.32 * Math.max(Math.cos(emitter.lat * Math.PI / 180), .2)),
      lat: emitter.lat + Math.sin(angle) * jitterKm / 110.57,
      age: 0, tu: (Math.random() * 2 - 1) * .7,
      tv: (Math.random() * 2 - 1) * .7,
      life: SMOKE_H * (.72 + Math.random() * .56),
      size: .72 + Math.random() * .58,
      alpha: .62 + Math.random() * .38,
    };
    // Au premier affichage, amorcer des âges différents donne immédiatement un
    // panache constitué. Les petits pas suivent déjà les courbures du champ.
    if (seed) {
      const age = Math.random() * p.life * .82, dt = age / 12;
      for (let i = 0; i < 12; i++) {
        if (!advect(p, dt)) return null;
        p.age += dt;
      }
    }
    return p;
  }

  function loop() {
    // Une source peut s'éteindre alors que son panache est encore en vol.
    // Pendant play, la boucle reste aussi active dans les intervalles sans feu :
    // elle consomme leur temps virtuel au lieu de le reporter sur la prochaine
    // source qui apparaîtrait.
    getWindProjection(wind);
    const run = S.on && wind.current
             && !!(isPlaying() || S.pending || S.emitters.length || S.parts.length)
             && !document.hidden;
    canvas.hidden = !S.on;
    if (run && !S.raf) {
      S.last = performance.now();
      S.raf = requestAnimationFrame(frame);
    }
    if (!run && S.raf) {
      cancelAnimationFrame(S.raf); S.raf = null;
      ctx.clearRect(0, 0, S.w, S.h);
    }
  }

  function setTime(ts, force = false, reseed = false) {
    const { atLatest, lastObservedTime, layerVisibility, steps } = getState();
    const previousTs = S.ts;
    S.ts = ts;
    // En lecture, l'horloge physique est exactement celle du curseur. Le delta
    // est mis en attente puis consommé par la prochaine frame de fumée. Un saut
    // manuel, lui, réamorce explicitement l'état demandé.
    if (isPlaying() && ts > previousTs && !reseed) S.pending += ts - previousTs;
    const bucket = Math.floor(ts / (15 * 60));
    if (!force && bucket === S.bucket) return;
    S.bucket = bucket;
    const now = steps.length ? Math.min(ts, lastObservedTime) : ts;
    S.emitters = S.sources
      .filter(feature => {
        const p = feature.properties || {};
        return p.ts <= now && p.ts > now - SMOKE_WINDOW
            && layerVisibility.hotspots[p.source] !== false;
      })
      .map(feature => {
        const p = feature.properties || {}, n = Math.max(+p.n || 1, 1);
        const frp = Math.max(+p.frp || 0, 0);
        // La racine évite qu'un pixel extrême écrase tout le pays ; les deux
        // facteurs restent indépendants, donc un front étendu mais modéré émet
        // lui aussi davantage qu'un foyer isolé.
        const weight = Math.sqrt(n) * (.7 + Math.log1p(frp));
        return {
          lon: feature.geometry.coordinates[0],
          lat: feature.geometry.coordinates[1],
          weight,
          spread: p.overview ? 9
            : Math.max(.18, Math.min(1.2, Math.max(+p.scan || 0, +p.track || 0) * .65)),
        };
      });
    S.total = S.emitters.reduce((sum, emitter) => sum + emitter.weight, 0);
    const density = atLatest ? SMOKE_LIVE_DENSITY : 1;
    S.target = S.total ? Math.min(particleCount, Math.max(S.emitters.length,
      Math.round((S.emitters.length * 4.2 + S.total * .18) * density))) : 0;

    // Au premier rendu, lors d'une sélection explicite de sources ou si la frise
    // repart en arrière, les panaches sont réamorcés dans l'état demandé. Un
    // simple changement de niveau de détail conserve au contraire les bouffées
    // existantes : leur géographie et leur courbure restent continues.
    if (reseed || !S.ready || ts < previousTs) {
      S.parts.length = 0;
      S.pending = 0;
      S.emitCarry = 0;
      S.ready = true;
      // Un passage uniforme donne d'abord une bouffée à chaque foyer récent ;
      // les suivantes repassent par le mélange uniforme/pondéré de `pick`.
      for (const emitter of S.emitters) {
        const p = spawn(true, emitter);
        if (p) S.parts.push(p);
        if (S.parts.length >= S.target) break;
      }
      for (let i = 0; i < S.target; i++) {
        if (S.parts.length >= S.target) break;
        const p = spawn(true);
        if (p) S.parts.push(p);
      }
    }
    loop();
  }

  /* Intègre un intervalle physique. En lecture, un appel représente souvent
   * plusieurs minutes de frise : les sous-pas évitent qu'une bouffée traverse une
   * maille de vent d'un seul bond et permettent d'émettre tout au long du trajet.
   * Le nombre de sous-pas est borné pour garder le coût stable dans les longs
   * creux entre deux passages satellite. */
  function advance(seconds) {
    if (!(seconds > 0) || !wind.current) return;
    const count = Math.min(12, Math.max(1, Math.ceil(seconds / (5 * 60))));
    const dt = seconds / count;
    for (let step = 0; step < count; step++) {
      /* Balayage décroissant, comme avant, pour que les bouffées consomment le
       * hasard de la diffusion dans le même ordre. Les survivantes sont ensuite
       * tassées vers la fin du tableau puis ramenées d'un bloc, au lieu d'un
       * `splice()` par disparition qui recopiait toute la queue à chaque fois :
       * en lecture accélérée, où un panache s'éteint en masse, cette recopie
       * répétée devenait quadratique. L'ordre relatif — donc l'ordre de dessin
       * et la superposition des alphas — est conservé.
       *
       * `write` reste à -1 tant que rien n'a disparu : au dernier instant, où la
       * quasi-totalité des bouffées survit d'une frame à l'autre, la passe ne
       * coûte alors pas une seule écriture. */
      const before = S.parts.length;
      let write = -1;
      for (let i = before - 1; i >= 0; i--) {
        const p = S.parts[i];
        p.age += dt;
        if (p.age >= p.life || !advect(p, dt)) {
          if (write < 0) write = i;   // première disparition : le tassement commence
          continue;
        }
        if (write >= 0) S.parts[write--] = p;
      }
      if (write >= 0) {
        S.parts.copyWithin(0, write + 1);
        S.parts.length = before - write - 1;
      }
      // Le débit est défini en temps physique : à l'équilibre, six heures
      // d'émission donnent `target` bouffées. Accélérer la frise accélère donc à
      // la fois le vent, le vieillissement et les nouvelles émissions.
      if (S.emitters.length && S.target) {
        S.emitCarry += S.target / SMOKE_H * dt;
        let births = Math.floor(S.emitCarry);
        S.emitCarry -= births;
        births = Math.min(births, particleCount - S.parts.length);
        for (let i = 0; i < births; i++) {
          const p = spawn(false);
          if (p) S.parts.push(p);
        }
      }
    }
  }

  function frame(now) {
    const atLatest = getState().atLatest;
    S.raf = requestAnimationFrame(frame);
    // Une petite saccade ne doit pas ralentir l'horloge physique. L'onglet caché
    // arrête déjà proprement la boucle ; la borne d'une seconde ne sert qu'à
    // absorber un blocage exceptionnel du thread principal.
    const wallDt = Math.min((now - S.last) / 1000, 1);
    const playing = isPlaying();
    S.last = now;
    // `pending` vient de la frise. Une pause historique continue au rythme réel.
    // Au dernier instant seulement, la carte reste « vivante » : trois minutes
    // physique par seconde murale rend le déplacement perceptible sans retrouver
    // l'emballement de l'ancien multiplicateur fixe, et accélère ensemble vent,
    // émission, diffusion et extinction.
    const idleK = atLatest ? SMOKE_LIVE_K : 1;
    const seconds = S.pending + (playing ? 0 : wallDt * idleK);
    S.pending = 0;
    getWindProjection(wind);
    advance(seconds);

    ctx.clearRect(0, 0, S.w, S.h);
    if (!wind.current || !S.parts.length) return;
    for (let i = S.parts.length - 1; i >= 0; i--) {
      const p = S.parts[i];
      const x = (p.lon - wind.lon0) / wind.dLon;
      const y = (merc(p.lat) - wind.y0) / wind.dY;
      if (x < -80 || y < -80 || x > S.w + 80 || y > S.h + 80) continue;
      const q = p.age / p.life;
      const fade = Math.pow(1 - q, 1.45) * Math.min(p.age / (12 * 60), 1);
      // Taille en kilomètres, convertie à l'échelle courante. Une bouffée garde
      // donc la même emprise au sol pendant un zoom ; seuls un plancher de trois
      // pixels et une borne de sécurité évitent disparition et voile plein écran.
      const kmPerPx = Math.abs(wind.dLon) * 111.32
                    * Math.max(Math.cos(p.lat * Math.PI / 180), .2);
      const live = atLatest && !playing;
      const radiusKm = (.30 + 2.35 * Math.sqrt(q)) * p.size * (live ? 1.18 : 1);
      const radius = Math.min(Math.max(radiusKm / Math.max(kmPerPx, .001), 3),
                              mobile ? 78 : 105);
      ctx.globalAlpha = (live ? .48 : .20) * fade * p.alpha;
      ctx.drawImage(S.sprite, x - radius, y - radius, radius * 2, radius * 2);
    }
    ctx.globalAlpha = 1;
  }

  function useVisibleSources({ manifest, zoom, hotspots, bounds, time }) {
    const detailed = manifest && zoom >= manifest.detail_zoom && hotspots.length;
    S.sources = detailed ? hotspots : S.overview;
    if (detailed) {
      // En panoramique, les panaches déjà loin hors champ ne doivent pas occuper
      // tout le budget et empêcher la nouvelle zone visible d'émettre. Une marge
      // généreuse préserve ceux qui peuvent revenir au prochain petit mouvement.
      const mx = (bounds.getEast() - bounds.getWest()) * .45;
      const my = (bounds.getNorth() - bounds.getSouth()) * .45;
      S.parts = S.parts.filter(p =>
        p.lon >= bounds.getWest() - mx && p.lon <= bounds.getEast() + mx
        && p.lat >= bounds.getSouth() - my && p.lat <= bounds.getNorth() + my);
    }
    setTime(time, true, false);
    // Compléter le budget avec une première bouffée par pixel détaillé, sans
    // retirer celles déjà en vol. Le zoom comme le panoramique changent ainsi de
    // résolution en continu, puis les émissions pondérées prennent le relais.
    if (detailed && S.parts.length < S.target) {
      for (const emitter of S.emitters) {
        if (S.parts.length >= S.target || S.parts.length >= particleCount) break;
        const p = spawn(true, emitter);
        if (p) S.parts.push(p);
      }
    }
  }

  function pauseForExport() {
    const running = !!S.raf;
    if (S.raf) { cancelAnimationFrame(S.raf); S.raf = null; }
    return { running };
  }

  return {
    configureOverview(features) {
      S.overview = features;
      S.sources = S.overview;
    },
    copyParts: () => S.parts.map(part => ({ ...part })),
    getSources: () => [...S.sources],
    getSprite: () => S.sprite,
    isEnabled: () => S.on,
    loop,
    pauseForExport,
    resize,
    restoreExport: snapshot => { if (snapshot.running) loop(); },
    setEnabled: enabled => { S.on = enabled; loop(); },
    setTime,
    useVisibleSources,
  };
}
