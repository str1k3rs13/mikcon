import { test } from "node:test";
import assert from "node:assert/strict";
import { attachCloseToTray } from "../main/lifecycle.js";

// A stand-in for BrowserWindow carrying only what attachCloseToTray touches, so this runs under
// `node --test` with no Electron runtime — the same split menu.js and window-state.js already use.
function fakeWin() {
  const handlers = {};
  return {
    hidden: false,
    on(ev, fn) { handlers[ev] = fn; },
    hide() { this.hidden = true; },
    // Returns whether the close was prevented, which is the whole question this module answers.
    close() {
      let prevented = false;
      handlers.close({ preventDefault() { prevented = true; } });
      return prevented;
    },
  };
}

test("close hides the window instead of closing it", () => {
  const win = fakeWin();
  let hides = 0;
  attachCloseToTray(win, { isQuitting: () => false, onHide: () => hides++, saveGeometry: () => {} });
  assert.equal(win.close(), true, "close was not prevented — the app would have quit");
  assert.equal(win.hidden, true);
  assert.equal(hides, 1);
});

// isQuitting is read at close time, not at wire-up time. Passing the boolean instead of a getter
// would capture `false` forever and the app could then never quit — the single most dangerous
// mistake available in this module, so it is pinned by flipping the flag AFTER wiring.
test("close proceeds when the app is really quitting", () => {
  const win = fakeWin();
  let hides = 0;
  let quitting = false;
  attachCloseToTray(win, { isQuitting: () => quitting, onHide: () => hides++, saveGeometry: () => {} });
  quitting = true;
  assert.equal(win.close(), false, "close was prevented — Quit could never exit the app");
  assert.equal(win.hidden, false);
  assert.equal(hides, 0);
});

// Strictly better than today, where geometry is saved only on the way out and a crash loses it.
test("geometry is saved on both paths", () => {
  let saves = 0;
  const hiding = fakeWin();
  attachCloseToTray(hiding, { isQuitting: () => false, onHide: () => {}, saveGeometry: () => saves++ });
  hiding.close();
  const quitting = fakeWin();
  attachCloseToTray(quitting, { isQuitting: () => true, onHide: () => {}, saveGeometry: () => saves++ });
  quitting.close();
  assert.equal(saves, 2);
});

// A balloon that cannot be shown, or a disk that cannot be written, must not leave the window
// stuck on screen having already been told to go away.
test("a throwing saveGeometry or onHide still hides the window", () => {
  const win = fakeWin();
  attachCloseToTray(win, {
    isQuitting: () => false,
    onHide: () => { throw new Error("no tray"); },
    saveGeometry: () => { throw new Error("disk full"); },
  });
  assert.equal(win.close(), true);
  assert.equal(win.hidden, true);
});
