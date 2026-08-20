// Direct unit tests for the payment-reminder wiring helpers (Task 9), against a plain
// openStore(":memory:") — no Electron, no agent host. agent-host.test.mjs covers the licence-gate
// wiring these are assembled into; this file is about the two pieces that talk to sqlite directly.
import test from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../agent/store.js";
import { makeRecordPayment, makeResolveCustomers, makeListSales } from "../main/pay-wiring.js";

function baseLedger(overrides = {}) {
  return {
    router_id: "r1", customer_key: "ana", kind: "ppp", amount: 500, at: "2026-08-17",
    method: "gcash-manual", source: "reminder", ref: "ABCD",
    ...overrides,
  };
}

// The idempotency fix carried over from Task 8's review: a Telegram retry (or a crash between
// recordPayment and payStore.decide) must not double-record the same GCash reference.
test("recordPayment is idempotent: a repeated approval of the same ref records the money at most once", () => {
  const db = openStore(":memory:");
  const recordPayment = makeRecordPayment(db);
  const ledger = baseLedger();

  recordPayment(ledger);
  recordPayment(ledger);
  recordPayment(ledger);

  const rows = db.prepare("SELECT * FROM payment WHERE router_id = ?").all("r1");
  assert.equal(rows.length, 1, "the same ref was recorded more than once");
  assert.equal(rows[0].amount, 500);
  assert.equal(rows[0].customer_key, "ana");
  assert.equal(rows[0].kind, "ppp");
  assert.equal(rows[0].method, "gcash-manual");
  assert.equal(rows[0].source, "reminder");
  assert.equal(rows[0].dedupe, "reminder:r1:ABCD");
  db.close();
});

test("recordPayment stores collected_by for sales", () => {
  const db = openStore(":memory:");
  const recordPayment = makeRecordPayment(db);
  recordPayment(baseLedger({ collected_by: "Ana" }));
  const row = db.prepare("SELECT collected_by FROM payment WHERE router_id='r1'").get();
  assert.equal(row.collected_by, "Ana");
  db.close();
});

test("recordPayment's dedupe is scoped to router+ref: the same ref on a different router is a different payment", () => {
  const db = openStore(":memory:");
  const recordPayment = makeRecordPayment(db);

  recordPayment(baseLedger({ router_id: "r1" }));
  recordPayment(baseLedger({ router_id: "r2" }));

  const rows = db.prepare("SELECT router_id, dedupe FROM payment ORDER BY router_id").all();
  assert.deepEqual(rows.map((r) => r.router_id), ["r1", "r2"]);
  assert.deepEqual(rows.map((r) => r.dedupe), ["reminder:r1:ABCD", "reminder:r2:ABCD"]);
  db.close();
});

test("recordPayment's dedupe is scoped to ref too: two different refs on one router both record", () => {
  const db = openStore(":memory:");
  const recordPayment = makeRecordPayment(db);

  recordPayment(baseLedger({ ref: "ABCD" }));
  recordPayment(baseLedger({ ref: "WXYZ" }));

  const rows = db.prepare("SELECT * FROM payment WHERE router_id = 'r1'").all();
  assert.equal(rows.length, 2);
  db.close();
});

test("listSales returns payment rows with collected_by", () => {
  const db = openStore(":memory:");
  const recordPayment = makeRecordPayment(db);
  recordPayment(baseLedger({ collected_by: "Jeff" }));
  const rows = makeListSales(db)("r1");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].collected_by, "Jeff");
  assert.equal(rows[0].amount, 500);
  db.close();
});

test("resolveCustomers reads the cached customer columns for one router only", () => {
  const db = openStore(":memory:");
  const insert = db.prepare(`
    INSERT INTO customer (router_id, kind, key, raw_comment, last_seen, name, phone, plan, price, cycle, due, paid, bal)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  insert.run("r1", "ppp", "ana", "[bill 750 2026-08-01]", "2026-08-17",
    "Ana Cruz", "0917", "Fibre 20 Mbps", 750, "monthly", "2026-09-01", "", 0);
  insert.run("r2", "ppp", "ben", "[bill 500 2026-08-01]", "2026-08-17",
    "Ben Reyes", "0918", "Home 10 Mbps", 500, "monthly", "2026-09-01", "", 0);

  const resolveCustomers = makeResolveCustomers(db);
  const r1 = resolveCustomers("r1");
  assert.equal(r1.length, 1);
  assert.equal(r1[0].key, "ana");
  assert.equal(r1[0].name, "Ana Cruz");
  assert.deepEqual(
    Object.keys(r1[0]).sort(),
    ["bal", "cycle", "due", "kind", "key", "name", "paid", "phone", "plan", "price", "raw_comment", "wallet"].sort()
  );

  assert.deepEqual(resolveCustomers("r3"), [], "an unconfigured router must not see another router's customers");
  db.close();
});
