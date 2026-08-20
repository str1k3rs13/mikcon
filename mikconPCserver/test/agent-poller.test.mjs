import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openStore } from "../agent/store.js";
import { makeClock } from "../agent/clock.js";
import { pollAll, QUEUE_FIELDS } from "../agent/poller.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SHARED_UI = path.resolve(here, "..", "..", "juanfi-app", "www", "index.html");

const db = () => openStore(path.join(mkdtempSync(path.join(tmpdir(), "mikcon-poll-")), "a.db"));
const clock = makeClock(() => new Date("2026-08-08T10:00:00"));

const ROUTERS = [
  { id: "r1", name: "House", host: "10.0.0.1", port: 8728, user: "admin", pass: "x" },
  { id: "r2", name: "Shop", host: "10.0.0.2", port: 8728, user: "admin", pass: "y" },
];

// Mirrors main/routeros.js exec(): takes one options object, resolves an array of rows.
function fakeClient(byHostAndCmd, calls = []) {
  return async (o) => {
    calls.push(o);
    const key = `${o.host} ${o.cmd}`;
    const v = byHostAndCmd[key];
    if (v instanceof Error) throw v;
    return v || [];
  };
}

test("both routers are cached, keyed by router and technology", async () => {
  const d = db();
  const client = fakeClient({
    "10.0.0.1 /ppp/secret/print": [{ name: "ana", comment: "[bill p=500 d=2026-09-01]" }],
    "10.0.0.1 /ip/dhcp-server/lease/print": [{ "mac-address": "AA:BB:CC:DD:EE:FF", comment: "[bill p=750]" }],
    "10.0.0.2 /ppp/secret/print": [{ name: "ben", comment: "[bill p=300]" }],
    "10.0.0.2 /ip/dhcp-server/lease/print": [],
  });
  const res = await pollAll({ db: d, client, routers: ROUTERS, clock });
  assert.deepEqual(res.ok, ["r1", "r2"]);
  assert.deepEqual(res.failed, []);
  assert.equal(d.prepare("SELECT COUNT(*) c FROM customer").get().c, 3);

  const ana = d.prepare("SELECT * FROM customer WHERE router_id=? AND kind=? AND key=?").get("r1", "ppp", "ana");
  assert.equal(ana.raw_comment, "[bill p=500 d=2026-09-01]");
  assert.equal(ana.last_seen, "2026-08-08");
});

// Superseded deliberately by Stage 3. This test used to assert the parsed columns did NOT exist,
// which was right while parsing was deferred. What must stay true is the part that was always the
// point: the tag is kept verbatim beside the parsed fields, so a parser bug is diagnosable from the
// database instead of only reproducible from the router.
test("the bill tag is stored verbatim AND parsed beside it", async () => {
  const d = db();
  const client = fakeClient({
    "10.0.0.1 /ppp/secret/print": [{ name: "ana", comment: "Ana [bill p=500 due=2026-09-01 ph=09171234567]" }],
    "10.0.0.1 /ip/dhcp-server/lease/print": [],
    "10.0.0.1 /queue/simple/print": [],
  });
  await pollAll({ db: d, client, routers: [ROUTERS[0]], clock });
  const row = d.prepare("SELECT * FROM customer WHERE key='ana'").get();
  assert.equal(row.raw_comment, "Ana [bill p=500 due=2026-09-01 ph=09171234567]");
  assert.equal(row.price, 500);
  assert.equal(row.due, "2026-09-01");
  assert.equal(row.phone, "09171234567");
  assert.equal(row.name, "Ana");
  assert.equal(row.src, "secret");
});

// A PC on a bad link must still record what it could reach. One unreachable router silently
// aborting the pass would leave the other routers' data stale with no sign of why.
test("a router that throws does not abort the others", async () => {
  const d = db();
  const client = fakeClient({
    "10.0.0.1 /ppp/secret/print": new Error("connection timed out"),
    "10.0.0.2 /ppp/secret/print": [{ name: "ben", comment: "" }],
    "10.0.0.2 /ip/dhcp-server/lease/print": [],
  });
  const res = await pollAll({ db: d, client, routers: ROUTERS, clock });
  assert.deepEqual(res.ok, ["r2"]);
  assert.equal(res.failed.length, 1);
  assert.equal(res.failed[0].id, "r1");
  assert.match(res.failed[0].error, /timed out/);
  assert.equal(d.prepare("SELECT COUNT(*) c FROM customer").get().c, 1);
});

// Superseded deliberately by Stage 3: the queue read now sends a .proplist. The rule that matters
// is unchanged and is asserted more precisely than before - every command is a /print, and the only
// attribute ever sent is .proplist, which narrows a read and cannot mutate anything.
test("the poller issues no write commands", async () => {
  const d = db();
  const calls = [];
  const client = fakeClient({
    "10.0.0.1 /ppp/secret/print": [{ name: "ana", comment: "" }],
    "10.0.0.1 /ip/dhcp-server/lease/print": [],
    "10.0.0.1 /queue/simple/print": [],
  }, calls);
  await pollAll({ db: d, client, routers: [ROUTERS[0]], clock });
  assert.ok(calls.length > 0, "the fake client was never called");
  for (const c of calls) {
    assert.match(c.cmd, /\/print$/, `${c.cmd} is not a read`);
    for (const k of Object.keys(c.attrs || {})) {
      assert.equal(k, ".proplist", `${c.cmd} sent attr ${k}, which is not a read directive`);
    }
  }
});

// The money is incomplete without queues: a statically-addressed customer has no DHCP lease and is
// billed off a simple queue instead.
test("a static billed queue becomes a customer", async () => {
  const d = db();
  const client = fakeClient({
    "10.0.0.1 /ppp/secret/print": [],
    "10.0.0.1 /ip/dhcp-server/lease/print": [],
    "10.0.0.1 /queue/simple/print": [
      { name: "shop", target: "10.0.0.50/32", comment: "[bill p=1200]", dynamic: "false" },
    ],
  });
  await pollAll({ db: d, client, routers: [ROUTERS[0]], clock });
  const row = d.prepare("SELECT * FROM customer WHERE key='10.0.0.50'").get();
  assert.equal(row.kind, "ipoe");
  assert.equal(row.src, "queue");
  assert.equal(row.price, 1200);
});

// End to end through the database, not just through billableFrom(): the failure being prevented is
// a doubled aging report, and that is a property of what is STORED.
test("a lease and its dynamic queue produce one customer row, not two", async () => {
  const d = db();
  const client = fakeClient({
    "10.0.0.1 /ppp/secret/print": [],
    "10.0.0.1 /ip/dhcp-server/lease/print": [
      { "mac-address": "AA:BB:CC:DD:EE:FF", comment: "[bill p=750]", address: "10.0.0.7" },
    ],
    "10.0.0.1 /queue/simple/print": [
      { name: "dhcp-10.0.0.7", target: "10.0.0.7/32", comment: "[bill p=750]", dynamic: "true" },
    ],
  });
  await pollAll({ db: d, client, routers: [ROUTERS[0]], clock });
  assert.equal(d.prepare("SELECT COUNT(*) c FROM customer").get().c, 1);
  assert.equal(d.prepare("SELECT SUM(price) s FROM customer").get().s, 750,
    "the money doubled - the dynamic queue was stored as a second customer");
});

// The queue read is the one source where most rows returned are discarded, so it asks for only the
// columns billing uses. The list must not drift from the app's.
test("the queue read asks only for the fields the app defines", async () => {
  const d = db();
  const calls = [];
  const client = fakeClient({
    "10.0.0.1 /ppp/secret/print": [],
    "10.0.0.1 /ip/dhcp-server/lease/print": [],
    "10.0.0.1 /queue/simple/print": [],
  }, calls);
  await pollAll({ db: d, client, routers: [ROUTERS[0]], clock });
  const q = calls.find((c) => c.cmd === "/queue/simple/print");
  assert.ok(q.attrs && q.attrs[".proplist"], "the queue read sent no .proplist");
  assert.deepEqual(q.attrs[".proplist"].split(","), QUEUE_FIELDS);
  // dynamic is what the double-count guard reads. Dropping it from the proplist would make every
  // queue look static and reintroduce the doubling.
  assert.ok(QUEUE_FIELDS.includes("dynamic"), "dynamic must be requested or the filter is blind");
});

// Pinned against the shared UI, so a field added there is noticed here.
test("QUEUE_FIELDS matches the shared UI's own list", () => {
  const src = readFileSync(SHARED_UI, "utf8");
  const m = /var QUEUE_FIELDS=(\[[^\]]*\])/.exec(src);
  assert.ok(m, "could not find QUEUE_FIELDS in the shared UI");
  assert.deepEqual(QUEUE_FIELDS, JSON.parse(m[1]));
});

// Re-polling must refresh the parsed columns too, not only raw_comment - otherwise a price change
// on the router would never reach the cache.
test("re-polling refreshes the parsed fields", async () => {
  const d = db();
  const before = fakeClient({
    "10.0.0.1 /ppp/secret/print": [{ name: "ana", comment: "[bill p=500]" }],
    "10.0.0.1 /ip/dhcp-server/lease/print": [],
    "10.0.0.1 /queue/simple/print": [],
  });
  await pollAll({ db: d, client: before, routers: [ROUTERS[0]], clock });
  const after = fakeClient({
    "10.0.0.1 /ppp/secret/print": [{ name: "ana", comment: "[bill p=650 due=2026-10-01]" }],
    "10.0.0.1 /ip/dhcp-server/lease/print": [],
    "10.0.0.1 /queue/simple/print": [],
  });
  await pollAll({ db: d, client: after, routers: [ROUTERS[0]], clock });
  const row = d.prepare("SELECT * FROM customer WHERE key='ana'").get();
  assert.equal(row.price, 650);
  assert.equal(row.due, "2026-10-01");
  assert.equal(d.prepare("SELECT COUNT(*) c FROM customer").get().c, 1);
});

test("polling twice refreshes rather than duplicating", async () => {
  const d = db();
  const client = fakeClient({
    "10.0.0.1 /ppp/secret/print": [{ name: "ana", comment: "[bill p=500]" }],
    "10.0.0.1 /ip/dhcp-server/lease/print": [],
  });
  await pollAll({ db: d, client, routers: [ROUTERS[0]], clock });
  await pollAll({ db: d, client, routers: [ROUTERS[0]], clock });
  assert.equal(d.prepare("SELECT COUNT(*) c FROM customer").get().c, 1);
});

test("a lease with no MAC is skipped rather than stored under an empty key", async () => {
  const d = db();
  const client = fakeClient({
    "10.0.0.1 /ppp/secret/print": [],
    "10.0.0.1 /ip/dhcp-server/lease/print": [{ address: "10.0.0.50" }, { "mac-address": "" }],
  });
  await pollAll({ db: d, client, routers: [ROUTERS[0]], clock });
  assert.equal(d.prepare("SELECT COUNT(*) c FROM customer").get().c, 0);
});
