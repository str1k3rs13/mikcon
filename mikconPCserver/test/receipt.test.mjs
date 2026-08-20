import test from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../agent/store.js";
import {
  formatReceipt, formatReceiptTelegram, makeReceiptStore, publicReceipt, receiptFromOutcome, peso,
} from "../agent/receipt.js";
import { esc } from "../agent/telegram.js";

const clock = { today: () => "2026-08-20" };

test("formatReceipt names amount due wallet and who", () => {
  const text = formatReceipt({
    code: "aabbccdd-1111", account: "Juan Dela Cruz", amount: 750,
    due: "2026-09-20", wallet: 50, method: "gcash-manual", at: "2026-08-20",
    collected_by: "Maria", ref: "GC1",
  });
  assert.match(text, /Juan Dela Cruz/);
  assert.match(text, /₱750/);
  assert.match(text, /2026-09-20/);
  assert.match(text, /₱50/);
  assert.match(text, /Maria/);
  assert.match(text, /#aabbccdd/);
});

test("receipt store is idempotent per row and looks up by code", () => {
  const db = openStore(":memory:");
  let n = 0;
  const store = makeReceiptStore({ db, clock, code: () => "code" + (++n) });
  const row = store.record({
    router_id: "r1", customer_key: "juan01", account: "Juan", amount: 750,
    due: "2026-09-20", wallet: 0, method: "gcash-manual", collected_by: "Admin",
    request_id: 9,
  });
  assert.equal(row.code, "code1");
  assert.equal(store.byCode("code1").amount, 750);
  assert.equal(store.lastForRequest(9).account, "Juan");
  assert.equal(store.lastForCustomer("r1", "juan01").code, "code1");
  assert.equal(publicReceipt(row).text.includes("Juan"), true);
  db.close();
});

test("receiptFromOutcome copies due and wallet from applyPayment", () => {
  const rec = receiptFromOutcome({
    row: { id: 3, router_id: "r1", account: "Juan", ref: "PM1", purpose: "bill" },
    customer: { key: "juan01", router_id: "r1", name: "Juan" },
    outcome: { ledger: { amount: 750, method: "gateway", source: "gateway", ref: "PM1" }, due: "2026-09-20", wallet: 10, fullyPaid: true },
    actor: { name: "PayMongo" },
    today: "2026-08-20",
  });
  assert.equal(rec.due, "2026-09-20");
  assert.equal(rec.wallet, 10);
  assert.equal(rec.amount, 750);
  assert.equal(rec.request_id, 3);
});

test("telegram receipt is escaped", () => {
  const html = formatReceiptTelegram({ code: "ab", account: "A<b>", amount: 1 }, esc);
  assert.match(html, /A&lt;b&gt;/);
  assert.doesNotMatch(html, /A<b>/);
  assert.equal(peso(1000), "₱1,000");
});
