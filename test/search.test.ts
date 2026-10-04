import { test } from "node:test";
import assert from "node:assert/strict";
import { findChange, findIngresses } from "../src/search.ts";

const wrap = (lon: number) => (lon % 360 + 360) % 360;

test("ingresses refine forward, retrograde and zodiac-wrap crossings", () => {
  for (const [start, speed, expected] of [[29, 8, 1], [31, -8, 0], [359, 8, 0], [1, -8, 11]]) {
    const events = findIngresses(0, 0.25, (t) => ({ longitude: wrap(start + speed * t), speed }));
    assert.equal(events.length, 1);
    assert.equal(events[0].index, expected);
    assert.ok(Math.abs(events[0].jd - 0.125) * 86400 < 0.3);
  }
  assert.throws(() => findIngresses(0, 1, () => ({ longitude: 0, speed: 1 }), 30, 0));
});

test("a station detects out-and-back ingress even with the same endpoint sign, but ignores tangency", () => {
  const motion = (peak: number) => (t: number) => ({ longitude: peak - 64 * (t - 0.125) ** 2, speed: -128 * (t - 0.125) });
  const events = findIngresses(0, 0.25, motion(30.5));
  assert.deepEqual(events.map((e) => e.index), [1, 0]);
  for (const e of events) assert.ok(Math.abs(motion(30.5)(e.jd).longitude - 30) < 0.0001);
  assert.equal(findIngresses(0, 0.25, motion(30)).length, 0);
});

test("findChange locates a step function to about a second, forward and backward", () => {
  const at = 100.37; // the integer part of (jd - 0.5) changes here
  const fn = (jd: number) => Math.floor(jd > at ? 1 : 0);
  assert.ok(Math.abs(findChange(fn, 99, 1) - at) * 86400 <= 1);
  const back = (jd: number) => (jd > at ? 1 : 0);
  assert.ok(Math.abs(findChange(back, 101, -1) - at) * 86400 <= 1);
});
