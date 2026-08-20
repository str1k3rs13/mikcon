import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DESTINATIONS, buildMenuTemplate } from "../main/menu.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// app/www is gitignored and only exists after a sync, so this reads the SOURCE the sync copies
// from — the same path scripts/sync-web.mjs resolves.
const SHARED_UI = path.resolve(here, "..", "..", "juanfi-app", "www", "index.html");

const flatten = (tpl) => tpl.flatMap((m) => (m.submenu || []).map((i) => ({ menu: m.label, ...i })));

test("every destination is reachable and numbered in tab order", () => {
  assert.equal(DESTINATIONS.length, 8);
  const items = flatten(buildMenuTemplate(() => {})).filter((i) => i.id && i.id.startsWith("go-"));
  assert.equal(items.length, 8);
  DESTINATIONS.forEach((d, i) => {
    assert.equal(items[i].label, d.label);
    assert.equal(items[i].accelerator, "CommandOrControl+" + (i + 1));
  });
});

test("clicking a destination dispatches go with that view", () => {
  const seen = [];
  const items = flatten(buildMenuTemplate((a) => seen.push(a)));
  items.find((i) => i.id === "go-pppoe").click();
  items.find((i) => i.id === "find").click();
  items.find((i) => i.id === "reload").click();
  items.find((i) => i.id === "zoom-in").click();
  assert.deepEqual(seen, [
    { type: "go", view: "pppoe" }, { type: "find" }, { type: "reload" }, { type: "zoom", dir: 1 },
  ]);
});

test("no accelerator is bound twice and no id is reused", () => {
  const items = flatten(buildMenuTemplate(() => {}));
  const accels = items.map((i) => i.accelerator).filter(Boolean);
  assert.equal(new Set(accels).size, accels.length, "duplicate accelerator: " + accels.join(", "));
  const ids = items.map((i) => i.id).filter(Boolean);
  assert.equal(new Set(ids).size, ids.length, "duplicate id: " + ids.join(", "));
});

// ---- cross-boundary contract ----
// menu.js calls go() and names eight views that live in a file this component deliberately does not
// own. Without these, renaming a view in juanfi-app leaves the menu silently dead-ending on a
// destination that no longer exists, and nothing fails until an operator presses the key.
test("every destination the menu dispatches exists as a tab in the shared UI", () => {
  const html = readFileSync(SHARED_UI, "utf8");
  for (const d of DESTINATIONS) {
    assert.ok(html.includes(`onclick="go('${d.view}')"`), `no tab button calls go('${d.view}')`);
  }
});

test("the shared UI still defines go(), the gate, and a search input", () => {
  const html = readFileSync(SHARED_UI, "utf8");
  assert.match(html, /function go\(/, "go() is no longer a function declaration");
  assert.match(html, /id="license-gate"/, "the licence gate element was renamed");
  assert.match(html, /\$\("license-gate"\)\.classList\.remove\("hide"\)/,
    "the gate is no longer shown by removing .hide, so the menu's unlocked check is wrong");
  assert.match(html, /id="[a-z-]+-search"/, "no input id ends in -search for Ctrl+F to find");
});

test("with no panel set every destination is enabled", () => {
  const items = flatten(buildMenuTemplate(() => {})).filter((i) => i.id && i.id.startsWith("go-"));
  assert.equal(items.length, 8);
  assert.ok(items.every((i) => i.enabled !== false));
});

test("a restricted panel set disables the rest", () => {
  const items = flatten(buildMenuTemplate(() => {}, ["status", "sales"]))
    .filter((i) => i.id && i.id.startsWith("go-"));
  const on = items.filter((i) => i.enabled !== false).map((i) => i.id);
  assert.deepEqual(on, ["go-status", "go-sales"]);
});

test("an empty panel set disables every destination", () => {
  // Not the same as null. Null means "no staff configured"; empty means a session with nothing.
  const items = flatten(buildMenuTemplate(() => {}, []))
    .filter((i) => i.id && i.id.startsWith("go-"));
  assert.ok(items.every((i) => i.enabled === false));
});

test("Find and the zoom items are never disabled by a panel set", () => {
  const items = flatten(buildMenuTemplate(() => {}, []));
  const find = items.find((i) => i.id === "find");
  assert.equal(find.enabled, undefined);
  assert.ok(items.filter((i) => i.id && i.id.startsWith("zoom-")).every((i) => i.enabled === undefined));
});
