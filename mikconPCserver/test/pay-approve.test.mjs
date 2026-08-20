import test from "node:test";
import assert from "node:assert/strict";
import { applyApproval, applyTopup, applyPayment, isNotDue, reconnectSpec } from "../agent/pay-approve.js";

const base = { kind: "ppp", key: "juan01", name: "Juan", price: 1000, cycle: "monthly",
  due: "2026-08-30", paid: "2026-07-30", bal: 0, plan: "Fiber 50", raw_comment: "Juan [bill p=1000 c=monthly due=2026-08-30 paid=2026-07-30 plan=Fiber 50]", address: "" };

test("a full payment advances due one cycle and clears bal", () => {
  const out = applyApproval({ request: { ref: "GC1", amount: 1000, account: "Juan" }, customer: base, today: "2026-08-17" });
  assert.equal(out.fullyPaid, true);
  assert.match(out.comment, /due=2026-09-30/);
  assert.doesNotMatch(out.comment, /bal=/);
  assert.match(out.comment, /paid=2026-08-17/);
  assert.deepEqual(out.reconnect, { kind: "ppp", key: "juan01", address: "", profile: "Fiber 50" });
  assert.equal(out.ledger.amount, 1000);
  assert.equal(out.ledger.method, "gcash-manual");
  assert.equal(out.due, "2026-09-30");
});

test("a partial payment bumps bal, keeps due, still reconnects", () => {
  const out = applyApproval({ request: { ref: "GC2", amount: 400, account: "Juan" }, customer: base, today: "2026-08-17" });
  assert.equal(out.fullyPaid, false);
  assert.match(out.comment, /bal=400/);
  assert.match(out.comment, /due=2026-08-30/);   // unchanged
  assert.equal(out.reconnect.profile, "Fiber 50");
});

test("a second partial that reaches the price advances and clears", () => {
  const c = { ...base, bal: 700 };
  const out = applyApproval({ request: { ref: "GC3", amount: 300, account: "Juan" }, customer: c, today: "2026-08-17" });
  assert.equal(out.fullyPaid, true);
  assert.match(out.comment, /due=2026-09-30/);
  assert.doesNotMatch(out.comment, /bal=/);
});

test("paying the bill keeps an existing wallet", () => {
  const c = {
    ...base,
    wallet: 500,
    raw_comment: "Juan [bill p=1000 c=monthly due=2026-08-30 paid=2026-07-30 w=500 plan=Fiber 50]",
  };
  const out = applyApproval({ request: { ref: "GCW", amount: 1000, account: "Juan" }, customer: c, today: "2026-08-17" });
  assert.equal(out.fullyPaid, true);
  assert.match(out.comment, /w=500/);
});

test("applyTopup adds to the wallet and does not move due", () => {
  const out = applyTopup({
    request: { ref: "GC5", amount: 1500, account: "Juan" },
    customer: base,
    today: "2026-08-17",
  });
  assert.match(out.comment, /w=1500/);
  assert.match(out.comment, /due=2026-08-30/);
  assert.equal(out.ledger.method, "topup");
  assert.equal(out.ledger.source, "self-pay");
  assert.equal(out.ledger.kind, "ppp");
  assert.equal(out.wallet, 1500);
  assert.equal(out.fullyPaid, false);
});

test("gateway refs record paymongo or xendit as the method", () => {
  const pm = applyApproval({ request: { ref: "PMabc123def456", amount: 1000, account: "Juan" }, customer: base, today: "2026-08-17" });
  assert.equal(pm.ledger.method, "paymongo");
  assert.equal(pm.ledger.source, "gateway");
  const xn = applyTopup({ request: { ref: "XNabc123def456", amount: 200, account: "Juan" }, customer: base, today: "2026-08-17" });
  assert.equal(xn.ledger.method, "xendit");
  assert.equal(xn.ledger.source, "gateway");
});

test("isNotDue is only true when the due date is after today", () => {
  assert.equal(isNotDue({ due: "2026-08-30", today: "2026-08-17" }), true);
  assert.equal(isNotDue({ due: "2026-08-17", today: "2026-08-17" }), false);
  assert.equal(isNotDue({ due: "2026-08-01", today: "2026-08-17" }), false);
  assert.equal(isNotDue({ due: "", today: "2026-08-17" }), false);
});

test("a bill paid before the due date goes to the wallet", () => {
  const out = applyPayment({
    request: { ref: "ADV1", amount: 1000, account: "Juan", purpose: "bill" },
    customer: base,
    today: "2026-08-17",
  });
  assert.match(out.comment, /w=1000/);
  assert.match(out.comment, /due=2026-08-30/);
  assert.equal(out.wallet, 1000);
  assert.equal(out.shouldReconnect, true);
  assert.equal(out.enoughWallet, true);
  assert.equal(out.fullyPaid, false);
});

test("an advance payment below the price stays in the wallet and does not reconnect", () => {
  const out = applyPayment({
    request: { ref: "ADV2", amount: 200, account: "Juan", purpose: "bill" },
    customer: base,
    today: "2026-08-17",
  });
  assert.match(out.comment, /w=200/);
  assert.match(out.comment, /due=2026-08-30/);
  assert.equal(out.shouldReconnect, false);
  assert.equal(out.enoughWallet, false);
});

test("a due bill still pays the cycle, not the wallet", () => {
  const out = applyPayment({
    request: { ref: "DUE1", amount: 1000, account: "Juan", purpose: "bill" },
    customer: base,
    today: "2026-08-30",
  });
  assert.equal(out.fullyPaid, true);
  assert.match(out.comment, /due=2026-09-30/);
  assert.doesNotMatch(out.comment, /w=/);
  assert.equal(out.shouldReconnect, true);
});

test("a topup on a due bill spends the wallet and reconnects", () => {
  const out = applyPayment({
    request: { ref: "TOP1", amount: 1000, account: "Juan", purpose: "topup" },
    customer: { ...base, due: "2026-08-17", raw_comment: "Juan [bill p=1000 c=monthly due=2026-08-17 plan=Fiber 50]" },
    today: "2026-08-17",
  });
  assert.equal(out.fullyPaid, true);
  assert.equal(out.shouldReconnect, true);
  assert.match(out.comment, /due=2026-09-17/);
  assert.doesNotMatch(out.comment, /w=/);
});

test("an ipoe customer reconnects by address", () => {
  const c = { ...base, kind: "ipoe", key: "172.20.0.9", address: "172.20.0.9" };
  const out = applyApproval({ request: { ref: "GC4", amount: 1000, account: "Juan" }, customer: c, today: "2026-08-30" });
  assert.deepEqual(out.reconnect, { kind: "ipoe", key: "172.20.0.9", address: "172.20.0.9", profile: "Fiber 50" });
});

test("an ipoe advance payment goes to the wallet and reconnects when it covers the price", () => {
  const c = { ...base, kind: "ipoe", key: "AA:BB:CC:00:00:21" };
  const out = applyPayment({
    request: { ref: "IPW1", amount: 1000, account: "Juan", purpose: "bill" },
    customer: c,
    today: "2026-08-17",
  });
  assert.equal(out.reconnect.kind, "ipoe");
  assert.equal(out.reconnect.address, "AA:BB:CC:00:00:21");
  assert.equal(out.wallet, 1000);
  assert.equal(out.shouldReconnect, true);
  assert.match(out.comment, /w=1000/);
  assert.match(out.comment, /due=2026-08-30/);
});

test("reconnectSpec is ipoe for a MAC or an IP key", () => {
  assert.deepEqual(reconnectSpec({ kind: "ipoe", key: "AA:BB:CC:00:00:21", plan: "Home" }), {
    kind: "ipoe", key: "AA:BB:CC:00:00:21", address: "AA:BB:CC:00:00:21", profile: "Home",
  });
  assert.deepEqual(reconnectSpec({ kind: "ipoe", key: "10.0.0.31", plan: "Biz" }), {
    kind: "ipoe", key: "10.0.0.31", address: "10.0.0.31", profile: "Biz",
  });
  assert.equal(reconnectSpec({ kind: "ppp", key: "juan01", plan: "Fiber 50" }).kind, "ppp");
});
