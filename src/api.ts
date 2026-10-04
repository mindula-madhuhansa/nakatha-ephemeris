// Request validation and the endpoints. Every endpoint is a pure function of its JSON body.
// Hard limits keep one request cheap: sweph blocks the event loop, so the work per request is bounded.
import { BODIES, ascendant, ascendantMotion, ayanamsa, isBody, sidereal, siderealMotion, sunrise, sunset } from "./engine.ts";
import type { BodyName, Place } from "./engine.ts";
import { findChange, findIngresses } from "./search.ts";

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
const bad = (message: string) => new HttpError(400, message);

/** Sky evaluations one request may spend. Typical pages need a few hundred to a few thousand. */
export const MAX_EVALS = 120_000;
const MAX_JDS = 5_000;
const MAX_RISE_ITEMS = 400;
const MAX_QUANTITIES = 8;
const MAX_SEARCHES = 16;
const MAX_CHANGES = 400;
const JD_MIN = 2086307.5; // year 1000
const JD_MAX = 2816787.5; // year 3000

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);

function num(x: unknown, name: string, min = -Infinity, max = Infinity): number {
  if (typeof x !== "number" || !Number.isFinite(x) || x < min || x > max) throw bad(`${name} must be a number between ${min} and ${max}`);
  return x;
}
const jdOf = (x: unknown, name: string) => num(x, name, JD_MIN, JD_MAX);

function jdList(x: unknown, name: string): number[] {
  if (!Array.isArray(x) || x.length === 0 || x.length > MAX_JDS) throw bad(`${name} must be a list of 1 to ${MAX_JDS} Julian days`);
  return x.map((v, i) => jdOf(v, `${name}[${i}]`));
}

function placeOf(o: Obj, name = "place"): Place {
  return { lat: num(o.lat, `${name}.lat`, -90, 90), lon: num(o.lon, `${name}.lon`, -180, 180) };
}

function bodyOf(x: unknown, name: string): BodyName {
  if (!isBody(x)) throw bad(`${name} must be one of: ${Object.keys(BODIES).join(", ")}`);
  return x;
}

/** Counts evaluations so a runaway search stops with 422 instead of freezing the process. */
function budget() {
  let left = MAX_EVALS;
  return function counted<A extends unknown[], R>(fn: (...a: A) => R) {
    return (...a: A): R => {
      if (--left < 0) throw new HttpError(422, "search too large: narrow the range or use a larger step");
      return fn(...a);
    };
  };
}

function body(x: unknown): Obj {
  if (!isObj(x)) throw bad("body must be a JSON object");
  return x;
}

/** The ecliptic quantity whose integer part is tracked: floor(wrap360(Σ coef × longitude) / divisor), or the ascendant. */
type Quantity = ({ kind: "longitude"; terms: { body: BodyName; coef: number }[] } | { kind: "ascendant"; place: Place }) & { divisor: number; step: number };

function quantityOf(x: unknown, name: string): Quantity {
  const o = body(x);
  const divisor = num(o.divisor, `${name}.divisor`, 1e-3, 360);
  // Search step in days: 1 h unless the quantity changes slowly enough that a coarser step cannot skip a change.
  const step = o.step === undefined ? 1 / 24 : num(o.step, `${name}.step`, 1 / 1440, 5);
  if (o.kind === "ascendant") return { kind: "ascendant", place: placeOf(o, name), divisor, step };
  if (o.kind !== "longitude") throw bad(`${name}.kind must be "longitude" or "ascendant"`);
  if (!Array.isArray(o.terms) || o.terms.length < 1 || o.terms.length > 3) throw bad(`${name}.terms must have 1 to 3 entries`);
  const terms = o.terms.map((t, i) => {
    const e = body(t);
    return { body: bodyOf(e.body, `${name}.terms[${i}].body`), coef: num(e.coef, `${name}.terms[${i}].coef`, -10, 10) };
  });
  return { kind: "longitude", terms, divisor, step };
}

const wrap360 = (x: number) => (x >= 0 && x < 360 ? x : ((x % 360) + 360) % 360);

function evaluator(q: Quantity): (jd: number) => number {
  if (q.kind === "ascendant") return (jd) => Math.floor(ascendant(jd, q.place) / q.divisor);
  const { terms, divisor } = q;
  return (jd) => Math.floor(wrap360(terms.reduce((s, t) => s + t.coef * sidereal(jd, t.body), 0)) / divisor);
}

/** { jds, bodies, speed?, ayanamsa? } → longitudes[jd][body] (and speeds, ayanamsa when asked). */
function positions(input: unknown) {
  const o = body(input);
  const jds = jdList(o.jds, "jds");
  if (!Array.isArray(o.bodies) || o.bodies.length < 1 || o.bodies.length > 9) throw bad("bodies must list 1 to 9 body names");
  const bodies = o.bodies.map((b, i) => bodyOf(b, `bodies[${i}]`));
  if (jds.length * bodies.length > 20_000) throw new HttpError(422, "too many positions in one request");
  const wantSpeed = o.speed === true;
  const longitudes: number[][] = [], speeds: number[][] = [];
  for (const jd of jds) {
    if (wantSpeed) {
      const row = bodies.map((b) => siderealMotion(jd, b));
      longitudes.push(row.map((m) => m.longitude));
      speeds.push(row.map((m) => m.speed));
    } else longitudes.push(bodies.map((b) => sidereal(jd, b)));
  }
  return { longitudes, ...(wantSpeed ? { speeds } : {}), ...(o.ayanamsa === true ? { ayanamsa: jds.map(ayanamsa) } : {}) };
}

/** { jds, lat, lon } → ascendants (sidereal degrees). */
function ascendants(input: unknown) {
  const o = body(input);
  const place = placeOf(o, "place");
  return { ascendants: jdList(o.jds, "jds").map((jd) => ascendant(jd, place)) };
}

/** { items: [{ jd, lat, lon, sequence: ["rise" | "set", …] }] }: each event is the next one after the previous. */
function riseSet(input: unknown) {
  const o = body(input);
  if (!Array.isArray(o.items) || o.items.length === 0 || o.items.length > MAX_RISE_ITEMS) throw bad(`items must list 1 to ${MAX_RISE_ITEMS} entries`);
  const results = o.items.map((it, i) => {
    const e = body(it);
    const place = placeOf(e, `items[${i}]`);
    if (!Array.isArray(e.sequence) || e.sequence.length < 1 || e.sequence.length > 4) throw bad(`items[${i}].sequence must list 1 to 4 events`);
    let t = jdOf(e.jd, `items[${i}].jd`);
    return e.sequence.map((kind) => {
      if (kind !== "rise" && kind !== "set") throw bad(`items[${i}].sequence entries must be "rise" or "set"`);
      try {
        t = (kind === "rise" ? sunrise : sunset)(t, place);
      } catch (err) {
        throw new HttpError(422, err instanceof Error ? err.message : "no sunrise or sunset");
      }
      return t;
    });
  });
  return { results };
}

/**
 * { from, to, dir?, limit?, quantities } → for each quantity the integer value at `from` (start) and every change
 * going `dir` (1 forward, -1 backward), up to and including the first change at or beyond `to`.
 * With to = from you get exactly the next change.
 */
function changes(input: unknown) {
  const o = body(input);
  const from = jdOf(o.from, "from"), to = jdOf(o.to, "to");
  const dir = o.dir === undefined ? 1 : o.dir;
  if (dir !== 1 && dir !== -1) throw bad("dir must be 1 or -1");
  if (Math.abs(to - from) > 400) throw bad("to must be within 400 days of from");
  if (dir === 1 ? to < from : to > from) throw bad("to must lie in the search direction");
  const limit = o.limit === undefined ? 100 : Math.floor(num(o.limit, "limit", 1, MAX_CHANGES));
  if (!Array.isArray(o.quantities) || o.quantities.length < 1 || o.quantities.length > MAX_QUANTITIES) throw bad(`quantities must list 1 to ${MAX_QUANTITIES} entries`);
  const quantities = o.quantities.map((q, i) => quantityOf(q, `quantities[${i}]`));
  const counted = budget();
  const results = quantities.map((q) => {
    const fn = counted(evaluator(q));
    const step = q.step;
    const out: { jd: number; value: number }[] = [];
    let t = from;
    for (;;) {
      const end = findChange(fn, t, dir, step);
      out.push({ jd: end, value: fn(end) });
      if (dir === 1 ? end >= to : end <= to) break;
      if (out.length >= limit) throw new HttpError(422, "too many changes: narrow the range or raise limit");
      t = end;
    }
    return { start: fn(from), changes: out };
  });
  return { results };
}

/** { from, to, searches: [{ subject, size?, step? }] } → every crossing of a multiple of `size` degrees. */
function ingresses(input: unknown) {
  const o = body(input);
  const from = jdOf(o.from, "from"), to = jdOf(o.to, "to");
  if (to <= from) throw bad("to must be after from");
  if (to - from > 400) throw bad("to must be within 400 days of from");
  if (!Array.isArray(o.searches) || o.searches.length < 1 || o.searches.length > MAX_SEARCHES) throw bad(`searches must list 1 to ${MAX_SEARCHES} entries`);
  const counted = budget();
  const results = o.searches.map((s, i) => {
    const e = body(s);
    const size = e.size === undefined ? 30 : num(e.size, `searches[${i}].size`, 1e-3, 360);
    const step = e.step === undefined ? 0.25 : num(e.step, `searches[${i}].step`, 1 / 86400, 10);
    const subject = body(e.subject);
    const motion = "ascendant" in subject
      ? ((p: Place) => counted((jd: number) => ascendantMotion(jd, p)))(placeOf(body(subject.ascendant), `searches[${i}].subject.ascendant`))
      : ((b: BodyName) => counted((jd: number) => siderealMotion(jd, b)))(bodyOf(subject.body, `searches[${i}].subject.body`));
    // Reject searches whose coarse scan alone would blow the budget before we start.
    if ((to - from) / step > MAX_EVALS) throw new HttpError(422, "search too large: narrow the range or use a larger step");
    return findIngresses(from, to, motion, size, step);
  });
  return { results };
}

const routes: Record<string, (input: unknown) => unknown> = {
  "/v1/positions": positions,
  "/v1/ascendant": ascendants,
  "/v1/rise-set": riseSet,
  "/v1/changes": changes,
  "/v1/ingresses": ingresses,
};

export const isRoute = (path: string) => Object.hasOwn(routes, path);

export function handle(path: string, input: unknown): unknown {
  const route = routes[path];
  if (!route) throw new HttpError(404, "not found");
  try {
    return route(input);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    // Library errors such as an invalid date for the ephemeris: report, never a stack.
    throw new HttpError(422, err instanceof Error ? err.message : "calculation failed");
  }
}
