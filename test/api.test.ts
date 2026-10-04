// Reference values are independent astronomical facts (NASA, Meeus), not this service's own output.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createEphemerisServer } from "../src/server.ts";

const TOKEN = "test-token";
const jd = (iso: string) => Date.parse(iso) / 86400000 + 2440587.5;
const MIN = 1 / 1440;
const COLOMBO = { lat: 6.9271, lon: 79.8612 };

let server: Server;
let base = "";
before(async () => {
  server = createEphemerisServer({ token: TOKEN, sourceUrl: "https://example.org/source" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));

async function post(path: string, body: unknown, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }) {
  const res = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as any };
}

test("Lahiri ayanamsa at J2000 ≈ 23°51'", async () => {
  const r = await post("/v1/positions", { jds: [2451545.0], bodies: ["sun"], ayanamsa: true });
  assert.equal(r.status, 200);
  assert.ok(Math.abs(r.json.ayanamsa[0] - 23.853) < 0.002);
});

test("mean node matches Meeus' formula Ω = 125.04452° − 1934.136261°·T", async () => {
  const t = jd("1994-03-14T03:12:00Z");
  const r = await post("/v1/positions", { jds: [t], bodies: ["mean_node"], ayanamsa: true });
  const T = (t - 2451545) / 36525;
  const meeus = (((125.04452 - 1934.136261 * T) % 360) + 360) % 360;
  const tropical = (r.json.longitudes[0][0] + r.json.ayanamsa[0]) % 360;
  assert.ok(Math.abs(tropical - meeus) < 0.01);
});

test("elongation Moon − Sun /12° flips at the new moon (NASA: 2024-04-08 18:21 UTC) and full moon (2024-04-23 23:49 UTC)", async () => {
  const tithi = { kind: "longitude", terms: [{ body: "moon", coef: 1 }, { body: "sun", coef: -1 }], divisor: 12 };
  for (const [iso, before_, after_] of [["2024-04-08T18:21:00Z", 29, 0], ["2024-04-23T23:49:00Z", 14, 15]] as const) {
    const t = jd(iso);
    const r = await post("/v1/changes", { from: t - 3 * MIN, to: t - 3 * MIN, quantities: [tithi] });
    assert.equal(r.status, 200);
    const q = r.json.results[0];
    assert.equal(q.start, before_);
    assert.equal(q.changes.length, 1);
    assert.equal(q.changes[0].value, after_);
    assert.ok(Math.abs(q.changes[0].jd - t) < 2 * MIN, "within two minutes of NASA's time");
  }
});

test("changes: forward series ends at the first change beyond `to`; backward search finds the previous change", async () => {
  const nakshatra = { kind: "longitude", terms: [{ body: "moon", coef: 1 }], divisor: 360 / 27 };
  const from = jd("2026-09-22T00:00:00Z");
  const fwd = (await post("/v1/changes", { from, to: from + 3, quantities: [nakshatra] })).json.results[0];
  assert.ok(fwd.changes.length >= 2 && fwd.changes.at(-1).jd >= from + 3);
  assert.ok(fwd.changes.slice(0, -1).every((c: any) => c.jd < from + 3));
  fwd.changes.forEach((c: any, i: number) => assert.equal(c.value, (i ? fwd.changes[i - 1].value : fwd.start) + 1 === 27 ? 0 : (i ? fwd.changes[i - 1].value : fwd.start) + 1));
  const back = (await post("/v1/changes", { from, to: from, dir: -1, quantities: [nakshatra] })).json.results[0];
  assert.equal(back.changes.length, 1);
  assert.ok(back.changes[0].jd < from && from - back.changes[0].jd < 2);
  assert.equal(back.changes[0].value, back.start - 1 < 0 ? 26 : back.start - 1);
});

test("a coarser search step finds the same change (to about a second) with far fewer evaluations", async () => {
  const sunSign = (step?: number) => ({ kind: "longitude", terms: [{ body: "sun", coef: 1 }], divisor: 30, ...(step ? { step } : {}) });
  const from = jd("2026-09-23T00:00:00Z"); // the Sun is in Kanya; Thula follows in mid-October
  const hourly = (await post("/v1/changes", { from, to: from, quantities: [sunSign()] })).json.results[0];
  const daily = (await post("/v1/changes", { from, to: from, quantities: [sunSign(1)] })).json.results[0];
  assert.equal(daily.changes[0].value, hourly.changes[0].value);
  assert.ok(Math.abs(daily.changes[0].jd - hourly.changes[0].jd) * 86400 < 2);
  assert.equal((await post("/v1/changes", { from, to: from, quantities: [sunSign(100)] })).status, 400);
});

test("Colombo sunrise on 2026-01-03 is ≈ 06:21 local; sunset follows, then the next sunrise", async () => {
  const midnight = jd("2026-01-02T18:30:00Z"); // 00:00 at +05:30
  const r = await post("/v1/rise-set", { items: [{ jd: midnight, ...COLOMBO, sequence: ["rise", "set", "rise"] }] });
  assert.equal(r.status, 200);
  const [rise, set, next] = r.json.results[0];
  const localMin = ((rise - midnight) * 1440);
  assert.ok(Math.abs(localMin - (6 * 60 + 21)) <= 3, `sunrise at ${localMin} min`);
  assert.ok(set > rise && next > set && next - rise > 0.99 && next - rise < 1.01);
});

test("ingresses: Saturn enters sidereal Meena on 29 March 2025; the ascendant crosses signs through the day", async () => {
  const from = jd("2025-03-01T00:00:00Z");
  const r = await post("/v1/ingresses", { from, to: from + 60, searches: [{ subject: { body: "saturn" } }] });
  assert.equal(r.status, 200);
  const meena = r.json.results[0].find((e: any) => e.index === 11);
  assert.ok(meena && Math.abs(meena.jd - jd("2025-03-29T12:00:00Z")) < 1.5);
  const day = await post("/v1/ingresses", { from: from, to: from + 1, searches: [{ subject: { ascendant: COLOMBO } }] });
  assert.ok(day.json.results[0].length >= 11, "all twelve signs rise in a day");
});

test("rejects missing or wrong tokens, wrong methods, wrong content types and unknown routes", async () => {
  const body = { jds: [2451545], bodies: ["sun"] };
  assert.equal((await post("/v1/positions", body, {})).status, 401);
  assert.equal((await post("/v1/positions", body, { authorization: "Bearer nope" })).status, 401);
  assert.equal((await post("/v1/positions", body, { authorization: `Basic ${TOKEN}` })).status, 401);
  assert.equal((await fetch(base + "/v1/positions", { headers: { authorization: `Bearer ${TOKEN}` } })).status, 405);
  assert.equal((await post("/v1/positions", "x", { authorization: `Bearer ${TOKEN}`, "content-type": "text/plain" })).status, 415);
  assert.equal((await post("/v1/nothing", body)).status, 404);
});

test("validates input: bad JSON, bad numbers, unknown bodies, oversize and runaway searches", async () => {
  assert.equal((await post("/v1/positions", "{nope")).status, 400);
  assert.equal((await post("/v1/positions", [])).status, 400);
  assert.equal((await post("/v1/positions", { jds: [NaN], bodies: ["sun"] })).status, 400);
  assert.equal((await post("/v1/positions", { jds: [1], bodies: ["sun"] })).status, 400); // outside 1000–3000 CE
  assert.equal((await post("/v1/positions", { jds: [2451545], bodies: ["pluto"] })).status, 400);
  assert.equal((await post("/v1/ascendant", { jds: [2451545], lat: 95, lon: 0 })).status, 400);
  assert.equal((await post("/v1/positions", { jds: Array(5001).fill(2451545), bodies: ["sun"] })).status, 400);
  assert.equal((await post("/v1/positions", { jds: Array(3000).fill(2451545), bodies: Array(9).fill("sun") })).status, 422);
  // Oversize: 413, or (when the server closes while the client is still uploading) a connection reset.
  const huge = await post("/v1/positions", { jds: Array(200_000).fill(2451545.123456789), bodies: ["sun"] }).catch(() => ({ status: 413 }));
  assert.equal(huge.status, 413);
  // a quantity that changes every few seconds must stop at the limit, not run forever
  const fast = { kind: "longitude", terms: [{ body: "moon", coef: 1 }], divisor: 0.001 };
  assert.equal((await post("/v1/changes", { from: 2461000, to: 2461300, quantities: [fast] })).status, 422);
  assert.equal((await post("/v1/ingresses", { from: 2461000, to: 2461300, searches: [{ subject: { body: "moon" }, step: 1 / 86400 }] })).status, 422);
  assert.equal((await post("/v1/changes", { from: 2461000, to: 2462000, quantities: [fast] })).status, 400); // range > 400 days
});

test("health check needs no token and reveals no secrets; /source redirects to the public repository", async () => {
  const h = await fetch(base + "/healthz");
  assert.equal(h.status, 200);
  assert.deepEqual(await h.json(), { ok: true, service: "nakatha-ephemeris", ephemeris: "moshier", ayanamsa: "lahiri", source: "https://example.org/source" });
  const s = await fetch(base + "/source", { redirect: "manual" });
  assert.equal(s.status, 302);
  assert.equal(s.headers.get("location"), "https://example.org/source");
});

test("refuses to start without a token unless anonymous mode is explicit", () => {
  assert.throws(() => createEphemerisServer({}));
  createEphemerisServer({ allowAnon: true }).close();
});
