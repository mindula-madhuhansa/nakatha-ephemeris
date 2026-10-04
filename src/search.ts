// Generic time searches over any function of time. No sky or astrology knowledge in here.

/**
 * Moment an integer-valued function of time changes, searching forward (dir=1) or backward (dir=-1) from jd.
 * Walks in `stepDays` steps (default 1 h: nothing tracked here changes twice within an hour), bisects to ~1 s.
 */
export function findChange(fn: (jd: number) => number, jd: number, dir: 1 | -1 = 1, stepDays = 1 / 24): number {
  const start = fn(jd);
  const step = dir * stepDays;
  let near = jd;
  let far = jd + step;
  while (fn(far) === start) {
    near = far;
    far += step;
  }
  while (Math.abs(far - near) > 1 / 86400) {
    const mid = (near + far) / 2;
    if (fn(mid) === start) near = mid;
    else far = mid;
  }
  return far;
}

export type Motion = { longitude: number; speed: number };
export type Ingress = { jd: number; index: number };
const delta = (a: number, b: number) => ((b - a + 540) % 360) - 180;

/**
 * Every moment a longitude crosses a multiple of `size` degrees. Brackets crossings in `step`-day intervals,
 * splits them at stations (retrograde turns), then refines to under a second.
 * `index` is the division entered, 0 … 360/size - 1.
 */
export function findIngresses(from: number, to: number, motion: (jd: number) => Motion, size = 30, step = 0.25): Ingress[] {
  if (!(Number.isFinite(from) && Number.isFinite(to) && to > from && Number.isFinite(size) && size > 0 && size <= 360 && Number.isFinite(step) && step > 0)) throw new Error("Invalid ingress range");
  const result: Ingress[] = [];
  const scan = (left: number, right: number, a: Motion, b: Motion) => {
    const movement = delta(a.longitude, b.longitude);
    const end = a.longitude + movement;
    const low = Math.min(a.longitude, end), high = Math.max(a.longitude, end);
    for (let boundary = Math.ceil(low / size) * size; boundary <= high; boundary += size) {
      if (movement === 0 || (movement > 0 ? boundary <= a.longitude : boundary >= a.longitude)) continue;
      let lo = left, hi = right;
      while ((hi - lo) * 86400 > 0.25) {
        const mid = (lo + hi) / 2;
        const lon = a.longitude + delta(a.longitude, motion(mid).longitude);
        if (movement > 0 ? lon < boundary : lon > boundary) lo = mid;
        else hi = mid;
      }
      const sign = movement > 0 ? Math.round(boundary / size) : Math.round(boundary / size) - 1;
      const count = Math.round(360 / size);
      if (hi < to) result.push({ jd: hi, index: (sign % count + count) % count });
    }
  };
  let left = from, a = motion(left);
  while (left < to) {
    const right = Math.min(to, left + step), b = motion(right);
    if (a.speed * b.speed < 0) {
      let lo = left, hi = right;
      while ((hi - lo) * 86400 > 0.1) {
        const mid = (lo + hi) / 2;
        if (motion(mid).speed * a.speed > 0) lo = mid; else hi = mid;
      }
      const station = (lo + hi) / 2, at = motion(station);
      scan(left, station, a, at);
      scan(station, right, at, b);
    } else scan(left, right, a, b);
    left = right; a = b;
  }
  const count = Math.round(360 / size);
  const division = (at: number) => ((Math.floor(motion(at).longitude / size) % count) + count) % count;
  return result.sort((a, b) => a.jd - b.jd)
    // A station can touch a boundary without entering the next division.
    .filter((x) => division(x.jd - 0.5 / 86400) !== division(x.jd + 0.5 / 86400))
    .filter((x, i, all) => !i || Math.abs(x.jd - all[i - 1].jd) * 86400 > 0.1);
}
