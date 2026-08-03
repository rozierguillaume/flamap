/* Interpolation bilinéaire sur une grille régulière. La géométrie (`bbox`,
 * `nx`, `ny`) est passée à part de la nappe lue : depuis que la température a
 * sa propre grille, bien plus fine que celle du vent, un même point de la carte
 * ne tombe plus sur les mêmes mailles selon le champ interrogé. */
export function gridBilinear(grid, values, lon, lat) {
  if (!grid || !values) return null;
  const gx = (lon - grid.bbox[0]) / (grid.bbox[2] - grid.bbox[0]) * (grid.nx - 1);
  const gy = (lat - grid.bbox[1]) / (grid.bbox[3] - grid.bbox[1]) * (grid.ny - 1);
  if (!(gx >= 0 && gy >= 0 && gx <= grid.nx - 1 && gy <= grid.ny - 1)) return null;
  const ix = Math.min(gx | 0, grid.nx - 2), iy = Math.min(gy | 0, grid.ny - 2);
  const fx = gx - ix, fy = gy - iy, k = iy * grid.nx + ix, k2 = k + grid.nx;
  // Les quatre coins sont lus dans des variables plutôt que dans un tableau
  // intermédiaire : la valeur rendue est identique, sans allocation par appel.
  const c00 = values[k], c10 = values[k + 1];
  const c01 = values[k2], c11 = values[k2 + 1];
  if (!Number.isFinite(c00) || !Number.isFinite(c10)
      || !Number.isFinite(c01) || !Number.isFinite(c11)) return null;
  return (c00 * (1 - fx) + c10 * fx) * (1 - fy)
       + (c01 * (1 - fx) + c11 * fx) * fy;
}

/* Interpole une nappe d'une grille horaire à un instant quelconque. Le champ
 * thermique et le vent sont collectés par deux workflows de cadences
 * différentes : ils n'ont ni le même pas d'espace, ni la même base de temps, et
 * ne se lisent donc jamais au même indice de ligne. */
export function gridAt(grid, key, lon, lat, ts) {
  if (!grid?.[key]) return null;
  const x = (ts - grid.t0) / grid.dt;
  const last = grid[key].length - 1;
  if (!(x >= 0 && x <= last)) return null;
  const k = Math.min(x | 0, last - 1), f = x - k;
  const a = gridBilinear(grid, grid[key][k], lon, lat);
  const b = gridBilinear(grid, grid[key][k + 1], lon, lat);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return a + (b - a) * f;
}

export function windAtGrid(d, g, lon, lat, out) {
  if (!d || !g) return false;
  const gx = (lon - d.bbox[0]) / (d.bbox[2] - d.bbox[0]) * (d.nx - 1);
  const gy = (lat - d.bbox[1]) / (d.bbox[3] - d.bbox[1]) * (d.ny - 1);
  if (!(gx >= 0 && gy >= 0 && gx <= d.nx - 1 && gy <= d.ny - 1)) return false;

  const i = Math.min(gx | 0, d.nx - 2), j = Math.min(gy | 0, d.ny - 2);
  const fx = gx - i, fy = gy - j, k = j * d.nx + i, k2 = k + d.nx;
  /* La nappe de particules appelle cette fonction une fois par particule et par
   * frame, soit quelques milliers de fois par seconde. La fermeture `bil` qui
   * portait k, fx et fy y était allouée à chaque appel ; les quatre poids sont
   * désormais calculés une fois et appliqués en ligne. C'est la même formule
   * bilinéaire, seulement factorisée autrement : le regroupement des produits
   * change, l'écart reste au dernier bit d'un flottant et se perd très en deçà
   * du pixel comme du décimètre par seconde. */
  const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy);
  const w01 = (1 - fx) * fy,       w11 = fx * fy;
  const u = g.u, v = g.v, gust = g.gust;

  out.u = u[k] * w00 + u[k + 1] * w10 + u[k2] * w01 + u[k2 + 1] * w11;
  out.v = v[k] * w00 + v[k + 1] * w10 + v[k2] * w01 + v[k2 + 1] * w11;
  out.g = gust[k] * w00 + gust[k + 1] * w10 + gust[k2] * w01 + gust[k2 + 1] * w11;
  return true;
}
