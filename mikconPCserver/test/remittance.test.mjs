import test from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../agent/store.js";
import { classifyMethod, makeRemittanceStore, shortage, summarizeDay } from "../agent/remittance.js";

const clock = { today: () => "2026-08-20" };

test("cash vs digital vs wallet split", () => {
  assert.equal(classifyMethod("cash", "app"), "cash");
  assert.equal(classifyMethod("collect", ""), "cash");
  assert.equal(classifyMethod("gcash-manual", "reminder"), "digital");
  assert.equal(classifyMethod("wallet", "wallet-renew"), "wallet");
  assert.equal(classifyMethod("", "wallet-renew"), "wallet");
});

test("summarizeDay only this collector today", () => {
  const sum = summarizeDay([
    { at: "2026-08-20", collected_by: "Maria", method: "cash", amount: 500 },
    { at: "2026-08-20", collected_by: "Maria", method: "gcash-manual", amount: 750 },
    { at: "2026-08-20", collected_by: "Jose", method: "cash", amount: 100 },
    { at: "2026-08-19", collected_by: "Maria", method: "cash", amount: 999 },
    { at: "2026-08-20", collected_by: "Maria", method: "wallet", source: "wallet-renew", amount: 600 },
  ], { day: "2026-08-20", collector: "Maria" });
  assert.equal(sum.cash, 500);
  assert.equal(sum.digital, 750);
  assert.equal(sum.wallet, 600);
  assert.equal(sum.count, 3);
});

test("one close per collector per day and shortage", () => {
  const db = openStore(":memory:");
  const store = makeRemittanceStore({ db, clock });
  const first = store.closeDay({
    collector: "Maria", role: "cashier", cash: 500, digital: 750, wallet: 0, cashCounted: 480,
  });
  assert.equal(first.ok, true);
  assert.equal(first.row.short, 20);
  const again = store.closeDay({
    collector: "Maria", role: "cashier", cash: 500, digital: 0, wallet: 0, cashCounted: 500,
  });
  assert.equal(again.ok, false);
  assert.match(again.error, /Already closed/);
  const admin = store.list({ name: "Jeff", role: "admin" });
  assert.equal(admin.length, 1);
  const mine = store.list({ name: "Jose", role: "cashier" });
  assert.equal(mine.length, 0);
  assert.equal(shortage(500, 480), 20);
  db.close();
});
