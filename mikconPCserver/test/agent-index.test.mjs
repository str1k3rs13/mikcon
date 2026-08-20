import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openStore } from "../agent/store.js";
import { makeClock } from "../agent/clock.js";
import { createAgent } from "../agent/index.js";

const db = () => openStore(path.join(mkdtempSync(path.join(tmpdir(), "mikcon-idx-")), "a.db"));
const clock = makeClock(() => new Date("2026-08-08T10:00:00"));
const SNAP = {
  routers: [{ id: "r1", name: "House", address: "10.0.0.1" }],
  ledgers: { r1: [{ n: "Ana", a: 500, at: "2026-07-02", t: "ppp", k: "Ana|2026-07-01" }] },
  smslogs: {}, sales: [],
};

test("sync imports a snapshot and reports what it inserted", () => {
  const d = db();
  const agent = createAgent({ db: d, client: async () => [], clock });
  assert.equal(agent.sync(SNAP).payments, 1);
  assert.equal(agent.sync(SNAP).payments, 0);
});

test("poll delegates to the poller and returns its result", async () => {
  const d = db();
  const agent = createAgent({
    db: d, clock,
    client: async (o) => (o.cmd === "/ppp/secret/print" ? [{ name: "ana", comment: "[bill p=500]" }] : []),
  });
  const res = await agent.poll([{ id: "r1", host: "10.0.0.1", port: 8728, user: "a", pass: "b" }]);
  assert.deepEqual(res.ok, ["r1"]);
  assert.equal(d.prepare("SELECT COUNT(*) c FROM customer").get().c, 1);
});

// A bad snapshot from the renderer must never take the agent down with it — localStorage is
// the authority and the app must keep working even if the mirror cannot.
test("a malformed snapshot is survivable", () => {
  const d = db();
  const agent = createAgent({ db: d, client: async () => [], clock });
  assert.doesNotThrow(() => agent.sync(null));
  assert.doesNotThrow(() => agent.sync({ ledgers: { r1: null } }));
});

test("an agent whose clock is insane refuses to sync", () => {
  const d = db();
  const dead = makeClock(() => new Date("1970-01-01T00:00:00"));
  const agent = createAgent({ db: d, client: async () => [], clock: dead });
  assert.throws(() => agent.sync(SNAP), /clock/i);
});
