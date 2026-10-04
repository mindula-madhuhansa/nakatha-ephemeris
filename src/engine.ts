// Astronomy layer: the only file that talks to Swiss Ephemeris.
// Pure sky maths. It knows nothing about astrology (no nakshatras, tithis, yogas, rules or texts).
// License: sweph / Swiss Ephemeris is AGPL, so this service is AGPL too (see LICENSE).
import sweph from "sweph";

const { constants: c } = sweph;

// Moshier built-in ephemeris (~3" Moon, roughly 6 s of timing error), no data files to ship.
const EPHE = c.SEFLG_MOSEPH;

// Rise/set: upper limb with refraction (civil sunrise). Some almanacs use the disc centre; tune against a printed litha.
const RISE_FLAGS = 0;

// Lahiri / Chitrapaksha. set_sid_mode is process-global; nothing else in this process may change it.
sweph.set_sid_mode(c.SE_SIDM_LAHIRI, 0, 0);

export type Place = { lat: number; lon: number };

export const BODIES = {
  sun: c.SE_SUN,
  moon: c.SE_MOON,
  mars: c.SE_MARS,
  mercury: c.SE_MERCURY,
  jupiter: c.SE_JUPITER,
  venus: c.SE_VENUS,
  saturn: c.SE_SATURN,
  mean_node: c.SE_MEAN_NODE,
  true_node: c.SE_TRUE_NODE,
} as const;
export type BodyName = keyof typeof BODIES;
export const isBody = (x: unknown): x is BodyName => typeof x === "string" && Object.hasOwn(BODIES, x);

/** Sidereal (Lahiri) ecliptic longitude in degrees [0, 360). jd is UT. */
export function sidereal(jd: number, body: BodyName): number {
  const r = sweph.calc_ut(jd, BODIES[body], EPHE | c.SEFLG_SIDEREAL);
  if (r.error) throw new Error(r.error);
  return r.data[0];
}

/** Longitude and signed motion (deg/day): stations split transit searches into monotonic intervals. */
export function siderealMotion(jd: number, body: BodyName) {
  const r = sweph.calc_ut(jd, BODIES[body], EPHE | c.SEFLG_SIDEREAL | c.SEFLG_SPEED);
  if (r.error) throw new Error(r.error);
  return { longitude: r.data[0], speed: r.data[3] };
}

export function ayanamsa(jd: number): number {
  return sweph.get_ayanamsa_ex_ut(jd, EPHE).data;
}

/** Sidereal ascendant longitude. houses_ex2 is required: plain houses() ignores the sidereal flag. */
export function ascendant(jd: number, place: Place): number {
  return sweph.houses_ex2(jd, EPHE | c.SEFLG_SIDEREAL, place.lat, place.lon, "W").data.points[0];
}

/** Ascendant longitude with its motion in deg/day, from a one-second difference. */
export function ascendantMotion(jd: number, place: Place) {
  const longitude = ascendant(jd, place);
  const next = ascendant(jd + 1 / 86400, place);
  return { longitude, speed: (((next - longitude + 540) % 360) - 180) * 86400 };
}

function riseTrans(jd: number, place: Place, kind: number): number {
  const r = sweph.rise_trans(jd, c.SE_SUN, null, EPHE, kind | RISE_FLAGS, [place.lon, place.lat, 0], 0, 0);
  if (r.flag !== 0) throw new Error(r.error || "sun does not rise/set here on this date");
  return r.data;
}

/** Next sunrise after jd (UT). */
export const sunrise = (jd: number, place: Place) => riseTrans(jd, place, c.SE_CALC_RISE);
/** Next sunset after jd (UT). */
export const sunset = (jd: number, place: Place) => riseTrans(jd, place, c.SE_CALC_SET);
