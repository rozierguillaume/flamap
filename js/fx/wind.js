import { t } from '../i18n.js';
import { gridAt, gridBilinear, windAtGrid } from '../util/grid.js';


/* =====================================================================
 * VENT — nappe de particules advectées par le champ modélisé
 *
 * Le manifest porte une grille grossière par région — AROME HD sur la France,
 * un modèle européen sur l'Ibérie, jamais une grille commune : voir
 * `IBERIA_WIND_MODEL` côté collecteur. Les paquets de zone peuvent leur
 * substituer une grille fine. Toutes contiennent les composantes
 * est/nord du vent à 10 m en m/s. On tire
 * quelques milliers de particules au hasard sur l'écran, on les déplace le long
 * du champ interpolé, et on laisse derrière elles une traînée qui s'estompe.
 *
 * Deux détails valent d'être notés :
 *  - les composantes u/v plutôt que vitesse + azimut : interpoler des angles
 *    qui bouclent à 360° donnerait des girouettes folles entre deux mailles ;
 *  - l'écran, pas le sol : à z8 un vent de 10 m/s vaut 0,02 px/s, invisible. La
 *    vitesse rendue est donc relative — comparable d'un point à l'autre, mais
 *    ce n'est pas une distance parcourue au sol.
 * ===================================================================== */

const WIND_K    = 5;                    // px/s pour 1 m/s de vent
const WIND_LIFE = 3.2;                  // s avant de renaître ailleurs
const WIND_FADE = .90;                  // alpha retiré à la traînée par frame
/* Les seize aires de vent, dans l'ordre des azimuts : le tableau est indexé par
 * le calcul, ses libellés viennent du dictionnaire. */
export const CARD = Array.from({ length: 16 }, (_, i) => t(`wind.card.${i}`));

/* Les fiches nomment le modèle qui a produit la valeur affichée : il change
 * d'une région à l'autre, et « AROME » partout serait faux dès qu'on sort de
 * France. Un identifiant inconnu — le repli `best_match` d'Open-Meteo, un
 * modèle ajouté plus tard — reste nommé, mais sans prétendre lequel. */
const MODEL_LABEL = {
  meteofrance_arome_france_hd: 'AROME HD',
  meteofrance_arpege_europe: 'ARPEGE Europe',
};

// Au zoom de détail, la grille fine se fond dans le champ national sur les
// 35 derniers kilometres de sa marge. Sans ce raccord, la différence de
// résolution dessinait le carré exact de la cellule active dans les particules.
const WIND_BLEND_KM = 35;

export function createWindController({
  mobile,
  map,
  canvas,
  key,
  value,
  getManifest,
  onBadgeChange = () => {},
  onFieldChange = () => {},
} = {}) {
  const ctx = canvas.getContext('2d');
  const particleCount = mobile ? 550 : 1700;  // particules
  /* Trois classes de vitesse : la nappe bleuit dans les calmes, blanchit dans le
   * fort. Le seuil bas ne descend pas plus : sous 5 m/s les segments tracés par
   * frame sont déjà courts, un alpha plus faible les rendrait illisibles sur
   * l'imagerie claire — et un vent faible autour d'un feu, ça se lit aussi. */
  const lanes = [
    [5,        'rgba(191,227,255,.55)', mobile ? .9 : 1.0],
    [10,       'rgba(224,241,255,.70)', mobile ? 1.1 : 1.2],
    [Infinity, 'rgba(255,255,255,.88)', mobile ? 1.3 : 1.5],
  ];
  /* `data` reste le champ de référence — celui qui porte la température de
   * repli et les prévisions. `fields` le contient en premier, suivi des champs
   * régionaux : ils ne se recouvrent qu'en marge, et le premier qui couvre le
   * point l'emporte. */
  const W = {
    data: null, fields: [], cur: false, tiles: new Map(), ts: 0, on: true,
    parts: [], raf: null, last: 0, w: 0, h: 0,
  };

  /* `at()` est le point chaud du rendu : la nappe l'appelle une fois par
   * particule et par frame, la fumée jusqu'à douze fois par bouffée et par
   * frame. Les deux objets de travail sont donc alloués une fois pour toutes
   * plutôt qu'à chaque appel. Ils restent privés au contrôleur, ne survivent
   * jamais à l'appel qui les remplit, et `at()` n'est pas réentrant : aucune
   * lecture ne peut observer les valeurs d'un autre point. */
  const coarse = { u: 0, v: 0, g: 0 };
  const fine = { u: 0, v: 0, g: 0 };

  /* Segments à tracer, groupés par classe de vitesse. Une particule alimente
   * exactement une classe, d'où quatre nombres par particule et par classe dans
   * le pire cas. Les tampons sont en double précision, comme les positions
   * qu'ils transportent, et remplis jusqu'à `laneCount` : les trois tableaux
   * qui étaient reconstruits et agrandis à chaque frame disparaissent. */
  const lanePaths = lanes.map(() => new Float64Array(particleCount * 4));
  const laneCount = new Int32Array(lanes.length);
  const sampled = { u: 0, v: 0, g: 0 };   // lecture du champ, réutilisée par frame

  function fieldAt(lon, lat) {
    for (const field of W.fields) {
      const [west, south, east, north] = field.bbox || [];
      if (lon >= west && lon <= east && lat >= south && lat <= north) return field;
    }
    return null;
  }

  function coarseAt(lon, lat, out) {
    for (const field of W.fields)
      if (windAtGrid(field, field._cur, lon, lat, out)) return true;
    return false;
  }

  function at(lon, lat, out) {
    const hasCoarse = coarseAt(lon, lat, coarse);
    const manifest = getManifest();
    if (manifest && map.getZoom() >= manifest.detail_zoom) {
      let weight = 0, blend = 0, fineU = 0, fineV = 0, fineG = 0;
      for (const tile of W.tiles.values()) {
        if (!tile || !windAtGrid(tile, tile._cur, lon, lat, fine)) continue;
        const [west, south, east, north] = tile.bbox;
        const dx = Math.min(lon - west, east - lon)
                 * 111.32 * Math.cos(lat * Math.PI / 180);
        const dy = Math.min(lat - south, north - lat) * 110.57;
        const t = Math.min(Math.max(Math.min(dx, dy) / WIND_BLEND_KM, 0), 1);
        const mix = t * t * (3 - 2 * t);
        fineU += fine.u * mix; fineV += fine.v * mix; fineG += fine.g * mix;
        weight += mix; blend = Math.max(blend, mix);
      }
      if (weight) {
        const a = hasCoarse ? 1 - blend : 0;
        out.u = coarse.u * a + fineU / weight * (1 - a);
        out.v = coarse.v * a + fineV / weight * (1 - a);
        out.g = coarse.g * a + fineG / weight * (1 - a);
        return true;
      }
    }
    if (!hasCoarse) return false;
    out.u = coarse.u; out.v = coarse.v; out.g = coarse.g;
    return true;
  }

  function gridTime(d, ts) {
    if (!d) return null;
    if (d._cur && Math.abs(ts - d._ts) < 120) return d._cur;
    d._ts = ts;
    d._cur = null;
    const x = (ts - d.t0) / d.dt;
    if (!(x >= 0 && x <= d.nt - 1)) return null;
    const k = Math.min(x | 0, d.nt - 2), f = x - k;
    const mix = A => {
      const a = A[k], b = A[k + 1], o = new Float32Array(a.length);
      for (let n = 0; n < a.length; n++) o[n] = a[n] + (b[n] - a[n]) * f;
      return o;
    };
    // Seul le vent est pré-mélangé : il est relu à chaque frame par la nappe de
    // particules. La température ne sert qu'au badge et au volet, quelques fois
    // par seconde au plus, et `thermalAt` fait son interpolation temporelle
    // lui-même — la pré-mélanger reviendrait à parcourir 225 valeurs pour rien.
    d._cur = { u: mix(d.u), v: mix(d.v), gust: mix(d.gust) };
    return d._cur;
  }

  function badge() {
    const o = {}, c = map.getCenter();
    // deux façons de ne rien afficher, qui n'ont pas le même effet sur la mise en
    // page : voir les règles de `#windkey`
    key.classList.toggle('off', !W.on);
    key.hidden = !W.on || !W.cur || !at(c.lng, c.lat, o);
    if (key.hidden) return;

    const kmh = Math.hypot(o.u, o.v) * 3.6;
    const to = (Math.atan2(o.u, o.v) * 180 / Math.PI + 360) % 360;
    const from = CARD[Math.round(((to + 180) % 360) / 22.5) % 16];

    key.style.setProperty('--dir', to.toFixed(0) + 'deg');
    // les rafales sont déjà en km/h dans les exports (`fetch_fires.py` les
    // convertit), contrairement à u/v qui sont en m/s
    value.textContent = t('wind.value',
      { kmh: Math.round(kmh), gust: Math.round(o.g) });
    key.title = t('wind.badge.title',
      { dir: from, kmh: Math.round(kmh), gust: Math.round(o.g) });
  }

  function spawn(p) {
    p.x = Math.random() * W.w;
    p.y = Math.random() * W.h;
    p.age = Math.random() * WIND_LIFE;
    return p;
  }

  /* Écran → coordonnées : la carte n'est ni pivotée ni inclinée, la longitude est
   * donc affine en x et la latitude affine en y de Mercator. Deux multiplications
   * par particule, contre un unproject matriciel. */
  function sync() {
    const b = map.getBounds();
    const merc = lat => Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
    const yN = merc(b.getNorth());
    W.lon0 = b.getWest(); W.dLon = (b.getEast() - b.getWest()) / (W.w || 1);
    W.y0 = yN; W.dY = (merc(b.getSouth()) - yN) / (W.h || 1);
  }

  function resize() {
    // au-delà de 2 le gain est invisible et le coût de remplissage double
    const dpr = Math.min(devicePixelRatio || 1, mobile ? 1.5 : 2);
    W.w = canvas.clientWidth; W.h = canvas.clientHeight;
    canvas.width = Math.round(W.w * dpr);
    canvas.height = Math.round(W.h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineCap = 'round';
    if (W.parts.length !== particleCount)
      W.parts = Array.from({ length: particleCount }, () => spawn({}));
    else W.parts.forEach(spawn);
    sync();
  }

  function frame(now) {
    W.raf = requestAnimationFrame(frame);
    const dt = Math.min((now - W.last) / 1000, .05);
    W.last = now;
    if (!W.cur) return;

    // on retire de l'alpha à ce qui est déjà peint : la traînée s'efface sans
    // qu'un aplat vienne jamais assombrir la carte en dessous
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = `rgba(0,0,0,${WIND_FADE})`;
    ctx.fillRect(0, 0, W.w, W.h);
    ctx.globalCompositeOperation = 'source-over';

    for (let lane = 0; lane < laneCount.length; lane++) laneCount[lane] = 0;
    for (const p of W.parts) {
      p.age += dt;
      const lon = W.lon0 + p.x * W.dLon;
      const lat = (2 * Math.atan(Math.exp(W.y0 + p.y * W.dY)) - Math.PI / 2) * 57.29577951;
      // hors grille ou en fin de vie : on renaît ailleurs, sans tracer le saut
      if (p.age > WIND_LIFE || !at(lon, lat, sampled)) { spawn(p); continue; }

      const nx = p.x + sampled.u * WIND_K * dt, ny = p.y - sampled.v * WIND_K * dt;
      if (nx < -4 || ny < -4 || nx > W.w + 4 || ny > W.h + 4) { spawn(p); continue; }

      const speed = Math.hypot(sampled.u, sampled.v);
      const lane = speed < lanes[0][0] ? 0 : speed < lanes[1][0] ? 1 : 2;
      const path = lanePaths[lane];
      let n = laneCount[lane];
      path[n++] = p.x; path[n++] = p.y; path[n++] = nx; path[n++] = ny;
      laneCount[lane] = n;
      p.x = nx; p.y = ny;
    }

    for (let lane = 0; lane < lanePaths.length; lane++) {
      const path = lanePaths[lane], used = laneCount[lane];
      if (!used) continue;
      ctx.strokeStyle = lanes[lane][1];
      ctx.lineWidth = lanes[lane][2];
      ctx.beginPath();
      for (let i = 0; i < used; i += 4) {
        ctx.moveTo(path[i], path[i + 1]); ctx.lineTo(path[i + 2], path[i + 3]);
      }
      ctx.stroke();
    }
  }

  function loop() {
    const run = W.on && !!W.cur && !document.hidden;
    if (run && !W.raf) { W.last = performance.now(); W.raf = requestAnimationFrame(frame); }
    if (!run && W.raf) {
      cancelAnimationFrame(W.raf); W.raf = null;
      clear();
    }
  }

  /* Le champ n'est connu qu'à l'heure ronde : on fabrique une fois par cran la
   * grille interpolée entre les deux heures encadrantes, et l'animation n'a plus
   * qu'à y piocher. Hors de la fenêtre couverte — fichier périmé, cran trop
   * ancien — `cur` reste nul et la couche s'efface d'elle-même. */
  function setTime(ts, force = false) {
    if (!W.data) return;
    // `show()` est maintenant appelé à chaque frame de lecture. Le champ, lui, ne
    // bouge qu'à l'échelle de l'heure : refabriquer la grille pour deux minutes
    // de modèle brûlerait des allocations pour un résultat identique à l'œil.
    if (!force && W.cur && Math.abs(ts - W.ts) < 120) return;
    W.ts = ts;
    for (const field of W.fields) gridTime(field, ts);
    W.cur = W.fields.some(field => !!field._cur);
    for (const tile of W.tiles.values()) gridTime(tile, ts);
    badge();
    onBadgeChange();
    loop();
    onFieldChange();
  }

  function clear() {
    ctx.clearRect(0, 0, W.w, W.h);
  }

  function setTiles(tiles) {
    W.tiles = new Map(tiles.map(tile => [tile.id, tile.wind]));
    for (const tile of W.tiles.values()) gridTime(tile, W.ts);
  }

  function pauseForExport() {
    const grids = [...new Set([...W.fields, ...W.tiles.values()].filter(Boolean))];
    const snapshot = {
      ts: W.ts, cur: W.cur, running: !!W.raf,
      grids: grids.map(grid => [grid, grid._ts, grid._cur]),
    };
    if (W.raf) { cancelAnimationFrame(W.raf); W.raf = null; }
    return snapshot;
  }

  function setExportTime(ts) {
    W.ts = ts;
    for (const field of W.fields) gridTime(field, ts);
    W.cur = W.fields.some(field => !!field._cur);
    for (const tile of W.tiles.values()) gridTime(tile, ts);
  }

  function restoreExport(snapshot) {
    W.ts = snapshot.ts;
    W.cur = snapshot.cur;
    for (const [grid, ts, cur] of snapshot.grids) {
      grid._ts = ts;
      grid._cur = cur;
    }
    if (snapshot.running) loop();
  }

  function phrase(lon, lat) {
    const out = {};
    if (!W.cur || !at(lon, lat, out)) return '';
    const kmh = Math.hypot(out.u, out.v) * 3.6;
    const to = (Math.atan2(out.u, out.v) * 180 / Math.PI + 360) % 360;
    const from = CARD[Math.round(((to + 180) % 360) / 22.5) % 16];
    // Même formulation que la légende, pour qu'on retrouve la lecture du centre.
    // En français « de » s'élide devant est et ouest : « vent d'ouest », pas
    // « de ouest ». Les deux clés sont identiques dans les langues sans élision.
    return t(/^[aeiou]/.test(from) ? 'wind.phrase.vowel' : 'wind.phrase',
      { dir: from, kmh: Math.round(kmh), gust: Math.round(out.g) });
  }

  return {
    at,
    badge,
    clear,
    addField: field => {
      if (!field || W.fields.includes(field)) return;
      W.fields.push(field);
      // Les champs régionaux arrivent après l'aperçu national : quand un cran
      // est déjà posé, il faut y amener le nouveau venu. Avant, il n'y a rien à
      // préparer — `setTime` le fera, et pré-calculer ici une grille à `ts = 0`
      // ferait croire à un champ courant.
      if (W.cur) gridTime(field, W.ts);
    },
    configure: data => { W.data = data; W.fields = data ? [data] : []; },
    getExportLanes: () => lanes.map(lane => [...lane]),
    getProjection: (out = {}) => {
      out.current = !!W.cur; out.lon0 = W.lon0; out.dLon = W.dLon;
      out.y0 = W.y0; out.dY = W.dY;
      return out;
    },
    getTime: () => W.ts,
    gridValueAt: (name, lon, lat, ts) => gridAt(W.data, name, lon, lat, ts),
    hasCurrent: () => !!W.cur,
    legacyTemperatureAt: (lon, lat) => {
      // Anciens exports locaux : un instantané unique, sans dimension temporelle.
      const values = W.data?.temperature_2m;
      return values ? gridBilinear(W.data, values, lon, lat) : null;
    },
    loop,
    modelAt: (lon, lat) => {
      const field = fieldAt(lon, lat);
      if (!field) return '';
      return MODEL_LABEL[field.model] || t('wind.model.unknown');
    },
    pauseForExport,
    phrase,
    resize,
    restoreExport,
    setEnabled: enabled => { W.on = enabled; loop(); badge(); },
    setExportTime,
    setTiles,
    setTime,
    sync,
    temperatureMetadata: () => ({ dated: W.data?.temperature, ts: W.data?.temperature_ts }),
  };
}
