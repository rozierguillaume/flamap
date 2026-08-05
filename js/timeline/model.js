import { t } from '../i18n.js';

const H = 3600;


/**
 * Les données ne sont pas continues : VIIRS/MODIS ne voient la zone que lors
 * d'un passage orbital, et EFFIS ne republie ses polygones qu'une à deux fois
 * par jour. On reconstruit donc la liste des mises à jour réelles, et le
 * curseur saute de l'une à l'autre — un cran = une actualisation.
 */
export function buildSteps(hs, dated) {
  const out = [];

  // un passage satellite = une rafale de détections en quelques minutes
  const GAP = 25 * 60;
  const currentBySource = new Map();
  for (const f of hs.features) {          // deja trie par date
    const p = f.properties;
    let cur = currentBySource.get(p.source);
    if (cur && p.ts - cur.last <= GAP) {
      cur.n++;
      cur.frp += +p.frp || 0;
      cur.last = p.ts;
      continue;
    }
    cur = {
      ts: p.ts, last: p.ts, kind: 'sat', label: p.source,
      n: 1, frp: +p.frp || 0,
    };
    currentBySource.set(p.source, cur);
    out.push(cur);
  }
  for (const step of out) {
    delete step.last;
    step.frp = Math.round(step.frp * 100) / 100;
  }

  // Chaque publication EFFIS d'un polygone, mais seulement dans la fenêtre
  // couverte par les foyers : 7 jours viennent des flux FIRMS et 3 de
  // l'historique conserve, alors que la couche EFFIS contient toute la saison.
  // Sans ce filtre, une
  // publication de mars étirerait la frise sur cinq mois et tasserait tous les
  // passages satellite à l'extrémité droite.
  const t0 = out.length ? out[0].ts : 0;
  for (const t of new Set(dated.features.map(f => f.properties.lu).filter(Boolean))) {
    if (t >= t0) out.push({ ts: t, kind: 'effis', label: 'EFFIS', n: 0 });
  }

  return out.sort((a, b) => a.ts - b.ts);
}

/* Les crans à venir. Le vent est le seul paramètre dont on connaisse la suite :
 * la frise peut continuer heure par heure après le dernier passage satellite,
 * le feu figé dans son dernier état observé et la seule nappe qui bouge.
 *
 * Désactivé pour l'instant : le vent porte bien les 24 h à venir, il
 * suffit de remonter cette constante pour les rouvrir. */
const FORECAST_H = 0;

export function addForecast(steps, wind, forecastHours = FORECAST_H) {
  const lastObs = steps.length - 1;
  if (!wind || lastObs < 0) return lastObs;

  const end = steps[lastObs].ts;
  for (let k = 0; k < wind.nt; k++) {
    const ts = wind.t0 + k * wind.dt;
    // arrondi au-dessus : le premier cran tombe souvent une demi-heure après le
    // dernier passage, et « +0 h » ne veut rien dire
    if (ts > end && ts <= end + forecastHours * H)
      steps.push({ ts, kind: 'wind', label: t('timeline.forecast'), n: 0,
                   h: Math.ceil((ts - end) / H) });
  }
  return lastObs;
}

/* =====================================================================
 * LECTURE — le temps balayé en continu, à vitesse variable
 *
 * Les mises à jour ne sont pas réparties uniformément : deux ou trois passages
 * satellite se suivent en une heure, puis plus rien pendant douze. Une lecture
 * à vitesse constante passerait l'essentiel de son temps sur du vide et
 * expédierait les rafales ; une lecture cran par cran — l'ancienne — donnait
 * des sauts de plusieurs heures d'un coup, d'où l'impression de à-coups.
 *
 * On calcule donc un coût de lecture le long de la frise : élevé là où les
 * mises à jour se pressent, plancher ailleurs. Le curseur avance vite dans les
 * creux et ralentit dans les rafales. Le noyau gaussien rend ce coût continu,
 * donc l'accélération l'est aussi — aucune cassure de vitesse aux crans.
 * ===================================================================== */
const WARP_N = 720;                        // échantillons de la table
const WARP_K = 6;                          // ralentissement max dans une rafale

export function buildWarp(steps) {
  const t0 = steps[0].ts, span = (steps[steps.length - 1].ts - t0) || 1;
  // largeur du noyau : une rafale « pèse » environ deux heures de frise
  const sigma = Math.max(span / 120, 45 * 60);
  const C = new Float64Array(WARP_N + 1);
  let acc = 0;
  for (let i = 0; i < WARP_N; i++) {
    const t = t0 + span * (i + .5) / WARP_N;
    let d = 0;
    for (const s of steps) {
      const z = (t - s.ts) / sigma;
      // au-delà de 4 sigma la gaussienne ne pèse plus rien
      if (z > -4 && z < 4) d += Math.exp(-.5 * z * z) * (s.kind === 'sat' ? 1 : .35);
    }
    acc += 1 + WARP_K * (d / (1 + d));   // saturé : dix passages ne figent pas la lecture
    C[i + 1] = acc;
  }
  for (let i = 0; i <= WARP_N; i++) C[i] /= acc;
  return { t0, span, C };
}

// progression de lecture (0→1) → instant de la frise
export function warpTime(warp, p) {
  const C = warp.C;
  let lo = 0, hi = WARP_N;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (C[m] <= p) lo = m; else hi = m; }
  const a = C[lo], b = C[lo + 1];
  return warp.t0 + warp.span * (lo + (b > a ? (p - a) / (b - a) : 0)) / WARP_N;
}

// l'inverse, pour reprendre la lecture là où le curseur a été lâché
export function warpProgress(warp, ts) {
  const x = (ts - warp.t0) / warp.span * WARP_N;
  if (x <= 0) return 0;
  if (x >= WARP_N) return 1;
  const i = x | 0, f = x - i;
  return warp.C[i] + (warp.C[i + 1] - warp.C[i]) * f;
}

// démarrage et arrivée adoucis, sans écraser la modulation par densité
export const ease = p => .72 * p + .28 * (p * p * (3 - 2 * p));

// monotone, mais sans forme fermée commode : on l'inverse par dichotomie, une
// seule fois par appui sur Lecture
export function unease(y) {
  let lo = 0, hi = 1;
  for (let i = 0; i < 24; i++) { const m = (lo + hi) / 2; if (ease(m) < y) lo = m; else hi = m; }
  return (lo + hi) / 2;
}
