import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  SHELL_STATE_FILE, readShellState, shouldShowHideBalloon, markHideBalloonShown,
} from "../main/shell-state.js";
import { STATE_FILE } from "../main/window-state.js";

const freshDir = () => mkdtempSync(path.join(tmpdir(), "mikcon-shell-"));

test("the balloon shows once and then never again", () => {
  const dir = freshDir();
  assert.equal(shouldShowHideBalloon(dir), true);
  markHideBalloonShown(dir);
  assert.equal(shouldShowHideBalloon(dir), false);
  markHideBalloonShown(dir);                      // idempotent
  assert.equal(shouldShowHideBalloon(dir), false);
});

// This file is on disk, so it can be corrupted, hand-edited, or written by an older build.
// It fails toward telling the operator: an extra balloon is a nuisance, a missing one is an app
// the operator believes has crashed.
test("a corrupt or missing file reads as empty, not a throw", () => {
  const dir = freshDir();
  assert.deepEqual(readShellState(dir), {});
  assert.equal(shouldShowHideBalloon(dir), true);
  writeFileSync(path.join(dir, SHELL_STATE_FILE), "{{{", "utf8");
  assert.deepEqual(readShellState(dir), {});
  assert.equal(shouldShowHideBalloon(dir), true);
  writeFileSync(path.join(dir, SHELL_STATE_FILE), "[1,2]", "utf8");
  assert.deepEqual(readShellState(dir), {}, "an array is not a state object");
});

// window-state.json is validated by validateBounds(), whose whole job is rejecting fields it does
// not recognise. Threading an unrelated boolean through it would mean touching that validator.
test("the window geometry file is a separate file and is left alone", () => {
  const dir = freshDir();
  assert.notEqual(SHELL_STATE_FILE, STATE_FILE);
  writeFileSync(path.join(dir, STATE_FILE), JSON.stringify({ width: 1280, height: 860 }), "utf8");
  markHideBalloonShown(dir);
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, STATE_FILE), "utf8")),
    { width: 1280, height: 860 });
  assert.ok(existsSync(path.join(dir, SHELL_STATE_FILE)));
});

// Every other key must survive a write, or this file could never carry a second flag.
test("writing one flag does not drop the rest of the file", () => {
  const dir = freshDir();
  writeFileSync(path.join(dir, SHELL_STATE_FILE), JSON.stringify({ somethingElse: 7 }), "utf8");
  markHideBalloonShown(dir);
  assert.deepEqual(readShellState(dir), { somethingElse: 7, hideBalloonShown: true });
});

// A read-only or missing directory must not take the app down on the way out.
test("an unwritable directory is swallowed, not thrown", () => {
  const missing = path.join(freshDir(), "no", "such", "dir");
  assert.doesNotThrow(() => markHideBalloonShown(missing));
});
