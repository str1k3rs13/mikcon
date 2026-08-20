// The agent parses the [bill ...] tag with its own copy of parseBill, because the original lives
// inside juanfi-app/www/index.html - the file the Android app also loads, which no plan in this
// series edits - and agent/ is plain Node that cannot import it.
//
// Two copies of a money parser is a liability unless something keeps them honest. This extracts the
// REAL function as source text, evaluates it, and runs both over the same corpus. A divergence
// fails the build instead of mis-billing a customer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseBill } from "../agent/billing.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// app/www is gitignored and only exists after a sync, so this reads the SOURCE the sync copies
// from - the same path test/menu.test.mjs resolves.
const SHARED_UI = path.resolve(here, "..", "..", "juanfi-app", "www", "index.html");

// Brace-matched extraction. Every { in parseBill's body is a balanced regex quantifier - \d{4},
// [0-9]{7,15} - so naive counting is correct here. It is still only a heuristic, which is why the
// behavioural guard below matters more than the extraction does.
function extractFunction(src, name) {
  const start = src.indexOf("function " + name + "(");
  if (start < 0) return null;
  const open = src.indexOf("{", start);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  return null;
}

function loadTheirs() {
  const src = readFileSync(SHARED_UI, "utf8");
  const re = /var BILL_RE=[^\n]+/.exec(src);
  const fn = extractFunction(src, "parseBill");
  assert.ok(re, "could not find BILL_RE in the shared UI - the extractor needs updating");
  assert.ok(fn, "could not find parseBill in the shared UI - the extractor needs updating");
  return new Function(`${re[0]}\n${fn}\nreturn parseBill;`)();
}

// An extractor that silently matched nothing would make every assertion below it pass vacuously.
// This repo has already shipped a check that passed because it matched nothing, which is why
// packaging.test.mjs carries its own "the walk is broken" guard. Prove the extracted code WORKS
// before trusting any comparison against it.
test("the extracted parser is real and behaves", () => {
  const theirs = loadTheirs();
  const got = theirs("[bill p=500 c=monthly due=2026-09-01]");
  assert.equal(got.price, 500, "the extracted parseBill did not parse a known tag");
  assert.equal(got.cycle, "monthly");
  assert.equal(got.due, "2026-09-01");
});

// Every case here is a behaviour a careless port loses. bal= clamps at 0 because the tag is
// hand-editable on the router and a negative balance would invent money nobody paid. plan= is
// greedy to the end because profile names contain spaces - which is why ph= and bal= must be read
// BEFORE it. note is the comment with the tag removed, so human text survives on both sides.
const CORPUS = [
  "",
  null,
  undefined,
  "no tag here at all",
  "[bill]",
  "[bill ]",
  "[bill p=500]",
  "[bill p=500.50 c=weekly due=2026-09-01 paid=2026-08-01]",
  "[bill p=750 c=15d due=2026-12-31]",
  "[bill c=monthly]",
  "[bill c=fortnightly]",
  "[bill bal=200 p=500]",
  "[bill bal=-50 p=500]",
  "[bill bal=abc p=500]",
  "[bill p=500 ph=09171234567]",
  "[bill p=500 ph=+639171234567]",
  "[bill p=500 ph=0917]",
  "[bill p=500 plan=Fibre 20 Mbps]",
  "[bill p=500 plan=Fibre 20 Mbps ph=09171234567]",
  "[bill p=500 ph=09171234567 plan=Fibre 20 Mbps]",
  "[bill p=500 bal=100 plan=Home Plan 999]",
  "Ana Cruz [bill p=500 due=2026-09-01] house 4",
  "  [bill p=500]  ",
  "[bill due=2026-13-45]",
  "[bill due=26-09-01]",
  "[bill p=]",
  "[bill garbage in here]",
  "[bill p=500][bill p=999]",
  "prefix only [bill",
  "[bill p=1000000 c=monthly due=2030-01-01 paid=2029-12-01 ph=09998887777 bal=999 plan=Enterprise A B C]",
  "Ben [bill p=600 c=monthly due=2026-09-05 bal=100 w=250 plan=Home 10]",
];

test("the ported parser agrees with the shared UI on every tag in the corpus", () => {
  const theirs = loadTheirs();
  for (const tag of CORPUS) {
    assert.deepEqual(parseBill(tag), theirs(tag), `divergence on: ${JSON.stringify(tag)}`);
  }
});

// deepEqual passes when both sides are equally wrong about a key being absent, so the SHAPE is
// pinned separately: phone and plan must be absent, not empty string, when the tag omits them.
test("phone and plan are absent rather than empty when the tag omits them", () => {
  const b = parseBill("[bill p=500]");
  assert.equal("phone" in b, false);
  assert.equal("plan" in b, false);
  assert.deepEqual(Object.keys(b).sort(), ["bal", "cycle", "due", "note", "paid", "price", "wallet"]);
});

// wallet parses correctly and matches both the agent and shared UI
test("wallet parses to 250 on both the agent and shared UI parseBill", () => {
  const theirs = loadTheirs();
  const tag = "Ben [bill p=600 c=monthly due=2026-09-05 bal=100 w=250 plan=Home 10]";
  assert.equal(parseBill(tag).wallet, 250, "agent parseBill did not extract wallet");
  assert.equal(theirs(tag).wallet, 250, "shared UI parseBill did not extract wallet");
});
