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
  const fx = gx - ix, fy = gy - iy, k = iy * grid.nx + ix;
  const cells = [values[k], values[k + 1], values[k + grid.nx], values[k + grid.nx + 1]];
  if (!cells.every(Number.isFinite)) return null;
  return (cells[0] * (1 - fx) + cells[1] * fx) * (1 - fy)
       + (cells[2] * (1 - fx) + cells[3] * fx) * fy;
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
  const fx = gx - i, fy = gy - j, k = j * d.nx + i;
  const bil = a => (a[k] * (1 - fx) + a[k + 1] * fx) * (1 - fy)
                 + (a[k + d.nx] * (1 - fx) + a[k + d.nx + 1] * fx) * fy;

  out.u = bil(g.u); out.v = bil(g.v); out.g = bil(g.gust);
  return true;
}
