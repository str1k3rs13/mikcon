// billComment/addCycle are PORTS from juanfi-app/www/index.html, not reimplementations. That file
// is shared with the Android app and is never edited by this series, and agent/ is plain Node that
// cannot import from it - so the choice was to copy it and keep the copy honest with a test.
//
// This extracts the REAL billComment (and its normPhone dependency) as source text, evaluates it,
// and runs both over the same corpus. A divergence fails the build instead of mis-billing a
// customer or mis-formatting the tag the router-side app later re-parses with parseBill.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { billComment as port, addCycle } from "../agent/billing.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// app/www is gitignored and only exists after a sync, so this reads the SOURCE the sync copies
// from - the same path test/billing-parity.test.mjs resolves.
const SHARED_UI = path.resolve(here, "..", "..", "juanfi-app", "www", "index.html");
const html = readFileSync(SHARED_UI, "utf8");

const slice = (a, b) => {
  const i = html.indexOf(a), j = html.indexOf(b);
  return html.slice(i, j);
};

// Pulls the real billComment plus everything declared between normPhone and billComment - a few
// unrelated SMS helper functions and two benign `var`s (the GSM7 regex, SMS_TPL_DEFAULT). Those
// are harmless declarations in this sandbox; billComment only ever calls normPhone. The closing
// anchor is the comment immediately after billComment's closing brace.
const real = new Function(
  slice("function normPhone", "function billComment") + "\n" +
  slice("function billComment", "\n// Which profile means") +
  "\n; return billComment;"
)();

// An extractor that silently matched nothing would make every assertion below pass vacuously -
// prove the extracted code WORKS before trusting a comparison against it.
test("the extracted billComment is real and behaves", () => {
  const got = real("", { price: 500, cycle: "monthly" });
  assert.equal(got, "[bill p=500 c=monthly]");
});

const corpus = [
  ["Juan", { price: 750, cycle: "monthly", due: "2026-08-30", phone: "09171234567" }],
  ["Ana", { price: 500, cycle: "15d", due: "2026-08-20", paid: "2026-08-05", bal: 200, plan: "Fiber 50 Mbps" }],
  ["", { price: 0 }],
  ["note only", { price: 0 }],
  ["Bal", { price: 999, cycle: "weekly", bal: 0, plan: "[weird]name" }],
  // phone shapes normPhone must fold to the same "0917..." form.
  ["Phone shapes", { price: 500, phone: "+639171234567" }],
  ["Phone shapes 2", { price: 500, phone: "639171234567" }],
  ["Not a mobile", { price: 500, phone: "0221234567" }],
  ["Junk phone", { price: 500, phone: "abc" }],
  [null, { price: 0 }],
  [undefined, { price: 500, cycle: "monthly" }],
  ["No note", { price: 500, due: "2026-09-30", paid: "2026-08-30", bal: 100.5, plan: "Home Plan 999" }],
  // wallet round-trips and sits before plan
  ["Ana", { price: 750, cycle: "monthly", due: "2026-09-18", paid: "2026-08-18", bal: 0, wallet: 1500, plan: "Fibre 20" }],
  // wallet omitted when zero (byte-identical to today)
  ["", { price: 600, cycle: "monthly", wallet: 0, plan: "Home 10" }],
];

test("billComment port matches the page over the corpus", () => {
  for (const [note, b] of corpus) {
    assert.equal(port(note, b), real(note, b), JSON.stringify([note, b]));
  }
});

test("addCycle advances each cycle", () => {
  assert.equal(addCycle("2026-01-31", "monthly"), "2026-02-28");
  assert.equal(addCycle("2026-08-30", "monthly"), "2026-09-30");
  assert.equal(addCycle("2026-12-15", "monthly"), "2027-01-15");
  assert.equal(addCycle("2026-08-20", "15d"), "2026-09-04");
  assert.equal(addCycle("2026-08-20", "weekly"), "2026-08-27");
});
