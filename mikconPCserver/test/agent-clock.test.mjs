import { test } from "node:test";
import assert from "node:assert/strict";
import { makeClock, ymd, MIN_SANE_YEAR } from "../agent/clock.js";

// Everything time-dependent in agent/ takes one of these. A test places "now" exactly
// rather than sleeping, which is what makes a year of billing dates testable in milliseconds.
test("a clock reports the instant it was given, not the wall clock", () => {
  const fixed = new Date("2026-03-05T13:45:00");
  const clock = makeClock(() => fixed);
  assert.equal(clock.now().getTime(), fixed.getTime());
  assert.equal(clock.today(), "2026-03-05");
});

test("the default clock follows the wall clock", () => {
  const clock = makeClock();
  const before = Date.now();
  const t = clock.now().getTime();
  assert.ok(t >= before && t <= Date.now());
});

// ymd must agree with the app's own todayYmd(), which is LOCAL time. A UTC-based
// implementation reads as the previous day all early morning in Philippine time (UTC+8),
// which would file an early-morning collection under yesterday.
//
// A UTC+0 runner makes local == UTC, so a UTC-based ymd() would pass this test while
// proving nothing. Pin the zone, then prove the pin took — an unproven pin is how this
// assertion silently goes vacuous again.
process.env.TZ = "Asia/Manila";
test("ymd is local time, not UTC", () => {
  assert.equal(new Date(2026, 0, 1).getTimezoneOffset(), -480,
    "TZ pin did not take effect — this test would be vacuous");
  assert.equal(ymd(new Date(2026, 0, 1, 0, 30, 0)), "2026-01-01");
  assert.equal(ymd(new Date(2026, 11, 31, 0, 30, 0)), "2026-12-31");
});

test("single-digit months and days are zero padded", () => {
  assert.equal(ymd(new Date(2026, 8, 7)), "2026-09-07");
});

// A PC that boots with a dead RTC reads 1970. Nothing in this stage acts on isSane(), but
// every later stage does, and the value must be correct from the first day it exists.
test("a clock before MIN_SANE_YEAR is not sane", () => {
  assert.equal(makeClock(() => new Date("1970-01-01T00:00:00")).isSane(), false);
  assert.equal(makeClock(() => new Date(`${MIN_SANE_YEAR - 1}-12-31T23:59:59`)).isSane(), false);
  assert.equal(makeClock(() => new Date(`${MIN_SANE_YEAR}-01-01T00:00:00`)).isSane(), true);
  assert.equal(makeClock(() => new Date("2026-08-08T00:00:00")).isSane(), true);
});
