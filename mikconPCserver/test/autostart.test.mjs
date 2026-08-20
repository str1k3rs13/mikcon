import { test } from "node:test";
import assert from "node:assert/strict";
import { autostartPolicy, startsHidden, HIDDEN_FLAG } from "../main/autostart.js";

const EXE = "C:\\Program Files\\MikconPC\\MikconPC.exe";

// In development process.execPath is node_modules/electron/dist/electron.exe. A Run key pointing
// there breaks as soon as the checkout moves, and until it does it launches Electron's default app
// rather than MikconPC. Returning null is how main.js knows to make no call at all.
test("nothing is registered from a development checkout", () => {
  assert.equal(autostartPolicy({ packaged: false, enabled: true, execPath: EXE }), null);
  assert.equal(autostartPolicy({ packaged: false, enabled: false, execPath: EXE }), null);
});

test("a packaged build registers itself, starting hidden", () => {
  const policy = autostartPolicy({ packaged: true, enabled: true, execPath: EXE });
  assert.deepEqual(policy, { openAtLogin: true, path: EXE, args: [HIDDEN_FLAG] });
  assert.equal(HIDDEN_FLAG, "--hidden");
});

// Turning it OFF must still produce a policy object — main.js has to call setLoginItemSettings with
// openAtLogin:false to clear the Run key. A null here would make the checkbox one-way.
test("turning it off is still a call, not a null", () => {
  const policy = autostartPolicy({ packaged: true, enabled: false, execPath: EXE });
  assert.deepEqual(policy, { openAtLogin: false, path: EXE, args: [HIDDEN_FLAG] });
});

// A Run key with an empty path is a Run key that does nothing and cannot be diagnosed.
test("a missing execPath registers nothing", () => {
  assert.equal(autostartPolicy({ packaged: true, enabled: true, execPath: "" }), null);
  assert.equal(autostartPolicy({ packaged: true, enabled: true }), null);
});

test("--hidden is detected only when it is actually present", () => {
  assert.equal(startsHidden([EXE, "--hidden"]), true);
  assert.equal(startsHidden([EXE]), false);
  assert.equal(startsHidden([EXE, "--hidden-something"]), false);
  assert.equal(startsHidden(undefined), false);
  assert.equal(startsHidden("--hidden"), false, "a string is not an argv");
});
