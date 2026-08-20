import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateBounds, readState, writeState, STATE_FILE, MIN_WIDTH, MIN_HEIGHT } from "../main/window-state.js";

// One 1920x1080 monitor at the origin, Electron's screen.getAllDisplays() shape.
const ONE = [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }];

test("garbage in returns null so the caller falls back to the default size", () => {
  assert.equal(validateBounds(null, ONE), null);
  assert.equal(validateBounds("nope", ONE), null);
  assert.equal(validateBounds({}, ONE), null);
  assert.equal(validateBounds({ width: NaN, height: 800 }, ONE), null);
  assert.equal(validateBounds({ width: "1200", height: null }, ONE), null);
});

test("a size below the app's own minimum is clamped up, not rejected", () => {
  const b = validateBounds({ width: 400, height: 200 }, ONE);
  assert.equal(b.width, MIN_WIDTH);
  assert.equal(b.height, MIN_HEIGHT);
});

test("a valid rectangle on a connected display keeps its position", () => {
  const b = validateBounds({ x: 100, y: 80, width: 1280, height: 860 }, ONE);
  assert.deepEqual(b, { width: 1280, height: 860, maximized: false, x: 100, y: 80 });
});

// The case this function exists for: the operator closed MikconPC on a second monitor and then
// unplugged it. Restoring that position opens the window where it cannot be dragged back.
test("a rectangle on a disconnected display loses its position but keeps its size", () => {
  const b = validateBounds({ x: 3000, y: 200, width: 1280, height: 860 }, ONE);
  assert.equal(b.width, 1280);
  assert.equal(b.height, 860);
  assert.equal(b.x, undefined);
  assert.equal(b.y, undefined);
});

test("a window straddling the edge of a connected display is kept", () => {
  const b = validateBounds({ x: 1850, y: 100, width: 1280, height: 860 }, ONE);
  assert.equal(b.x, 1850);
});

test("the maximized flag round-trips and defaults to false", () => {
  assert.equal(validateBounds({ width: 1280, height: 860, maximized: true }, ONE).maximized, true);
  assert.equal(validateBounds({ width: 1280, height: 860 }, ONE).maximized, false);
  assert.equal(validateBounds({ width: 1280, height: 860, maximized: "yes" }, ONE).maximized, false);
});

test("no connected displays at all drops the position rather than throwing", () => {
  const b = validateBounds({ x: 10, y: 10, width: 1280, height: 860 }, []);
  assert.equal(b.x, undefined);
  assert.equal(validateBounds({ x: 10, y: 10, width: 1280, height: 860 }, undefined).x, undefined);
});

test("readState tolerates a missing file and unparseable JSON", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mikcon-ws-"));
  assert.equal(readState(dir), null);
  writeFileSync(path.join(dir, STATE_FILE), "{ not json", "utf8");
  assert.equal(readState(dir), null);
});

test("writeState then readState round-trips", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mikcon-ws-"));
  writeState(dir, { x: 5, y: 6, width: 1280, height: 860, maximized: false });
  assert.deepEqual(readState(dir), { x: 5, y: 6, width: 1280, height: 860, maximized: false });
});
