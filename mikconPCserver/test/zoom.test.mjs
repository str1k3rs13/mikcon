import { test } from "node:test";
import assert from "node:assert/strict";
import { ZOOM_STEPS, MIN_CSS_WIDTH, maxFactorFor, nextZoomFactor, clampZoomFactor } from "../main/zoom.js";

test("the ladder is ascending and contains 1", () => {
  assert.ok(ZOOM_STEPS.includes(1));
  for (let i = 1; i < ZOOM_STEPS.length; i++) assert.ok(ZOOM_STEPS[i] > ZOOM_STEPS[i - 1]);
  assert.equal(MIN_CSS_WIDTH, 900);
});

test("maxFactorFor is content width over the breakpoint, and survives nonsense", () => {
  assert.equal(maxFactorFor(1800), 2);
  assert.equal(maxFactorFor(900), 1);
  assert.equal(maxFactorFor(0), 1);
  assert.equal(maxFactorFor(NaN), 1);
});

// At the 1280 default the ceiling is 1280/900 = 1.42, so 1.25 is reachable and 1.5 is not.
test("zooming in stops at the step before the desk layout would collapse", () => {
  assert.equal(nextZoomFactor(1, 1, 1280), 1.1);
  assert.equal(nextZoomFactor(1.1, 1, 1280), 1.25);
  assert.equal(nextZoomFactor(1.25, 1, 1280), 1.25, "1.5 would put effective width below 900");
});

test("a wider window earns more zoom", () => {
  assert.equal(nextZoomFactor(1.25, 1, 1920), 1.5);
});

test("zooming out is never blocked, and stops at the bottom of the ladder", () => {
  assert.equal(nextZoomFactor(1, -1, 900), ZOOM_STEPS[ZOOM_STEPS.indexOf(1) - 1]);
  assert.equal(nextZoomFactor(ZOOM_STEPS[0], -1, 900), ZOOM_STEPS[0]);
});

test("actual size is always exactly 1", () => {
  assert.equal(nextZoomFactor(1.75, 0, 1280), 1);
  assert.equal(nextZoomFactor(0.5, 0, 900), 1);
});

// Clamping only when zooming is not enough: an operator zoomed to 1.25 who then narrows the window
// crosses the breakpoint without touching the zoom keys at all.
test("narrowing the window pulls an over-zoomed factor back down", () => {
  assert.equal(clampZoomFactor(1.25, 1000), 1.1);
  assert.equal(clampZoomFactor(1.25, 900), 1);
  assert.equal(clampZoomFactor(1, 1280), 1, "a factor already within the ceiling is untouched");
});

test("clamping never returns a factor above the ceiling", () => {
  for (const w of [900, 1000, 1280, 1920]) {
    for (const f of ZOOM_STEPS) {
      assert.ok(clampZoomFactor(f, w) <= maxFactorFor(w) + 1e-9, `f=${f} w=${w}`);
    }
  }
});
