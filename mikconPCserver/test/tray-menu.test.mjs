import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildTrayMenu, trayStatusLine, cutoffWarningLine, AUTOSTART_LABEL, AUTOSTART_DEV_LABEL,
} from "../main/tray-menu.js";

// The status line reads LOCAL hours, to match the clock on the taskbar right beside it. A runner
// in another zone would render a different time from the same instant, so the zone is pinned — and
// the pin is then proven, because an unproven pin is how an assertion silently goes vacuous.
process.env.TZ = "Asia/Manila";
const AT_1432 = new Date(2026, 7, 8, 14, 32, 0);

const item = (tpl, id) => tpl.find((i) => i.id === id);

test("the status line names each of the four states", () => {
  assert.equal(new Date(2026, 0, 1).getTimezoneOffset(), -480,
    "TZ pin did not take effect — these assertions would be vacuous");
  // Locked wins over everything, including a sync that completed before the gate came up.
  assert.equal(trayStatusLine({ locked: true, lastSyncAt: AT_1432, unreachable: 2 }),
    "Locked — open to sign in");
  assert.equal(trayStatusLine({ locked: false, lastSyncAt: null }), "starting…");
  assert.equal(trayStatusLine({ locked: false, lastSyncAt: AT_1432, unreachable: 0 }),
    "mirroring · last sync 14:32");
  assert.equal(trayStatusLine({ locked: false, lastSyncAt: AT_1432, unreachable: 2 }),
    "mirroring · last sync 14:32 · 2 unreachable");
});

test("single-digit hours and minutes are zero padded", () => {
  assert.equal(trayStatusLine({ lastSyncAt: new Date(2026, 7, 8, 9, 5, 0) }),
    "mirroring · last sync 09:05");
});

test("an empty state does not throw and reads as starting", () => {
  assert.equal(trayStatusLine(), "starting…");
  assert.equal(trayStatusLine({}), "starting…");
});

// Redefining the close button makes this the operator's only guaranteed way out, and Locked is the
// state in which they are most likely to want it.
test("Quit is present and enabled in every state", () => {
  const states = [
    {}, { locked: true }, { lastSyncAt: AT_1432 }, { lastSyncAt: AT_1432, unreachable: 3 },
  ];
  for (const state of states) {
    const quit = item(buildTrayMenu({ state, actions: {} }), "tray-quit");
    assert.ok(quit, "no Quit item for " + JSON.stringify(state));
    assert.notEqual(quit.enabled, false);
  }
});

test("the menu carries the status line as a disabled item", () => {
  const tpl = buildTrayMenu({ state: { lastSyncAt: AT_1432 }, actions: {} });
  const status = item(tpl, "tray-status");
  assert.equal(status.label, "mirroring · last sync 14:32");
  assert.equal(status.enabled, false, "the status line must not look clickable");
});

// process.execPath in development is node_modules/electron/dist/electron.exe. Registering that
// writes a Run key that breaks as soon as the checkout moves, so the item must not be live.
test("the autostart item is a live checkbox only in a packaged build", () => {
  const dev = item(buildTrayMenu({
    state: { autostart: { supported: false, enabled: true } }, actions: {},
  }), "tray-autostart");
  assert.equal(dev.enabled, false);
  assert.equal(dev.checked, false, "a dev build must not claim it starts with Windows");
  assert.equal(dev.label, AUTOSTART_DEV_LABEL);

  const packaged = item(buildTrayMenu({
    state: { autostart: { supported: true, enabled: true } }, actions: {},
  }), "tray-autostart");
  assert.equal(packaged.enabled, true);
  assert.equal(packaged.checked, true);
  assert.equal(packaged.label, AUTOSTART_LABEL);
});

test("clicking an item calls the matching action, and autostart toggles", () => {
  const seen = [];
  const tpl = buildTrayMenu({
    state: { autostart: { supported: true, enabled: false } },
    actions: {
      open: () => seen.push("open"),
      quit: () => seen.push("quit"),
      toggleAutostart: (next) => seen.push("autostart:" + next),
    },
  });
  item(tpl, "tray-open").click();
  item(tpl, "tray-autostart").click();
  item(tpl, "tray-quit").click();
  assert.deepEqual(seen, ["open", "autostart:true", "quit"]);

  // And from on to off.
  const off = [];
  const on = buildTrayMenu({
    state: { autostart: { supported: true, enabled: true } },
    actions: { toggleAutostart: (next) => off.push(next) },
  });
  item(on, "tray-autostart").click();
  assert.deepEqual(off, [false]);
});

// main.js builds this menu before the first sync has reported anything, so a missing action must
// not take the tray down with it.
test("a menu built with no actions does not throw when clicked", () => {
  const tpl = buildTrayMenu({ state: {} });
  for (const i of tpl) if (typeof i.click === "function") i.click();
});

test("no id is reused", () => {
  const ids = buildTrayMenu({ state: {} }).map((i) => i.id).filter(Boolean);
  assert.equal(new Set(ids).size, ids.length, "duplicate id: " + ids.join(", "));
});

// ---------------------------------------------------------------------------
// The cut-off warning line
// ---------------------------------------------------------------------------

const affected = (...v) => v.map((verdict, i) => ({ id: "r" + i, name: ["House", "Shop", "Depot"][i], verdict }));

test("a healthy fleet shows no warning line at all", () => {
  assert.equal(cutoffWarningLine({ affected: [], worst: null }), "");
  assert.equal(cutoffWarningLine({}), "");
  assert.equal(cutoffWarningLine(), "");
  assert.equal(buildTrayMenu({ state: {} }).find((i) => i.id === "tray-cutoff"), undefined);
});

// Most installs have one to three routers. "House" tells the operator where to go; "1 router"
// makes them look it up.
test("one affected router is named", () => {
  assert.equal(cutoffWarningLine({ affected: affected("missing"), worst: "missing" }),
    "⚠ House: cut-off not installed");
  assert.equal(cutoffWarningLine({ affected: affected("stale"), worst: "stale" }),
    "⚠ House: cut-off is out of date");
  assert.equal(cutoffWarningLine({ affected: affected("unscheduled"), worst: "unscheduled" }),
    "⚠ House: cut-off never runs");
  assert.equal(cutoffWarningLine({ affected: affected("dry"), worst: "dry" }),
    "⚠ House: cut-off is log-only");
});

test("several affected routers are counted, worded by the worst", () => {
  assert.equal(cutoffWarningLine({ affected: affected("dry", "stale"), worst: "stale" }),
    "⚠ 2 routers: cut-off needs attention");
  assert.equal(cutoffWarningLine({ affected: affected("dry", "dry"), worst: "dry" }),
    "⚠ 2 routers: cut-off is log-only");
});

test("a router with no name falls back to its id", () => {
  assert.equal(cutoffWarningLine({ affected: [{ id: "r7", name: "", verdict: "missing" }], worst: "missing" }),
    "⚠ r7: cut-off not installed");
});

test("the warning appears in the menu as a disabled line under the status", () => {
  const tpl = buildTrayMenu({
    state: { cutoff: { affected: affected("missing"), worst: "missing" } },
    actions: {},
  });
  const it = tpl.find((i) => i.id === "tray-cutoff");
  assert.ok(it, "no warning item in the menu");
  assert.equal(it.label, "⚠ House: cut-off not installed");
  assert.equal(it.enabled, false);
  assert.ok(tpl.indexOf(it) > tpl.findIndex((i) => i.id === "tray-status"));
  assert.ok(tpl.find((i) => i.id === "tray-quit"), "Quit must survive every state");
});
