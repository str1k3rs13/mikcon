import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openStore } from "../agent/store.js";
import {
  snapshotJs, routersFromSecureBlob, isSafeRouterId, routersForPolling, startAgentHost,
} from "../main/agent-host.js";

// Evaluates the extraction script exactly as the renderer would, against a fake localStorage.
function run(ids, store) {
  const localStorage = { getItem: (k) => (k in store ? store[k] : null) };
  return new Function("localStorage", `return (${snapshotJs(ids)});`)(localStorage);
}

// The app keeps its router list in DPAPI, not in localStorage: index.html removes jf_routers
// the moment the encrypted blob is written (its saveRouters() and hydrateSecureData() both
// do it). A snapshot that looked for jf_routers therefore found nothing on every real
// MikconPC install, imported no ledger for any router, and mirrored only the global sales
// series — the exact "green tests, empty database" failure this stage exists to prevent.
test("the router list is read from the secure blob, not from localStorage", () => {
  const routers = routersFromSecureBlob(JSON.stringify({
    routers: [{ id: "r1", name: "House", ip: "10.0.0.1", user: "admin", pass: "s3cret" }],
    activeId: "r1",
  }));
  assert.deepEqual(routers, [{ id: "r1", name: "House", address: "10.0.0.1" }]);
});

// The blob holds live router passwords. Only the three fields the database has columns for
// may leave this function; nothing else may ride along into the snapshot.
test("credentials never leave the secure blob", () => {
  const routers = routersFromSecureBlob(JSON.stringify({
    routers: [{ id: "r1", name: "House", ip: "10.0.0.1", port: "8728", tls: true,
                tlsFingerprint: "AA:BB", user: "admin", pass: "s3cret" }],
  }));
  const serialized = JSON.stringify(routers);
  for (const secret of ["s3cret", "admin", "AA:BB"]) {
    assert.ok(!serialized.includes(secret), `${secret} leaked into the snapshot`);
  }
  assert.deepEqual(Object.keys(routers[0]).sort(), ["address", "id", "name"]);
});

// A bare array is the older blob shape; hydrateSecureData() still accepts it, so this must too.
test("both secure blob shapes parse, and junk yields no routers", () => {
  assert.equal(routersFromSecureBlob(JSON.stringify([{ id: "r1", name: "A", ip: "1.1.1.1" }])).length, 1);
  assert.deepEqual(routersFromSecureBlob("not json"), []);
  assert.deepEqual(routersFromSecureBlob(""), []);
  assert.deepEqual(routersFromSecureBlob(null), []);
  assert.deepEqual(routersFromSecureBlob(JSON.stringify({ routers: [{ name: "no id" }] })), []);
});

// Router ids are interpolated into a script and concatenated into localStorage key names.
// uid() mints "r"+randomUUID, so anything outside that shape is not a router id we wrote.
test("only well-formed router ids are accepted", () => {
  assert.ok(isSafeRouterId("r1"));
  assert.ok(isSafeRouterId("r0f8c1e2a-4b5d-6e7f-8091-a2b3c4d5e6f7"));
  assert.equal(isSafeRouterId('r1"]);alert(1);//'), false);
  assert.equal(isSafeRouterId("r1 r2"), false);
  assert.equal(isSafeRouterId(""), false);
  assert.equal(isSafeRouterId(null), false);
  // And an unsafe id never reaches the generated script.
  assert.ok(!snapshotJs(['r1"];alert(1);//']).includes("alert(1)"));
});

test("the snapshot collects the ledger, sms log and sales for every router", () => {
  const snap = run(["r1"], {
    "jf_ledger_r1": JSON.stringify([{ n: "Ana", a: 500, at: "2026-07-02", t: "ppp", k: "Ana|2026-07-01" }]),
    "jf_smslog_r1": JSON.stringify([{ n: "Ana", to: "0917", at: "2026-07-01", tm: "09:15", k: "reminder", st: "sent", e: "" }]),
    jf_sales_hist: JSON.stringify([{ d: "2026-07-01", v: 1200 }]),
  });
  assert.equal(snap.ledgers.r1.length, 1);
  assert.equal(snap.smslogs.r1.length, 1);
  assert.equal(snap.sales.length, 1);
});

// Reading a key the agent has no business seeing is how a narrow extraction becomes a general
// renderer-eval channel. jf_license and the router blob must not be swept along.
test("only ledger, sms log and sales keys are read", () => {
  const asked = [];
  const localStorage = { getItem: (k) => { asked.push(k); return null; } };
  new Function("localStorage", `return (${snapshotJs(["r1", "r2"])});`)(localStorage);
  assert.ok(asked.length > 0, "the script read nothing — this assertion would be vacuous");
  for (const k of asked) {
    assert.match(k, /^jf_(sales_hist|ledger_|smslog_)/, `read unexpected key ${k}`);
  }
  assert.ok(!asked.includes("jf_routers"), "the router list must come from DPAPI, not localStorage");
  assert.ok(!asked.includes("jf_license"));
});

test("an empty or corrupt localStorage yields an empty snapshot, not a throw", () => {
  assert.deepEqual(run(["r1"], {}), { ledgers: {}, smslogs: {}, sales: [] });
  assert.deepEqual(run([], { jf_sales_hist: "{{{" }).sales, []);
});

test("a router with no history contributes no empty buckets", () => {
  const snap = run(["r1"], { jf_sales_hist: JSON.stringify([{ d: "2026-07-01", v: 1 }]) });
  assert.deepEqual(snap.ledgers, {});
  assert.deepEqual(snap.smslogs, {});
});

// ---------------------------------------------------------------------------
// The polling projection
// ---------------------------------------------------------------------------

// Stage 1 shipped a poller reading router.host from a list whose entries only ever had .ip, so
// every poll went to `undefined`. This is where that is corrected, and this is the assertion that
// keeps it corrected.
test("routersForPolling maps ip to host and carries the credentials", () => {
  const routers = routersForPolling(JSON.stringify({
    routers: [{ id: "r1", name: "House", ip: "10.0.0.1", port: "8729", tls: true,
                tlsFingerprint: "AA:BB", user: "admin", pass: "s3cret" }],
  }));
  assert.deepEqual(routers, [{
    id: "r1", host: "10.0.0.1", port: 8729, user: "admin", pass: "s3cret",
    tls: true, tlsFingerprint: "AA:BB",
  }]);
});

// apiPortOf() in the shared UI: an explicit port, else 8729 with TLS and 8728 without.
test("the API port defaults the way the app's own apiPortOf does", () => {
  const at = (r) => routersForPolling(JSON.stringify({ routers: [{ id: "r1", ip: "1.1.1.1", ...r }] }))[0].port;
  assert.equal(at({}), 8728);
  assert.equal(at({ tls: true }), 8729);
  assert.equal(at({ port: "1234" }), 1234);
  assert.equal(at({ port: "", tls: true }), 8729);
  assert.equal(at({ port: "not a number" }), 8728);
});

// A router with no address cannot be reached, and exec() would reject it anyway. Dropping it here
// keeps a blank entry out of the failed-router count, where it would read as an outage.
test("a router with no address is not polled", () => {
  assert.deepEqual(routersForPolling(JSON.stringify({ routers: [{ id: "r1", ip: "" }] })), []);
  assert.deepEqual(routersForPolling("not json"), []);
  assert.deepEqual(routersForPolling(""), []);
});

// The two projections must not converge. This one carries live passwords and exists only to be
// handed to exec(); the database-bound one must stay stripped.
test("the two projections stay different shapes", () => {
  const blob = JSON.stringify({ routers: [{ id: "r1", name: "House", ip: "10.0.0.1", user: "admin", pass: "s3cret" }] });
  assert.deepEqual(Object.keys(routersFromSecureBlob(blob)[0]).sort(), ["address", "id", "name"]);
  assert.deepEqual(Object.keys(routersForPolling(blob)[0]).sort(),
    ["host", "id", "pass", "port", "tls", "tlsFingerprint", "user"]);
});

// ---------------------------------------------------------------------------
// The host: licence gating, the overlap guard, and what reaches sqlite
// ---------------------------------------------------------------------------

const BLOB = JSON.stringify({
  routers: [
    { id: "r1", name: "House", ip: "10.0.0.1", user: "admin", pass: "s3cret", tlsFingerprint: "AA:BB" },
    { id: "r2", name: "Shop", ip: "10.0.0.2", user: "admin", pass: "s3cret" },
  ],
  activeId: "r1",
});

// Everything startAgentHost touches, and nothing else. A real BrowserWindow is not needed to prove
// which of these get called.
function fakeDeps({ unlocked = true, blob = BLOB, exec = async () => [] } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "mikcon-host-"));
  const states = [];
  return {
    dir,
    states,
    args: {
      app: { getPath: () => dir },
      win: {
        isDestroyed: () => false,
        webContents: {
          on: () => {},                                          // did-finish-load never fires here
          executeJavaScript: async () => ({ ledgers: {}, smslogs: {}, sales: [] }),
        },
      },
      exec,
      store: { get: async () => (blob ? { found: true, value: blob } : { found: false, value: "" }) },
      isUnlocked: async () => unlocked,
      onState: (s) => states.push(s),
    },
  };
}

// An unlicensed install must do nothing at all: no router traffic, no database writes. isUnlocked
// already returns false when its own check throws, so this fails closed.
test("while the licence gate is up, neither timer does any work", async () => {
  const calls = [];
  const d = fakeDeps({ unlocked: false, exec: async (o) => { calls.push(o); return []; } });
  const host = startAgentHost(d.args);
  try {
    await host.syncOnce();
    await host.pollOnce();
    assert.deepEqual(calls, [], "the poller reached a router while locked");
    assert.equal(host.getState().locked, true);
    const db = openStore(path.join(d.dir, "agent.db"));
    assert.equal(db.prepare("SELECT COUNT(*) c FROM router").get().c, 0);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM customer").get().c, 0);
    db.close();
  } finally { host.stop(); }
});

// Superseded by the daily cut-off check, which adds two reads per router ahead of the poll. The
// assertion is pinned to (host, cmd) pairs rather than loosened to a count: what this test is for
// is that every configured router is reached, on its own address, with reads and nothing else.
test("unlocked, the poller visits every configured router with a real host", async () => {
  const calls = [];
  const d = fakeDeps({ exec: async (o) => { calls.push(o); return []; } });
  const host = startAgentHost(d.args);
  try {
    await host.pollOnce();
    // The health check sweeps both routers first, then the poll reads three sources from each:
    // ppp secrets, dhcp leases, and simple queues - the third added in Stage 3, without which
    // statically-addressed customers are invisible.
    assert.deepEqual(calls.map((c) => [c.host, c.cmd]), [
      ["10.0.0.1", "/system/script/print"],
      ["10.0.0.1", "/system/scheduler/print"],
      ["10.0.0.2", "/system/script/print"],
      ["10.0.0.2", "/system/scheduler/print"],
      ["10.0.0.1", "/ppp/secret/print"],
      ["10.0.0.1", "/ip/dhcp-server/lease/print"],
      ["10.0.0.1", "/queue/simple/print"],
      ["10.0.0.2", "/ppp/secret/print"],
      ["10.0.0.2", "/ip/dhcp-server/lease/print"],
      ["10.0.0.2", "/queue/simple/print"],
    ]);
    for (const c of calls) assert.match(c.cmd, /\/print$/, "the poller must observe only");
    assert.equal(host.getState().locked, false);
  } finally { host.stop(); }
});

// A pass is sequential across routers over what may be a VPN link. A backlog of stale passes all
// firing at a router that has just come back is how RouterOS is provoked into refusing API logins,
// so a tick that lands on a running pass is SKIPPED, not queued.
test("the overlap guard skips a tick rather than queueing it", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let started = 0;
  const d = fakeDeps({ exec: async () => { started++; await gate; return []; } });
  const host = startAgentHost(d.args);
  try {
    const first = host.pollOnce();
    await new Promise((r) => setImmediate(r));      // let the first pass reach its first exec
    assert.equal(started, 1);
    await host.pollOnce();                          // lands mid-pass
    assert.equal(started, 1, "a second pass started on top of the first");
    release();
    await first;
    await host.pollOnce();                          // and the guard releases afterwards
    assert.ok(started > 1, "the guard never released — polling stopped for good");
  } finally { release(); host.stop(); }
});

// One unreachable router must not cost the others their refresh, and must be counted rather than
// thrown, so the tray can say so instead of logging into a void.
test("an unreachable router is counted, not thrown", async () => {
  const d = fakeDeps({
    exec: async (o) => { if (o.host === "10.0.0.2") throw new Error("timed out"); return []; },
  });
  const host = startAgentHost(d.args);
  try {
    await host.pollOnce();
    assert.equal(host.getState().unreachable, 1);
    assert.deepEqual(d.states.at(-1).unreachable, 1, "the tray was never told");
  } finally { host.stop(); }
});

// The polling projection carries live passwords. It exists to be handed to exec() and must never be
// written down — this asserts against the whole database, not just the router table, because the
// question is whether a credential reached sqlite by ANY path.
test("nothing from the polling projection reaches sqlite", async () => {
  const d = fakeDeps({
    exec: async () => [{ name: "Ana", comment: "[bill 500 2026-08-01]" }],
  });
  const host = startAgentHost(d.args);
  try {
    await host.syncOnce();
    await host.pollOnce();
  } finally { host.stop(); }

  const db = openStore(path.join(d.dir, "agent.db"));
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  let dump = "";
  for (const t of tables) dump += JSON.stringify(db.prepare(`SELECT * FROM "${t}"`).all());
  db.close();
  assert.ok(dump.includes("Ana"), "the poll wrote nothing — this assertion would be vacuous");
  // The ADDRESS is not on this list: routersFromSecureBlob() legitimately writes it to
  // router.address, and syncOnce() above did. The user, the password and the fingerprint are the
  // fields that must never appear.
  for (const secret of ["s3cret", "admin", "AA:BB"]) {
    assert.ok(!dump.includes(secret), secret + " reached the database");
  }
});

test("a sync records when it happened, and the tray is told", async () => {
  const d = fakeDeps();
  const host = startAgentHost(d.args);
  try {
    assert.equal(host.getState().lastSyncAt, null);
    await host.syncOnce();
    assert.ok(host.getState().lastSyncAt instanceof Date);
    assert.ok(d.states.length > 0, "onState was never called");
  } finally { host.stop(); }
});

// ---------------------------------------------------------------------------
// The daily cut-off health check
// ---------------------------------------------------------------------------

const CUTOFF_SRC = (v, dry) => [
  `# MIKCON-CUTOFF-V${v}`, ':local expProf "expired"', ":local grace 3", `:local dry ${dry ? "true" : "false"}`,
].join("\n");

// A client that answers the three poll reads plus the two health reads.
function healthClient({ script = null, scheduler = null, fail = null } = {}, calls = []) {
  return async (o) => {
    calls.push(o);
    if (fail && fail(o)) throw new Error("connection timed out");
    if (o.cmd === "/system/script/print") return script ? [script] : [];
    if (o.cmd === "/system/scheduler/print") return scheduler ? [scheduler] : [];
    return [];
  };
}
const OK_SCRIPT = { name: "mikcon-cutoff", source: CUTOFF_SRC(2, false) };
const OLD_SCRIPT = { name: "mikcon-cutoff", source: CUTOFF_SRC(1, false) };
const OK_SCHED = { name: "mikcon-cutoff", interval: "1d" };

test("a healthy router raises no warning and records ok", async () => {
  const d = fakeDeps({ exec: healthClient({ script: OK_SCRIPT, scheduler: OK_SCHED }) });
  const host = startAgentHost(d.args);
  try {
    await host.pollOnce();
    assert.equal(host.getState().cutoff.worst, null);
    const db = openStore(path.join(d.dir, "agent.db"));
    const rows = db.prepare("SELECT * FROM cutoff_state ORDER BY router_id").all();
    assert.equal(rows.length, 2, "both routers should have been checked");
    assert.equal(rows[0].verdict, "ok");
    assert.equal(rows[0].checked_at, rows[0].since);
    db.close();
  } finally { host.stop(); }
});

test("a stale script warns, names the routers, and records a transition", async () => {
  const d = fakeDeps({ exec: healthClient({ script: OLD_SCRIPT, scheduler: OK_SCHED }) });
  const host = startAgentHost(d.args);
  try {
    await host.pollOnce();
    const s = host.getState().cutoff;
    assert.equal(s.worst, "stale");
    assert.equal(s.affected.length, 2);
    assert.deepEqual(s.affected.map((a) => a.name).sort(), ["House", "Shop"]);
    const db = openStore(path.join(d.dir, "agent.db"));
    assert.equal(db.prepare("SELECT COUNT(*) c FROM event WHERE type='cutoff_check'").get().c, 2);
    db.close();
  } finally { host.stop(); }
});

// An event per router per day would be mostly-identical noise; transitions answer the question
// that actually gets asked, which is when did this break.
test("an unchanged verdict writes no second event but still moves checked_at", async () => {
  let day = "2026-08-08";
  const d = fakeDeps({ exec: healthClient({ script: OLD_SCRIPT, scheduler: OK_SCHED }) });
  const host = startAgentHost({ ...d.args, clock: { today: () => day, now: () => new Date(), isSane: () => true } });
  try {
    await host.pollOnce();
    day = "2026-08-09";
    await host.pollOnce();
    const db = openStore(path.join(d.dir, "agent.db"));
    assert.equal(db.prepare("SELECT COUNT(*) c FROM event WHERE type='cutoff_check'").get().c, 2,
      "a second identical verdict wrote another event");
    const row = db.prepare("SELECT * FROM cutoff_state WHERE router_id='r1'").get();
    assert.equal(row.checked_at, "2026-08-09", "checked_at did not move");
    assert.equal(row.since, "2026-08-08", "since must stay at the first sighting of this verdict");
    db.close();
  } finally { host.stop(); }
});

// Once a day. The check is two extra reads per router and the answer only changes when a human
// installs a script.
test("the check runs once per day, not on every pass", async () => {
  const calls = [];
  const d = fakeDeps({ exec: healthClient({ script: OK_SCRIPT, scheduler: OK_SCHED }, calls) });
  const host = startAgentHost(d.args);
  try {
    await host.pollOnce();
    const first = calls.filter((c) => c.cmd === "/system/script/print").length;
    assert.equal(first, 2, "expected one script read per router on the first pass");
    await host.pollOnce();
    assert.equal(calls.filter((c) => c.cmd === "/system/script/print").length, first,
      "the health check ran twice in one day");
  } finally { host.stop(); }
});

// The bug a memory-only flag would have: restart at 09:00 and the tray says nothing all day about
// a router whose cut-off is missing, which is exactly the silence this stage exists to end.
test("a restarted host shows the warning immediately without re-checking", async () => {
  const d = fakeDeps({ exec: healthClient({ script: OLD_SCRIPT, scheduler: OK_SCHED }) });
  const first = startAgentHost(d.args);
  await first.pollOnce();
  first.stop();

  const calls = [];
  const second = startAgentHost({ ...d.args, exec: healthClient({ script: OLD_SCRIPT, scheduler: OK_SCHED }, calls) });
  try {
    assert.equal(second.getState().cutoff.worst, "stale",
      "the warning was lost across a restart");
    await second.pollOnce();
    assert.equal(calls.filter((c) => c.cmd === "/system/script/print").length, 0,
      "it re-checked a router it had already checked today");
  } finally { second.stop(); }
});

// The seeded warning is drawn before any poll has run - the poll timer is 15 minutes out - so the
// names have to come from the sync, which fires on did-finish-load. A raw id in the tray is worse
// than the count it replaced: naming the router is the whole reason that branch exists, and
// "r1: cut-off is out of date" still leaves the operator looking it up.
test("a restarted host names the affected routers before the first poll", async () => {
  const d = fakeDeps({ exec: healthClient({ script: OLD_SCRIPT, scheduler: OK_SCHED }) });
  const first = startAgentHost(d.args);
  await first.pollOnce();
  first.stop();

  const second = startAgentHost({ ...d.args, exec: healthClient({ script: OLD_SCRIPT, scheduler: OK_SCHED }) });
  try {
    assert.deepEqual(second.getState().cutoff.affected.map((a) => a.name).sort(), ["r1", "r2"],
      "before any read, ids are all it can honestly show");
    await second.syncOnce();
    assert.deepEqual(second.getState().cutoff.affected.map((a) => a.name).sort(), ["House", "Shop"],
      "the sync knows the names and the warning was left showing ids");
  } finally { second.stop(); }
});

// Recording "cut-off missing" for a router that merely could not be reached would cry wolf, and an
// alert that cries wolf gets ignored.
test("an unreachable router raises no cut-off alarm", async () => {
  const d = fakeDeps({
    exec: healthClient({ script: OK_SCRIPT, scheduler: OK_SCHED, fail: (o) => o.host === "10.0.0.2" }),
  });
  const host = startAgentHost(d.args);
  try {
    await host.pollOnce();
    assert.equal(host.getState().cutoff.worst, null, "an unreachable router was reported as broken");
    const db = openStore(path.join(d.dir, "agent.db"));
    assert.equal(db.prepare("SELECT COUNT(*) c FROM cutoff_state WHERE router_id='r2'").get().c, 0);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM event WHERE router_id='r2'").get().c, 0);
    db.close();
    assert.equal(host.getState().unreachable, 1, "it should still count as unreachable");
  } finally { host.stop(); }
});

// A warning the operator cannot clear is worse than no warning: they learn to ignore the line, and
// then miss the real one. cutoff_state outlives the router list unless something prunes it, and the
// name lookup no longer resolves either - so the tray ends up naming a raw id for a router that is
// not in the app any more.
test("removing a router clears its cut-off warning", async () => {
  let blob = BLOB;
  const d = fakeDeps({ exec: healthClient({ script: OLD_SCRIPT, scheduler: OK_SCHED }) });
  const args = { ...d.args, store: { get: async () => ({ found: true, value: blob }) } };
  const host = startAgentHost(args);
  try {
    await host.pollOnce();
    assert.equal(host.getState().cutoff.affected.length, 2);

    // The operator deletes the Shop router in the app.
    blob = JSON.stringify({ routers: JSON.parse(BLOB).routers.slice(0, 1), activeId: "r1" });
    await host.pollOnce();

    const s = host.getState().cutoff;
    assert.deepEqual(s.affected.map((a) => a.id), ["r1"], "a removed router still warns");
    assert.equal(s.worst, "stale", "the remaining router's warning was lost with it");

    const db = openStore(path.join(d.dir, "agent.db"));
    assert.equal(db.prepare("SELECT COUNT(*) c FROM cutoff_state WHERE router_id='r2'").get().c, 0,
      "the removed router's cut-off row outlived it");
    // Its history is not rewritten, though: the events are what answers "when did this break".
    assert.ok(db.prepare("SELECT COUNT(*) c FROM event WHERE router_id='r2'").get().c > 0,
      "pruning state must not erase the event log");
    db.close();
  } finally { host.stop(); }
});

// An outage count for a router that is gone is the same class of lie, and pollOnce returns early
// on an empty list - before the line that would have reset it.
test("removing every router clears the unreachable count", async () => {
  let blob = BLOB;
  const d = fakeDeps({ exec: async () => { throw new Error("connection timed out"); } });
  const host = startAgentHost({ ...d.args, store: { get: async () => ({ found: true, value: blob }) } });
  try {
    await host.pollOnce();
    assert.equal(host.getState().unreachable, 2);
    blob = JSON.stringify({ routers: [] });
    await host.pollOnce();
    assert.equal(host.getState().unreachable, 0, "the tray still reports an outage for a router that is gone");
  } finally { host.stop(); }
});

// Pruning reads the CONFIGURED list, not the pollable one. A router whose address the operator
// blanked - mid-edit, or because it moved - is still theirs, and dropping its verdict would clear
// the warning and then raise it again from scratch the moment the address came back, with `since`
// reset to today. The router is unreachable, not gone.
test("a configured router with no address keeps its cut-off warning", async () => {
  const both = JSON.parse(BLOB).routers;
  let blob = BLOB;
  const d = fakeDeps({ exec: healthClient({ script: OLD_SCRIPT, scheduler: OK_SCHED }) });
  const host = startAgentHost({ ...d.args, store: { get: async () => ({ found: true, value: blob }) } });
  try {
    await host.pollOnce();
    assert.equal(host.getState().cutoff.affected.length, 2);

    // The Shop router's address is blanked, so it drops out of routersForPolling but not the app.
    blob = JSON.stringify({ routers: [both[0], { ...both[1], ip: "" }], activeId: "r1" });
    await host.pollOnce();

    const db = openStore(path.join(d.dir, "agent.db"));
    assert.equal(db.prepare("SELECT COUNT(*) c FROM cutoff_state WHERE router_id='r2'").get().c, 1,
      "a router that is merely unreachable had its verdict deleted");
    db.close();
    assert.deepEqual(host.getState().cutoff.affected.map((a) => a.id).sort(), ["r1", "r2"]);
  } finally { host.stop(); }
});

// The dangerous half of pruning. A blob that is missing or unreadable parses to zero routers
// exactly as an empty fleet does, and treating the two alike would delete every verdict because
// DPAPI hiccupped - losing the alarm silently, since the next check is a day away.
test("an unreadable router blob does not wipe the cut-off warnings", async () => {
  let blob = BLOB;
  const d = fakeDeps({ exec: healthClient({ script: OLD_SCRIPT, scheduler: OK_SCHED }) });
  const host = startAgentHost({ ...d.args, store: { get: async () => ({ found: true, value: blob }) } });
  try {
    await host.pollOnce();
    assert.equal(host.getState().cutoff.affected.length, 2);

    for (const bad of ["", "   ", "not json at all", "{oops"]) {
      blob = bad;
      await host.pollOnce();
      const db = openStore(path.join(d.dir, "agent.db"));
      const kept = db.prepare("SELECT COUNT(*) c FROM cutoff_state").get().c;
      db.close();
      assert.equal(kept, 2, "an unreadable blob (" + JSON.stringify(bad) + ") deleted the verdicts");
      assert.equal(host.getState().cutoff.worst, "stale", "the warning was lost to an unreadable blob");
    }
  } finally { host.stop(); }
});

// Locked means locked: no polling, no health reads, nothing.
test("nothing is checked while the licence gate is up", async () => {
  const calls = [];
  const d = fakeDeps({ unlocked: false, exec: healthClient({ script: OK_SCRIPT, scheduler: OK_SCHED }, calls) });
  const host = startAgentHost(d.args);
  try {
    await host.pollOnce();
    assert.deepEqual(calls, []);
    assert.equal(host.getState().cutoff.worst, null);
  } finally { host.stop(); }
});

// ---------------------------------------------------------------------------
// Payment reminder: the intake server + Telegram bot, hosted under the licence gate (Task 9)
// ---------------------------------------------------------------------------

// A store that actually respects the key it is asked for, unlike fakeDeps()'s store above (which
// answers every key with the router blob — fine for the cut-off tests, which never read the
// payreminder-* keys, but not for these).
function keyedStore(kv) {
  return { get: async (key) => (key in kv ? { found: true, value: kv[key] } : { found: false, value: "" }) };
}

function fakePayRuntime() {
  const calls = { startPayServer: 0, makeBot: 0, botStart: 0, botStop: 0, serverClose: 0 };
  return {
    calls,
    startPayServer: async () => {
      calls.startPayServer++;
      return { server: {}, port: 1234, close: async () => { calls.serverClose++; } };
    },
    makePayBot: () => {
      calls.makeBot++;
      return {
        notify: async () => {},
        handleUpdate: async () => {},
        decideDirect: async () => ({ ok: false, reason: "not pending" }),
        start: async () => { calls.botStart++; },
        stop: async () => { calls.botStop++; },
      };
    },
  };
}

const ENABLED_PAYREMINDER_KV = {
  routers: BLOB,
  "payreminder-config": JSON.stringify({ enabled: true, port: 0, routerId: "r1", gcash: {}, brand: {} }),
  "payreminder-telegram": JSON.stringify({ token: "T", chatId: "42" }),
};

test("while the licence gate is up, reconcilePayReminder does not start the intake server or the telegram bot", async () => {
  const d = fakeDeps({ unlocked: false });
  const fake = fakePayRuntime();
  const host = startAgentHost({
    ...d.args,
    store: keyedStore(ENABLED_PAYREMINDER_KV),
    startPayServer: fake.startPayServer,
    makePayBot: fake.makePayBot,
  });
  try {
    await host.reconcilePayReminder();
    assert.equal(fake.calls.startPayServer, 0, "the intake server started while the licence gate was up");
    assert.equal(fake.calls.makeBot, 0, "the telegram bot was built while the licence gate was up");
    assert.equal(fake.calls.botStart, 0, "the telegram bot started while the licence gate was up");

    const decide = await host.payReminder.decide(1, true);
    assert.deepEqual(decide, { ok: false, reason: "not running" }, "decide must refuse when nothing is running");
  } finally { host.stop(); }
});

// The other half: an enabled, fully-configured payment reminder DOES start once the gate is up, and
// a second reconcile with the same config is a no-op (no pointless stop/start).
test("once unlocked, a saved and enabled config starts the intake server and the telegram bot exactly once", async () => {
  const d = fakeDeps({ unlocked: true });
  const fake = fakePayRuntime();
  const host = startAgentHost({
    ...d.args,
    store: keyedStore(ENABLED_PAYREMINDER_KV),
    startPayServer: fake.startPayServer,
    makePayBot: fake.makePayBot,
  });
  try {
    await host.reconcilePayReminder();
    assert.equal(fake.calls.startPayServer, 1);
    assert.equal(fake.calls.makeBot, 1);
    assert.equal(fake.calls.botStart, 1);

    // Reconciling again with the exact same config must not restart anything.
    await host.reconcilePayReminder();
    assert.equal(fake.calls.startPayServer, 1, "reconciling an unchanged config restarted the server");
    assert.equal(fake.calls.makeBot, 1, "reconciling an unchanged config rebuilt the bot");
  } finally {
    host.stop();
  }
});

// getConfig must never leak the raw Telegram token — only whether one is set.
test("payReminder.getConfig never returns the raw telegram token", async () => {
  const d = fakeDeps({ unlocked: true });
  const host = startAgentHost({
    ...d.args,
    store: keyedStore(ENABLED_PAYREMINDER_KV),
    startPayServer: fakePayRuntime().startPayServer,
    makePayBot: fakePayRuntime().makePayBot,
  });
  try {
    const { config, telegram } = await host.payReminder.getConfig();
    assert.equal(config.enabled, true);
    assert.equal(config.routerId, "r1");
    assert.equal(telegram.chatId, "42");
    assert.equal(telegram.hasToken, true);
    assert.ok(!("token" in telegram), "the raw token must never reach the IPC-facing config read");
  } finally { host.stop(); }
});

// ---------------------------------------------------------------------------
// Prepaid wallet auto-renew
// ---------------------------------------------------------------------------

test("pollOnce deducts a covering wallet and leaves a short wallet untouched", async () => {
  const today = "2026-08-18";
  const sets = [];
  const secrets = [
    { ".id": "*1", name: "ana", comment: "[bill p=750 c=monthly due=2026-08-18 w=1500 plan=Fibre 20]" },
    { ".id": "*2", name: "ben", comment: "[bill p=600 c=monthly due=2026-08-18 w=100 plan=Home 10]" },
  ];
  const d = fakeDeps({
    blob: JSON.stringify({
      routers: [{ id: "r1", name: "House", ip: "10.0.0.1", user: "admin", pass: "s3cret" }],
      activeId: "r1",
    }),
    exec: async (o) => {
      if (o.cmd === "/system/script/print" || o.cmd === "/system/scheduler/print") return [];
      if (o.cmd === "/ppp/secret/print") return secrets;
      if (o.cmd === "/ppp/profile/print") return [{ name: "Fibre 20" }, { name: "Home 10" }];
      if (o.cmd === "/ip/dhcp-server/lease/print") return [];
      if (o.cmd === "/queue/simple/print") return [];
      if (o.cmd === "/ppp/secret/set") {
        sets.push(o.attrs);
        const row = secrets.find((s) => s[".id"] === o.attrs[".id"]);
        if (row && o.attrs.comment != null) row.comment = o.attrs.comment;
        return [];
      }
      return [];
    },
  });
  const host = startAgentHost({
    ...d.args,
    clock: { today: () => today, now: () => new Date(), isSane: () => true },
  });
  try {
    await host.pollOnce();
    const ana = sets.find((s) => s[".id"] === "*1");
    const ben = sets.find((s) => s[".id"] === "*2");
    assert.ok(ana, "ana should have been renewed");
    assert.match(String(ana.comment), /due=2026-09-18/);
    assert.match(String(ana.comment), /w=750/);
    assert.equal(ben, undefined, "ben's wallet is below one cycle and must not be written");
    const db = openStore(path.join(d.dir, "agent.db"));
    const rows = db.prepare("SELECT * FROM payment WHERE source='wallet-renew'").all();
    db.close();
    assert.equal(rows.length, 1, "expected one wallet-renew payment row");
    assert.equal(rows[0].amount, 750);
    assert.equal(rows[0].customer_key, "ana");
    assert.equal(rows[0].method, "wallet");
  } finally { host.stop(); }
});
