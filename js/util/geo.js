export function distanceKm(a, b) {
  const lat = (a[1] + b[1]) / 2 * Math.PI / 180;
  const dx = (a[0] - b[0]) * Math.cos(lat) * 111.32;
  const dy = (a[1] - b[1]) * 110.57;
  return Math.hypot(dx, dy);
}

export function aircraftCurve(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return [0, 1].map(axis => .5 * (
    2 * p1[axis]
    + (-p0[axis] + p2[axis]) * t
    + (2 * p0[axis] - 5 * p1[axis] + 4 * p2[axis] - p3[axis]) * t2
    + (-p0[axis] + 3 * p1[axis] - 3 * p2[axis] + p3[axis]) * t3
  ));
}

export function aircraftBearing(from, to) {
  const lat = (from[1] + to[1]) / 2 * Math.PI / 180;
  const east = (to[0] - from[0]) * Math.cos(lat);
  const north = to[1] - from[1];
  return (Math.atan2(east, north) * 180 / Math.PI + 360) % 360;
}

export const signed = value =>
  `${value >= 0 ? '+' : '-'}${String(Math.abs(value)).padStart(2, '0')}`;

export const zoneId = (x, y) => `x${signed(x)}_y${signed(y)}`;
