import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openStore } from "../agent/store.js";
import { importSnapshot } from "../agent/import-legacy.js";

const db = () => openStore(path.join(mkdtempSync(path.join(tmpdir(), "mikcon-imp-")), "a.db"));

// Real ledger rows: {n,a,at,t,k}. `k` is "name|due" and names the cycle the money settled.
const SNAP = () => ({
  routers: [{ id: "r1", name: "House", address: "10.0.0.1" }],
  ledgers: {
    r1: [
      { n: "Ana", a: 500, at: "2026-07-02", t: "ppp", k: "Ana|2026-07-01" },
      { n: "Ben", a: 750, at: "2026-07-03", t: "ipoe", k: "Ben|2026-07-01" },
      // Paid two cycles in one visit — ledgerFreeKey() minted the #2.
      { n: "Ana", a: 500, at: "2026-07-02", t: "ppp", k: "Ana|2026-07-01#2" },
      // Written before keys existed: no k, and no technology either.
      { n: "Old Customer", a: 300, at: "2026-01-05", t: "", k: "" },
    ],
  },
  smslogs: {
    r1: [{ n: "Ana", to: "09171234567", at: "2026-07-01", tm: "09:15", k: "reminder", st: "sent", e: "" }],
  },
  sales: [{ d: "2026-07-01", v: 1200 }, { d: "2026-07-02", v: 1450 }],
});

const count = (d, t) => d.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;

test("a snapshot imports every row once", () => {
  const d = db();
  const n = importSnapshot(d, SNAP());
  assert.equal(n.payments, 4);
  assert.equal(n.messages, 1);
  assert.equal(n.sales, 2);
  assert.equal(count(d, "payment"), 4);
});

// THE test in this stage. The import runs on every sync; running it twice must not double a
// customer's money.
test("importing the same snapshot twice inserts nothing the second time", () => {
  const d = db();
  importSnapshot(d, SNAP());
  const second = importSnapshot(d, SNAP());
  assert.equal(second.payments, 0);
  assert.equal(second.messages, 0);
  assert.equal(count(d, "payment"), 4);
  assert.equal(count(d, "message"), 1);
});

test("covers_from is the due date the ledger key names", () => {
  const d = db();
  importSnapshot(d, SNAP());
  const ana = d.prepare("SELECT * FROM payment WHERE ledger_key = ?").get("Ana|2026-07-01");
  assert.equal(ana.covers_from, "2026-07-01");
  assert.equal(ana.covers_to, null);   // needs the cycle, which needs the parser Stage 3 adds
  assert.equal(ana.kind, "ppp");
  assert.equal(ana.source, "import");
});

test("two cycles paid at once import as two payments", () => {
  const d = db();
  importSnapshot(d, SNAP());
  const rows = d.prepare("SELECT ledger_key, covers_from FROM payment WHERE customer_key = ? ORDER BY ledger_key")
    .all("Ana");
  assert.deepEqual(rows.map((r) => r.ledger_key), ["Ana|2026-07-01", "Ana|2026-07-01#2"]);
  // The #2 suffix names a second CYCLE settled in one visit, not a second calendar date — both
  // rows cover the cycle due 2026-07-01. Losing the suffix strip would make this null.
  assert.equal(rows[1].covers_from, "2026-07-01");
});

// The database accumulates forever; the app's ledger does not. Once "Ana|2026-07-01" is
// evicted from the 500-row cap, ledgerFreeKey() is free to re-mint that exact key for a
// genuinely new payment months later. Only the record date tells the two apart — dedupe on
// the key alone would read real money collected as a duplicate and drop it.
test("a recurring ledger key with a new record date imports as a new payment, not a duplicate", () => {
  const d = db();
  importSnapshot(d, SNAP());   // seeds "Ana|2026-07-01" recorded 2026-07-02
  const recur = SNAP();
  recur.ledgers.r1 = [{ n: "Ana", a: 500, at: "2026-08-02", t: "ppp", k: "Ana|2026-07-01" }];

  const n = importSnapshot(d, recur);
  assert.equal(n.payments, 1);
  assert.equal(count(d, "payment"), 5);

  const again = importSnapshot(d, recur);
  assert.equal(again.payments, 0);
  assert.equal(count(d, "payment"), 5);
});

// The renderer's own comment says a keyless row "could be either" technology. The database
// records that uncertainty rather than resolving it arbitrarily.
test("a row written before keys existed imports as unknown, never guessed", () => {
  const d = db();
  importSnapshot(d, SNAP());
  const old = d.prepare("SELECT * FROM payment WHERE customer_key = ?").get("Old Customer");
  assert.equal(old.ledger_key, null);
  assert.equal(old.covers_from, null);
  assert.equal(old.kind, null);
  assert.equal(old.amount, 300);
});

// The ledger is capped at 500 and shifts the oldest off. A shortened snapshot must not
// re-insert the survivors as new rows. This has to exercise the KEYLESS occurrence index —
// a keyed row's dedupe has no positional component and is stable under eviction by
// construction, so slicing one off (as an earlier version of this test did) proves nothing
// about the machinery withOccurrence exists for. Two identical keyless twins up front, plus
// another keyless row (SNAP's "Old Customer") elsewhere in the array, is the shape that
// actually distinguishes a per-content occurrence counter from an absolute array index: an
// index-based scheme would re-mint "Old Customer"'s dedupe once the twin count in front of it
// changes, and insert it a second time.
test("a row falling off the 500-row cap creates no duplicate", () => {
  const d = db();
  const twin = { n: "Cap Twin", a: 200, at: "2026-03-01", t: "", k: "" };
  const full = SNAP();
  full.ledgers.r1 = [twin, { ...twin }, ...full.ledgers.r1];
  importSnapshot(d, full);
  assert.equal(count(d, "payment"), 6);   // SNAP()'s 4 plus both twins

  const trimmed = SNAP();
  trimmed.ledgers.r1 = [{ ...twin }, ...trimmed.ledgers.r1];   // one twin shifted off the cap
  const again = importSnapshot(d, trimmed);
  assert.equal(again.payments, 0);
  assert.equal(count(d, "payment"), 6);
});

// Two genuinely identical keyless payments are two payments, not a double tap.
test("identical keyless rows import as separate payments", () => {
  const d = db();
  const snap = SNAP();
  const twin = { n: "Twin", a: 100, at: "2026-02-02", t: "", k: "" };
  snap.ledgers.r1 = [twin, { ...twin }];
  const n = importSnapshot(d, snap);
  assert.equal(n.payments, 2);
  assert.equal(importSnapshot(d, snap).payments, 0);   // and still idempotent
});

test("sales upserts on the day, last value winning", () => {
  const d = db();
  importSnapshot(d, SNAP());
  const later = SNAP();
  later.sales = [{ d: "2026-07-02", v: 1600 }];
  importSnapshot(d, later);
  assert.equal(d.prepare("SELECT v FROM sales_daily WHERE d = ?").get("2026-07-02").v, 1600);
  assert.equal(count(d, "sales_daily"), 2);
});

test("the sms log imports with its state and its failure reason", () => {
  const d = db();
  const snap = SNAP();
  snap.smslogs.r1.push(
    { n: "Ben", to: "09998887777", at: "2026-07-01", tm: "09:16", k: "reminder", st: "failed", e: "no signal" });
  importSnapshot(d, snap);
  const bad = d.prepare("SELECT * FROM message WHERE state = ?").get("failed");
  assert.equal(bad.error, "no signal");
  assert.equal(bad.customer, "Ben");
  assert.equal(bad.at_time, "09:16");
});

test("routers import and re-importing refreshes last_seen without duplicating", () => {
  const d = db();
  importSnapshot(d, SNAP());
  importSnapshot(d, SNAP());
  assert.equal(count(d, "router"), 1);
  assert.equal(d.prepare("SELECT name FROM router WHERE id = ?").get("r1").name, "House");
});

// A snapshot for a router with no history at all must not throw.
test("an empty snapshot is a no-op", () => {
  const d = db();
  const n = importSnapshot(d, { routers: [], ledgers: {}, smslogs: {}, sales: [] });
  assert.deepEqual(n, { routers: 0, payments: 0, messages: 0, sales: 0 });
});

// localStorage is the authority. A malformed snapshot must never take the agent down — and
// "malformed" must actually get dropped, not silently coerced into a real row. Number("") and
// Number("   ") are 0, which is finite: a naive filter lets a blank amount import as a real ₱0
// payment against a real customer. A blank `at` is just as dangerous the other way — it would
// import fine but vanish from any `WHERE at BETWEEN` report while still hitting SUM(amount).
test("malformed rows are skipped, not thrown on", () => {
  const d = db();
  const snap = SNAP();
  snap.ledgers.r1.push(
    null,
    { n: "", a: "abc", at: "", t: "ppp", k: "" },
    { n: "Blank Amount", a: "", at: "2026-05-05", t: "ppp", k: "" },
    { n: "Whitespace Amount", a: "   ", at: "2026-05-05", t: "ppp", k: "" },
    { n: "No Date", a: 100, at: "", t: "ppp", k: "" });
  let n;
  assert.doesNotThrow(() => { n = importSnapshot(d, snap); });
  // Only SNAP()'s four legitimate rows import; every malformed addition above is dropped. If the
  // amount/date filter regresses to "just don't throw," this count moves and the test catches it.
  assert.equal(n.payments, 4);
  assert.equal(count(d, "payment"), 4);
});
