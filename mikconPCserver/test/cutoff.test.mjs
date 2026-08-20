import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cutoffHealth, cutoffVersionOf, worstVerdict, CUTOFF_VERSION } from "../agent/cutoff.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SHARED_UI = path.resolve(here, "..", "..", "juanfi-app", "www", "index.html");

const scriptV = (v, { grace = 3, dry = false, prof = "expired" } = {}) => ({
  name: "mikcon-cutoff",
  source: [
    "# MIKCON automatic cut-off. Installed by the MIKCON app - safe to remove.",
    `# MIKCON-CUTOFF-V${v} - the app reads this line to tell an out-of-date script apart.`,
    `:local expProf "${prof}"`,
    `:local grace ${grace}`,
    `:local dry ${dry}`,
  ].join("\n"),
});
const sched = (over = {}) => ({ name: "mikcon-cutoff", interval: "1d", ...over });

// The version the agent expects must be the version the app installs. If the app ships V3 and the
// agent still expects 2, every router in the field reads as fine while running an old script.
test("CUTOFF_VERSION matches the shared UI", () => {
  const m = /var CUTOFF_VERSION=(\d+)/.exec(readFileSync(SHARED_UI, "utf8"));
  assert.ok(m, "could not find CUTOFF_VERSION in the shared UI");
  assert.equal(CUTOFF_VERSION, Number(m[1]));
});

test("no script at all is missing", () => {
  assert.equal(cutoffHealth({ script: null, scheduler: sched() }).verdict, "missing");
  assert.equal(cutoffHealth({}).verdict, "missing");
  assert.equal(cutoffHealth().verdict, "missing");
});

// No marker means it predates them - which the app documents as every router in the field today.
// A script that exists but cannot be read is therefore stale, NOT missing: both say reinstall, but
// conflating them loses the difference between nothing being there and something old being there.
test("an unmarked or unreadable script is stale, not missing", () => {
  assert.equal(cutoffVersionOf("no marker in here"), 0);
  assert.equal(cutoffHealth({ script: { source: "" }, scheduler: sched() }).verdict, "stale");
  assert.equal(cutoffHealth({ script: {}, scheduler: sched() }).verdict, "stale");
});

test("V1 is stale and V2 is current", () => {
  assert.equal(cutoffHealth({ script: scriptV(1), scheduler: sched() }).verdict, "stale");
  assert.equal(cutoffHealth({ script: scriptV(2), scheduler: sched() }).verdict, "ok");
});

// Only OLDER counts. A newer script came from a newer app, and telling an operator to downgrade
// would be worse than saying nothing.
test("a newer script is not stale", () => {
  assert.equal(cutoffHealth({ script: scriptV(3), scheduler: sched() }).verdict, "ok");
});

// A disabled entry and an absent one are one situation for the operator: it never runs.
test("no scheduler, or a disabled one, is unscheduled", () => {
  assert.equal(cutoffHealth({ script: scriptV(2), scheduler: null }).verdict, "unscheduled");
  assert.equal(cutoffHealth({ script: scriptV(2), scheduler: sched({ disabled: "true" }) }).verdict, "unscheduled");
  assert.equal(cutoffHealth({ script: scriptV(2), scheduler: sched({ disabled: "false" }) }).verdict, "ok");
});

test("a log-only script is dry", () => {
  assert.equal(cutoffHealth({ script: scriptV(2, { dry: true }), scheduler: sched() }).verdict, "dry");
});

// Stage 4's warn stage must use the grace the router actually enforces rather than one the agent
// invents, so these have to survive the verdict.
test("grace, version and the expired profile are reported alongside the verdict", () => {
  const h = cutoffHealth({ script: scriptV(2, { grace: 7, prof: "no-pay" }), scheduler: sched() });
  assert.equal(h.grace, 7);
  assert.equal(h.version, 2);
  assert.equal(h.expProfile, "no-pay");
});

test("a script with no grace line reports null rather than zero", () => {
  const h = cutoffHealth({ script: { source: "# MIKCON-CUTOFF-V2" }, scheduler: sched() });
  assert.equal(h.grace, null, "zero grace would mean cut off on the due date - never guess it");
});

// Severity order: missing beats stale beats unscheduled beats dry. The tray names the worst.
test("worstVerdict ranks by severity and ignores ok", () => {
  assert.equal(worstVerdict(["ok", "dry", "stale"]), "stale");
  assert.equal(worstVerdict(["dry", "unscheduled"]), "unscheduled");
  assert.equal(worstVerdict(["stale", "missing"]), "missing");
  assert.equal(worstVerdict(["ok", "ok"]), null);
  assert.equal(worstVerdict([]), null);
  assert.equal(worstVerdict(), null);
});
