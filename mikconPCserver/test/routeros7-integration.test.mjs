// End to end against a mock RouterOS 7 speaking the real binary API over a real socket.
//
// Every other test in this stage hands agent/billing.js a hand-written array, which means the
// arrays and the rules were written by the same person on the same afternoon and agree with each
// other by construction. This one goes through main/routeros.js, a TCP socket, the wire protocol,
// the .proplist narrowing and agent/poller.js before anything is asserted - so a rule that only
// holds against the fixtures it was born with fails here.
//
// WHAT THIS STILL CANNOT TELL YOU. The mock returns what this repo BELIEVES RouterOS 7 returns.
// If that belief is wrong - a property named differently, dynamic queues built where we do not
// expect them - the mock is wrong in the same direction as the code and every assertion below
// passes anyway. The plan's against-a-real-router check is still owed and is not replaced by this
// file. What this does is make that check unlikely to be the first place a shape problem is found.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { exec, closeSessions } from "../main/routeros.js";

after(() => closeSessions());
import { openStore } from "../agent/store.js";
import { pollAll } from "../agent/poller.js";
import { cutoffHealth, worstVerdict } from "../agent/cutoff.js";
import { makeClock } from "../agent/clock.js";
import {
  startRouterOS7, FLEET, CUTOFF_SCRIPT_V1,
} from "./fixtures/routeros7.mjs";

const CLOCK = makeClock(() => new Date(2026, 7, 9, 12, 0, 0));
const freshDb = () => openStore(path.join(mkdtempSync(path.join(tmpdir(), "mikcon-ros7-")), "agent.db"));
const routerAt = (port, id = "r1") => ({
  id, host: "127.0.0.1", port, user: "admin", pass: "s3cret", tls: false, tlsFingerprint: "",
});

// The headline number. Eight people are on this router. Dropping the dynamic filter makes it ten,
// not thirteen: RouterOS leaves its <pppoe-*> queues uncommented, so those three fail the tag test
// on their own and only the two DHCP queues - which DO inherit the lease's comment - get through.
// Worth stating precisely, because "the count roughly doubles" is the symptom the plan tells an
// operator to look for on a real router, and on a PPPoE-heavy one the damage is quieter than that.
// The invariant below (no key twice) is the version that does not depend on the mix.
test("every customer on a v7 router appears exactly once", async () => {
  const r = await startRouterOS7();
  const db = freshDb();
  try {
    const { ok, failed } = await pollAll({
      db, client: exec, routers: [routerAt(r.port)], clock: CLOCK,
    });
    assert.deepEqual(failed, [], "the router should have been reachable");
    assert.deepEqual(ok, ["r1"]);

    const rows = db.prepare("SELECT kind,src,key,name,price,cycle,due,plan FROM customer ORDER BY key").all();
    assert.equal(rows.length, 8,
      "expected 8 customers, got " + rows.length + ": " + rows.map((x) => x.key).join(", "));

    // No key appears twice, which is the doubling bug stated as an invariant rather than a count.
    const keys = rows.map((x) => x.key);
    assert.equal(new Set(keys).size, keys.length, "a customer was counted twice: " + keys.join(", "));

    // And the identities are the ones a human would name, from all three sources.
    assert.deepEqual(keys.sort(), [
      "10.0.0.31", "10.0.0.32", "10.0.0.34",          // static: fay, gil, hana
      "AA:BB:CC:00:00:21", "AA:BB:CC:00:00:22",       // dhcp: dina, eli
      "ana", "ben", "carl",                            // pppoe
    ].sort());
  } finally { db.close(); await r.close(); }
});

// The trap the dynamic filter exists for: RouterOS copies a rate-limited lease's comment onto the
// queue it builds, tag and all. Dina is therefore visible twice with an identical [bill ...] tag,
// and only =dynamic=true separates the person from the router's own bookkeeping.
test("a lease and the dynamic queue RouterOS built for it are one customer", async () => {
  const r = await startRouterOS7();
  const db = freshDb();
  try {
    await pollAll({ db, client: exec, routers: [routerAt(r.port)], clock: CLOCK });
    const dina = db.prepare("SELECT * FROM customer WHERE name LIKE 'Dina%'").all();
    assert.equal(dina.length, 1, "Dina was counted once per source instead of once");
    assert.equal(dina[0].kind, "ipoe");
    assert.equal(dina[0].src, "lease", "the lease is the record; the dynamic queue is not");
    assert.equal(dina[0].key, "AA:BB:CC:00:00:21");
    assert.equal(dina[0].price, 600);

    // No row anywhere is keyed on a dynamic queue's address.
    const byAddr = db.prepare("SELECT COUNT(*) c FROM customer WHERE key IN ('10.0.0.21','10.0.0.22')").get();
    assert.equal(byAddr.c, 0, "a dynamic queue became a customer in its own right");
  } finally { db.close(); await r.close(); }
});

// Absent must mean static. Hana's queue carries no =dynamic= property at all, which happens across
// versions, and reading that as "not static" would silently drop a paying customer.
test("a static queue with no dynamic property at all is still a customer", async () => {
  const r = await startRouterOS7();
  const db = freshDb();
  try {
    await pollAll({ db, client: exec, routers: [routerAt(r.port)], clock: CLOCK });
    const hana = db.prepare("SELECT * FROM customer WHERE key='10.0.0.34'").get();
    assert.ok(hana, "Hana's queue omits =dynamic= and she was dropped");
    assert.equal(hana.price, 800);
    assert.equal(hana.src, "queue");
  } finally { db.close(); await r.close(); }
});

// The proplist is sent over the wire and the mock honours it, so this fails if the poller ever
// stops asking for a field the rules depend on - "dynamic" above all.
test("the queue read asks the router for dynamic, and gets it", async () => {
  const seen = [];
  const r = await startRouterOS7({ onCommand: (c) => seen.push(c) });
  const db = freshDb();
  try {
    await pollAll({ db, client: exec, routers: [routerAt(r.port)], clock: CLOCK });
    const q = seen.find((c) => c.cmd === "/queue/simple/print");
    const proplist = q.words.find((w) => w.startsWith("=.proplist="));
    assert.ok(proplist, "the queue read sent no .proplist");
    assert.ok(proplist.includes("dynamic"),
      "the proplist does not ask for dynamic, so every queue would read as static: " + proplist);
    assert.ok(proplist.includes("comment"), "without comment there is no tag to parse");

    // Observation only, all the way to the wire.
    for (const c of seen) {
      if (c.cmd === "/login") continue;
      assert.match(c.cmd, /\/print$/, "the poller issued a non-read command: " + c.cmd);
    }
  } finally { db.close(); await r.close(); }
});

// Tags are parsed off real wire bytes, not off a JS string literal in a test file.
test("the bill tags survive the wire and land parsed, with the raw tag beside them", async () => {
  const r = await startRouterOS7();
  const db = freshDb();
  try {
    await pollAll({ db, client: exec, routers: [routerAt(r.port)], clock: CLOCK });
    const ana = db.prepare("SELECT * FROM customer WHERE key='ana'").get();
    assert.equal(ana.price, 750);
    assert.equal(ana.cycle, "monthly");
    assert.equal(ana.due, "2026-09-01");
    assert.equal(ana.phone, "09171234567");
    assert.equal(ana.plan, "Fibre 20 Mbps", "a plan name with spaces did not survive");
    assert.equal(ana.name, "Ana Cruz");
    assert.equal(ana.raw_comment, FLEET.secrets[0].comment, "the verbatim tag was not kept");

    // An untagged secret is still a customer - one with no price, which is not the same as absent.
    const carl = db.prepare("SELECT * FROM customer WHERE key='carl'").get();
    assert.ok(carl, "an untagged PPPoE secret stopped being a customer");
    assert.equal(carl.price, 0);

    // An untagged QUEUE, though, is a QoS rule and not a person.
    assert.equal(db.prepare("SELECT COUNT(*) c FROM customer WHERE key='10.0.0.99'").get().c, 0,
      "the printer throttle became a customer");
  } finally { db.close(); await r.close(); }
});

// Gil's target is a comma list whose first entry has no mask - the case that survived mutation
// testing at unit level. Here it arrives over the wire from a router.
test("a comma-list target keys on the first address", async () => {
  const r = await startRouterOS7();
  const db = freshDb();
  try {
    await pollAll({ db, client: exec, routers: [routerAt(r.port)], clock: CLOCK });
    const gil = db.prepare("SELECT * FROM customer WHERE name LIKE 'Gil%'").get();
    assert.ok(gil, "Gil was dropped");
    assert.equal(gil.key, "10.0.0.32", "the key kept the rest of the target list");
  } finally { db.close(); await r.close(); }
});

// ---------------------------------------------------------------------------
// The cut-off health check, against the same wire
// ---------------------------------------------------------------------------

async function healthOf(opts) {
  const r = await startRouterOS7(opts);
  try {
    const call = (cmd) => exec({ ...routerAt(r.port), cmd });
    const scripts = await call("/system/script/print");
    const schedulers = await call("/system/scheduler/print");
    const byName = (l) => (l || []).find((x) => x && x.name === "mikcon-cutoff") || null;
    return cutoffHealth({ script: byName(scripts), scheduler: byName(schedulers) });
  } finally { await r.close(); }
}

test("a v7 router running the current script reads as ok", async () => {
  const h = await healthOf({});
  assert.equal(h.verdict, "ok");
  assert.equal(h.version, 2);
  assert.equal(h.grace, 3, "the grace line did not survive CRLF script source");
  assert.equal(h.expProfile, "expired");
  assert.equal(worstVerdict([h.verdict]), null);
});

test("an old script on the router reads as stale, with its own grace", async () => {
  const h = await healthOf({ script: CUTOFF_SCRIPT_V1 });
  assert.equal(h.verdict, "stale");
  assert.equal(h.version, 1);
  assert.equal(h.grace, 5);
});

test("no script at all reads as missing", async () => {
  const h = await healthOf({ script: null });
  assert.equal(h.verdict, "missing");
  assert.equal(h.grace, null, "missing must not invent a grace period");
});

test("a deleted scheduler reads as unscheduled even though the script is current", async () => {
  const h = await healthOf({ scheduler: null });
  assert.equal(h.verdict, "unscheduled");
  assert.equal(h.version, 2, "the script is fine; it is the schedule that is gone");
});

test("a disabled scheduler reads as unscheduled too", async () => {
  const h = await healthOf({
    scheduler: { ".id": "*20", name: "mikcon-cutoff", interval: "1d", disabled: "true" },
  });
  assert.equal(h.verdict, "unscheduled");
});

// ---------------------------------------------------------------------------
// A fleet, and the failures a fleet actually has
// ---------------------------------------------------------------------------

// One router being down must cost only that router its refresh. This is asserted here rather than
// only against a throwing stub because a real socket fails differently: it refuses a connection.
test("an unreachable router in a fleet does not cost the others their refresh", async () => {
  const up = await startRouterOS7();
  const dead = await startRouterOS7();
  const deadPort = dead.port;
  await dead.close();                       // nothing is listening on deadPort now

  const db = freshDb();
  try {
    const { ok, failed } = await pollAll({
      db, client: exec,
      routers: [routerAt(up.port, "r1"), routerAt(deadPort, "r2")],
      clock: CLOCK,
    });
    assert.deepEqual(ok, ["r1"]);
    assert.equal(failed.length, 1);
    assert.equal(failed[0].id, "r2");
    assert.equal(db.prepare("SELECT COUNT(*) c FROM customer WHERE router_id='r1'").get().c, 8);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM customer WHERE router_id='r2'").get().c, 0);
  } finally { db.close(); await up.close(); }
});

// Bad credentials are a !trap, not a socket error, and must be reported rather than silently
// producing an empty - and therefore "healthy looking" - router.
test("a rejected login is a failure, not an empty router", async () => {
  const r = await startRouterOS7({ pass: "something-else" });
  const db = freshDb();
  try {
    const { ok, failed } = await pollAll({
      db, client: exec, routers: [routerAt(r.port)], clock: CLOCK,
    });
    assert.deepEqual(ok, []);
    assert.equal(failed.length, 1);
    assert.match(failed[0].error, /cannot log in/);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM customer").get().c, 0,
      "a router that refused the login must not leave rows behind");
  } finally { db.close(); await r.close(); }
});

// Re-polling is how this runs forever: the same fleet must converge, not accumulate.
test("polling the same router twice changes nothing and adds no rows", async () => {
  const r = await startRouterOS7();
  const db = freshDb();
  try {
    const routers = [routerAt(r.port)];
    await pollAll({ db, client: exec, routers, clock: CLOCK });
    const first = db.prepare("SELECT kind,src,key,price,due FROM customer ORDER BY key").all();
    await pollAll({ db, client: exec, routers, clock: CLOCK });
    const second = db.prepare("SELECT kind,src,key,price,due FROM customer ORDER BY key").all();
    assert.equal(second.length, 8, "a second pass grew the table");
    assert.deepEqual(second, first);
  } finally { db.close(); await r.close(); }
});

// And a tag edited on the router reaches the cache, because the cache is a mirror of the tag and
// never an authority over it.
test("editing a tag on the router updates the cached row on the next pass", async () => {
  const fleet = structuredClone(FLEET);
  const r = await startRouterOS7({ fleet });
  const db = freshDb();
  try {
    const routers = [routerAt(r.port)];
    await pollAll({ db, client: exec, routers, clock: CLOCK });
    assert.equal(db.prepare("SELECT price FROM customer WHERE key='ana'").get().price, 750);

    // The operator raises Ana's plan in Winbox.
    fleet.secrets[0].comment = "Ana Cruz [bill p=900 c=monthly due=2026-10-01 plan=Fibre 50 Mbps]";
    await pollAll({ db, client: exec, routers, clock: CLOCK });

    const ana = db.prepare("SELECT * FROM customer WHERE key='ana'").get();
    assert.equal(ana.price, 900);
    assert.equal(ana.due, "2026-10-01");
    assert.equal(ana.plan, "Fibre 50 Mbps");
    assert.equal(db.prepare("SELECT COUNT(*) c FROM customer").get().c, 8, "the edit created a second Ana");
  } finally { db.close(); await r.close(); }
});
