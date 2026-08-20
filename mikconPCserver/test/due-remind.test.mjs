import test from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../agent/store.js";
import {
  daysUntil, formatRemindTelegram, makeDueRemindStore, nextReminder, PASS_CAP, stageFor,
} from "../agent/due-remind.js";
import { runDueRemindPass } from "../main/ops-remind.js";
import { SCHEMA_VERSION } from "../agent/store.js";
import { esc } from "../agent/telegram.js";

const juan = {
  router_id: "r1", key: "juan01", name: "Juan Dela Cruz",
  due: "2026-08-23", price: 750, bal: 0, wallet: 0, plan: "Fibre 20", phone: "09171234567",
};

test("daysUntil and stages are exact 3, 1, and due day", () => {
  assert.equal(daysUntil("2026-08-23", "2026-08-20"), 3);
  assert.equal(daysUntil("2026-08-21", "2026-08-20"), 1);
  assert.equal(daysUntil("2026-08-20", "2026-08-20"), 0);
  assert.equal(daysUntil("2026-08-22", "2026-08-20"), 2);
  assert.equal(stageFor(3).id, "d3");
  assert.equal(stageFor(1).id, "d1");
  assert.equal(stageFor(0).id, "due");
  assert.equal(stageFor(2), null);
  assert.equal(stageFor(-1), null);
});

test("nextReminder sends d3 then d1 then due, and stops after pay", () => {
  const first = nextReminder({ customer: juan, today: "2026-08-20", already: new Set() });
  assert.equal(first.stage, "d3");
  assert.equal(first.amount, 750);
  const skip = nextReminder({ customer: juan, today: "2026-08-20", already: new Set(["d3"]) });
  assert.equal(skip, null);
  const mid = nextReminder({ customer: { ...juan, due: "2026-08-21" }, today: "2026-08-20", already: new Set() });
  assert.equal(mid.stage, "d1");
  const due = nextReminder({ customer: { ...juan, due: "2026-08-20" }, today: "2026-08-20", already: new Set() });
  assert.equal(due.stage, "due");
  const paid = nextReminder({ customer: { ...juan, due: "2026-09-20" }, today: "2026-08-20", already: new Set() });
  assert.equal(paid, null);
  const covered = nextReminder({ customer: { ...juan, due: "2026-08-20", bal: 750 }, today: "2026-08-20", already: new Set() });
  assert.equal(covered, null);
});

test("telegram copy has no em dash and includes pay url", () => {
  const text = formatRemindTelegram(
    { name: "Juan <b>", when: "today", due: "2026-08-20", amount: 750, plan: "Fibre 20", phone: "0917" },
    { esc, payUrl: "https://pay.example/payment", site: "House" }
  );
  assert.match(text, /Bill reminder/);
  assert.match(text, /Juan &lt;b&gt;/);
  assert.match(text, /Due today \(2026-08-20\)/);
  assert.match(text, /₱750/);
  assert.match(text, /Pay at https:\/\/pay\.example\/payment/);
  assert.doesNotMatch(text, /—/);
});

test("store records once per due+stage and SCHEMA is 8", () => {
  assert.equal(SCHEMA_VERSION, 8);
  const db = openStore(":memory:");
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='due_remind'").get());
  const store = makeDueRemindStore(db);
  assert.equal(store.record({
    router_id: "r1", customer_key: "juan01", due: "2026-08-23", stage: "d3",
    amount: 750, name: "Juan", at: "2026-08-20",
  }), true);
  assert.equal(store.record({
    router_id: "r1", customer_key: "juan01", due: "2026-08-23", stage: "d3",
    amount: 750, name: "Juan", at: "2026-08-20",
  }), false);
  assert.equal(store.has("r1", "juan01", "2026-08-23", "d3"), true);
  assert.equal(store.has("r1", "juan01", "2026-08-23", "d1"), false);
  assert.equal(store.record({
    router_id: "r1", customer_key: "juan01", due: "2026-09-23", stage: "d3",
    amount: 750, name: "Juan", at: "2026-09-20",
  }), true);
  db.close();
});

test("runDueRemindPass telegrams once then skips, and skips a bad clock", async () => {
  const db = openStore(":memory:");
  const store = makeDueRemindStore(db);
  const sent = [];
  const customers = { r1: [{ ...juan }] };
  const clock = { today: () => "2026-08-20", isSane: () => true };
  const first = await runDueRemindPass({
    customers, names: { r1: "House" }, store, clock,
    sendAlert: async (t) => sent.push(t), payUrl: "http://pay.local/payment", esc,
  });
  assert.equal(first.length, 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /in 3 days/);
  const again = await runDueRemindPass({
    customers, names: { r1: "House" }, store, clock,
    sendAlert: async (t) => sent.push(t), esc,
  });
  assert.equal(again.length, 0);
  assert.equal(sent.length, 1);
  const insane = await runDueRemindPass({
    customers, names: { r1: "House" }, store,
    clock: { today: () => "1970-01-01", isSane: () => false },
    sendAlert: async (t) => sent.push(t),
  });
  assert.equal(insane.length, 0);
  db.close();
});

test("failed telegram is retried and pass cap is 40", async () => {
  const db = openStore(":memory:");
  const store = makeDueRemindStore(db);
  let boom = true;
  await runDueRemindPass({
    customers: { r1: [{ ...juan }] }, store,
    clock: { today: () => "2026-08-20", isSane: () => true },
    sendAlert: async () => { if (boom) throw new Error("down"); },
  });
  assert.equal(store.has("r1", "juan01", "2026-08-23", "d3"), false);
  boom = false;
  const ok = await runDueRemindPass({
    customers: { r1: [{ ...juan }] }, store,
    clock: { today: () => "2026-08-20", isSane: () => true },
    sendAlert: async () => {},
  });
  assert.equal(ok.length, 1);
  assert.equal(PASS_CAP, 40);
  db.close();
});
