// payment_request accessor: create -> pending -> approve -> idempotent decide, plus dedupe.
// Pure persistence tests against an in-memory db; no Telegram, no router, no Electron.
import test from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../agent/store.js";
import { makePayStore, normalizeActor, actorCanClearHistory } from "../agent/pay-store.js";

const clock = { today: () => "2026-08-17" };
let seq = 0; const token = () => "tok" + (++seq);

test("create → pending → approve → idempotent", () => {
  const db = openStore(":memory:"); const s = makePayStore({ db, clock, token });
  const { id, token: tk } = s.create({ routerId: "r1", request: { account: "Juan", ref: "ABCD", amount: 100 }, customerKey: "juan01", clientIp: "10.0.0.5" });
  assert.equal(s.byToken(tk).status, "pending");
  assert.equal(s.decide(id, "approved", { messageId: "9" }).status, "approved");
  assert.equal(s.decide(id, "declined", {}).status, "approved", "already decided is a no-op");
  db.close();
});

test("dedupe rejects the same ref twice on a router", () => {
  const db = openStore(":memory:"); const s = makePayStore({ db, clock, token });
  s.create({ routerId: "r1", request: { account: "A", ref: "DUP1", amount: 1 }, customerKey: null, clientIp: "" });
  assert.throws(() => s.create({ routerId: "r1", request: { account: "B", ref: "DUP1", amount: 2 }, customerKey: null, clientIp: "" }));
  db.close();
});

test("byRef finds the pending row for a router+ref, and is scoped per router", () => {
  const db = openStore(":memory:"); const s = makePayStore({ db, clock, token });
  s.create({ routerId: "r1", request: { account: "A", ref: "REF9", amount: 50 }, customerKey: null, clientIp: "" });
  assert.equal(s.byRef("r1", "REF9").ref, "REF9");
  assert.equal(s.byRef("r2", "REF9"), null);
  assert.equal(s.byRef("r1", "NOPE"), null);
  db.close();
});

test("listPending returns only pending rows for the given router", () => {
  const db = openStore(":memory:"); const s = makePayStore({ db, clock, token });
  const a = s.create({ routerId: "r1", request: { account: "A", ref: "L1", amount: 10 }, customerKey: null, clientIp: "" });
  s.create({ routerId: "r1", request: { account: "B", ref: "L2", amount: 20 }, customerKey: null, clientIp: "" });
  s.create({ routerId: "r2", request: { account: "C", ref: "L3", amount: 30 }, customerKey: null, clientIp: "" });
  s.decide(a.id, "approved", {});
  const pending = s.listPending("r1");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].ref, "L2");
  db.close();
});

test("byId returns the row for a given id, or null when it does not exist", () => {
  const db = openStore(":memory:"); const s = makePayStore({ db, clock, token });
  const { id } = s.create({ routerId: "r1", request: { account: "A", ref: "BYID", amount: 10 }, customerKey: null, clientIp: "" });
  assert.equal(s.byId(id).ref, "BYID");
  assert.equal(s.byId(999999), null);
  db.close();
});

test("create stores purpose topup vs bill", () => {
  const db = openStore(":memory:"); const s = makePayStore({ db, clock, token });
  s.create({ routerId: "r1", request: { account: "A", ref: "T1", amount: 10 }, customerKey: "a", clientIp: "", purpose: "topup" });
  s.create({ routerId: "r1", request: { account: "B", ref: "B1", amount: 20 }, customerKey: "b", clientIp: "" });
  assert.equal(s.byRef("r1", "T1").purpose, "topup");
  assert.equal(s.byRef("r1", "B1").purpose, "bill");
  db.close();
});

test("owner maps to admin; cashier cannot clear history", () => {
  assert.deepEqual(normalizeActor({ by: "Jeff", role: "owner" }), { name: "Jeff", role: "admin" });
  assert.deepEqual(normalizeActor({ by: "Ana", role: "cashier" }), { name: "Ana", role: "cashier" });
  assert.equal(actorCanClearHistory({ by: "Jeff", role: "admin" }), true);
  assert.equal(actorCanClearHistory({ by: "Ana", role: "cashier" }), false);
});

test("decide stores who approved, listHistory lists them, clearHistory keeps pending", () => {
  const db = openStore(":memory:"); const s = makePayStore({ db, clock, token });
  const a = s.create({ routerId: "r1", request: { account: "A", ref: "H1", amount: 10 }, customerKey: "a", clientIp: "" });
  const b = s.create({ routerId: "r1", request: { account: "B", ref: "H2", amount: 20 }, customerKey: "b", clientIp: "" });
  s.decide(a.id, "approved", { by: "Jeff", role: "admin" });
  assert.equal(s.byId(a.id).decided_by, "Jeff");
  assert.equal(s.byId(a.id).decided_role, "admin");
  assert.equal(s.listHistory().length, 1);
  assert.equal(s.listPending("r1").length, 1);
  assert.equal(s.clearHistory().removed, 1);
  assert.equal(s.listHistory().length, 0);
  assert.equal(s.byId(b.id).status, "pending");
  db.close();
});

test("setMessageId stores the Telegram message id on the row", () => {
  const db = openStore(":memory:"); const s = makePayStore({ db, clock, token });
  const { id } = s.create({ routerId: "r1", request: { account: "A", ref: "MSG1", amount: 5 }, customerKey: null, clientIp: "" });
  s.setMessageId(id, "777");
  assert.equal(s.byRef("r1", "MSG1").tg_message_id, "777");
  db.close();
});
