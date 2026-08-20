import test from "node:test";
import assert from "node:assert/strict";
import { computeRenewal } from "../agent/wallet-renew.js";

test("no renewal when the wallet is below one cycle's price", () => {
  const r = computeRenewal({ due: "2026-08-18", wallet: 700, price: 750, cycle: "monthly", today: "2026-08-18" });
  assert.deepEqual(r, { rounds: 0, newDue: "2026-08-18", newWallet: 700 });
});
test("renews one cycle when due today and credit covers exactly one", () => {
  const r = computeRenewal({ due: "2026-08-18", wallet: 750, price: 750, cycle: "monthly", today: "2026-08-18" });
  assert.equal(r.rounds, 1); assert.equal(r.newWallet, 0); assert.equal(r.newDue, "2026-09-18");
});
test("catches up multiple overdue cycles while credit lasts", () => {
  // due two months ago, wallet covers 2 cycles, advances past today
  const r = computeRenewal({ due: "2026-06-18", wallet: 1600, price: 750, cycle: "monthly", today: "2026-08-01" });
  assert.equal(r.rounds, 2); assert.equal(r.newWallet, 100); assert.equal(r.newDue, "2026-08-18");
});
test("stops at today even if credit remains", () => {
  const r = computeRenewal({ due: "2026-08-10", wallet: 10000, price: 750, cycle: "monthly", today: "2026-08-18" });
  assert.equal(r.rounds, 1); assert.equal(r.newDue, "2026-09-10");
});
test("price <= 0 never renews", () => {
  const r = computeRenewal({ due: "2026-08-18", wallet: 500, price: 0, cycle: "monthly", today: "2026-08-18" });
  assert.equal(r.rounds, 0);
});
test("cap bounds a runaway stale date", () => {
  const r = computeRenewal({ due: "2000-01-01", wallet: 1e9, price: 1, cycle: "monthly", today: "2026-08-18", cap: 5 });
  assert.equal(r.rounds, 5);
});
test("a wallet that cannot reach today renews as far as it covers and stays overdue", () => {
  const r = computeRenewal({ due: "2024-01-01", wallet: 800, price: 750, cycle: "monthly", today: "2026-08-18" });
  assert.equal(r.rounds, 1);
  assert.equal(r.newWallet, 50);
  assert.equal(r.newDue, "2024-02-01");   // still far before today — the customer remains overdue by design
});
