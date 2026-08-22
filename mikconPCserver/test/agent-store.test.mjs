import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, migrate, SCHEMA_VERSION } from "../agent/store.js";

const tmp = () => path.join(mkdtempSync(path.join(tmpdir(), "mikcon-agent-")), "agent.db");
const tables = (db) =>
  db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);

test("a fresh file migrates to the current version", () => {
  const db = openStore(tmp());
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
});

test("every table the design names exists", () => {
  const db = openStore(tmp());
  const t = tables(db);
  for (const name of ["router", "customer", "payment", "message", "event", "sales_daily", "due_remind"]) {
    assert.ok(t.includes(name), `missing table ${name}`);
  }
});

// Re-opening must be a no-op. The host opens this on every launch.
test("re-opening an existing database changes nothing", () => {
  const file = tmp();
  const first = openStore(file);
  first.prepare("INSERT INTO router (id,name,address,first_seen) VALUES (?,?,?,?)")
    .run("r1", "House", "10.0.0.1", "2026-08-08");
  first.close();

  const second = openStore(file);
  assert.equal(second.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
  assert.equal(second.prepare("SELECT COUNT(*) c FROM router").get().c, 1);
});

// migrate() must be driven by user_version, not by "does the table exist" — otherwise a
// half-applied migration is indistinguishable from a complete one.
test("migrate is idempotent and reports the version", () => {
  const file = tmp();
  const db = openStore(file);
  assert.equal(migrate(db), SCHEMA_VERSION);
  assert.equal(migrate(db), SCHEMA_VERSION);
});

// The rule the whole design rests on: credentials never reach sqlite. They stay in DPAPI.
test("no table has a column that could hold a router password", () => {
  const db = openStore(tmp());
  for (const t of tables(db)) {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name.toLowerCase());
    for (const c of cols) {
      // payment_request.token is an opaque handle (request ID), not a credential
      if (t === "payment_request" && c === "token") continue;
      assert.ok(!/pass|secret|credential|token/.test(c), `${t}.${c} looks like a credential column`);
    }
  }
});

test("payment dedupe is unique", () => {
  const db = openStore(tmp());
  const ins = db.prepare(
    "INSERT INTO payment (router_id,customer_key,amount,at,source,dedupe) VALUES (?,?,?,?,?,?)");
  ins.run("r1", "Ana", 500, "2026-08-01", "import", "r1|Ana|2026-08-01");
  assert.throws(() => ins.run("r1", "Ana", 500, "2026-08-01", "import", "r1|Ana|2026-08-01"));
});

// covers_to must be allowed to be unknown. Stage 3 fills it; a NOT NULL here would force
// the import to invent a billing period, which is the exact failure these columns prevent.
test("covers_from and covers_to are nullable", () => {
  const db = openStore(tmp());
  db.prepare("INSERT INTO payment (router_id,customer_key,amount,at,source,dedupe) VALUES (?,?,?,?,?,?)")
    .run("r1", "Ana", 500, "2026-08-01", "import", "d1");
  const row = db.prepare("SELECT covers_from, covers_to, ledger_key, kind FROM payment").get();
  assert.equal(row.covers_from, null);
  assert.equal(row.covers_to, null);
  assert.equal(row.ledger_key, null);
  assert.equal(row.kind, null);
});

test("a migration that throws leaves no partial schema and no version bump", () => {
  // Unreachable with today's single migration, but migrations are append-only and this is
  // shared infrastructure: a half-applied migration that cannot be retried is unrecoverable
  // on an operator's machine.
  const db = new DatabaseSync(tmp());
  assert.throws(() => migrate(db, [
    (d) => { d.exec("CREATE TABLE good (a)"); d.exec("THIS IS NOT SQL"); },
  ]));
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 0);
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  assert.ok(!names.includes("good"), "a failed migration left its tables behind");
});

// Migration 2 is what makes the cache readable rather than merely stored. It must run on a
// database that already has migration 1 applied and rows in it - which is every install in the
// field, because the shell stage has been mirroring into v1 since it shipped.
test("migration 2 adds the parsed columns without disturbing existing rows", () => {
  const file = tmp();
  const first = openStore(file);
  first.prepare("INSERT INTO customer (router_id,kind,key,raw_comment,last_seen) VALUES (?,?,?,?,?)")
    .run("r1", "ppp", "ana", "[bill p=500]", "2026-08-01");
  first.close();

  const db = openStore(file);
  const cols = db.prepare("PRAGMA table_info(customer)").all().map((c) => c.name);
  for (const c of ["src", "name", "phone", "plan", "price", "cycle", "due", "paid", "bal"]) {
    assert.ok(cols.includes(c), `migration 2 did not add customer.${c}`);
  }
  // raw_comment is the evidence behind every parsed column. Losing it would make a parser bug
  // diagnosable only by reproducing it.
  assert.ok(cols.includes("raw_comment"), "raw_comment was dropped");
  const row = db.prepare("SELECT * FROM customer WHERE key='ana'").get();
  assert.equal(row.raw_comment, "[bill p=500]", "an existing row did not survive the migration");
  assert.equal(row.due, null, "a pre-existing row must read as unparsed, not as zero");
});

test("migration 2 creates cutoff_state", () => {
  const db = openStore(tmp());
  assert.ok(tables(db).includes("cutoff_state"));
  db.prepare(`INSERT INTO cutoff_state (router_id,verdict,version,grace,exp_profile,since,checked_at)
              VALUES (?,?,?,?,?,?,?)`).run("r1", "ok", 2, 3, "expired", "2026-08-08", "2026-08-08");
  const row = db.prepare("SELECT * FROM cutoff_state WHERE router_id='r1'").get();
  assert.equal(row.verdict, "ok");
  assert.equal(row.grace, 3);
});

// One migration, so a database can never hold the columns without the table or the reverse -
// a state no code path expects. Checked as "both are there on a fresh database"; the atomicity
// that guarantees it is the BEGIN/COMMIT in migrate(), which the recovery test below pins.
//
// A fresh database sitting at the DECLARED version is the durable half of this, so it is asserted
// against SCHEMA_VERSION rather than a literal - appending a migration and forgetting to bump the
// constant is the mistake worth catching, and it stays caught as the number grows.
test("the columns and the table arrive together", () => {
  const db = openStore(tmp());
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
  assert.equal(SCHEMA_VERSION, 9);
  const cols = db.prepare("PRAGMA table_info(customer)").all().map((c) => c.name);
  assert.ok(cols.includes("due"), "migration 2's columns are missing");
  assert.ok(tables(db).includes("cutoff_state"), "migration 2's table is missing");
});

test("a database recovers after a failed migration, rather than bricking on retry", () => {
  const db = new DatabaseSync(tmp());
  // A migration that creates a table and THEN throws. Under autocommit the table is already
  // committed when the throw lands.
  const broken = [(d) => { d.exec("CREATE TABLE half (a)"); d.exec("THIS IS NOT SQL"); }];
  assert.throws(() => migrate(db, broken));

  // The operator installs a build where that migration is fixed. It creates the SAME table —
  // which is the collision that leaves an un-rolled-back database permanently unmigratable.
  const fixed = [(d) => { d.exec("CREATE TABLE half (a)"); d.exec("CREATE TABLE rest (b)"); }];
  assert.equal(migrate(db, fixed), 1);
});

test("v4 adds payment_request and bumps the schema version", () => {
  const db = openStore(":memory:");
  assert.ok(db.prepare("PRAGMA user_version").get().user_version >= 4);
  const cols = db.prepare("PRAGMA table_info(payment_request)").all().map((c) => c.name);
  for (const c of ["id","router_id","account","customer_key","ref","amount","status","token","tg_message_id","client_ip","created_at","decided_at","dedupe"])
    assert.ok(cols.includes(c), "missing column " + c);
  db.close();
});

test("v5 adds payment purpose and customer wallet", () => {
  const db = openStore(":memory:");
  assert.ok(db.prepare("PRAGMA user_version").get().user_version >= 5);
  const payCols = db.prepare("PRAGMA table_info(payment_request)").all().map((c) => c.name);
  const custCols = db.prepare("PRAGMA table_info(customer)").all().map((c) => c.name);
  assert.ok(payCols.includes("purpose"));
  assert.ok(custCols.includes("wallet"));
  db.close();
});

test("v6 adds who approved a payment request", () => {
  const db = openStore(":memory:");
  assert.ok(db.prepare("PRAGMA user_version").get().user_version >= 6);
  const cols = db.prepare("PRAGMA table_info(payment_request)").all().map((c) => c.name);
  assert.ok(cols.includes("decided_by"));
  assert.ok(cols.includes("decided_role"));
  db.close();
});

test("v7 adds receipts, remittance, watchdog, jobs", () => {
  const db = openStore(":memory:");
  assert.ok(db.prepare("PRAGMA user_version").get().user_version >= 7);
  const t = tables(db);
  for (const name of ["receipt", "remittance", "watchdog_state", "job_ticket"]) {
    assert.ok(t.includes(name), "missing table " + name);
  }
  const recCols = db.prepare("PRAGMA table_info(receipt)").all().map((c) => c.name);
  assert.ok(recCols.includes("code"));
  assert.ok(!recCols.includes("token"));
  db.close();
});

test("v8 adds due_remind without a credential column", () => {
  const db = openStore(":memory:");
  assert.ok(db.prepare("PRAGMA user_version").get().user_version >= 8);
  const t = tables(db);
  assert.ok(t.includes("due_remind"));
  const cols = db.prepare("PRAGMA table_info(due_remind)").all().map((c) => c.name);
  for (const c of ["router_id", "customer_key", "due", "stage", "at"]) {
    assert.ok(cols.includes(c), "missing column " + c);
  }
  assert.ok(!cols.includes("token"));
  db.close();
});

test("v9 adds client_site and session_live without a credential column", () => {
  const db = openStore(":memory:");
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
  assert.equal(SCHEMA_VERSION, 9);
  const t = tables(db);
  assert.ok(t.includes("client_site"));
  assert.ok(t.includes("session_live"));
  const cols = db.prepare("PRAGMA table_info(client_site)").all().map((c) => c.name);
  for (const c of ["nap_port", "drop_port", "lat", "lng"]) {
    assert.ok(cols.includes(c), "missing column " + c);
  }
  assert.ok(!cols.includes("token"));
  db.close();
});

test("v4 dedupe is unique per (router_id, ref)", () => {
  const db = openStore(":memory:");
  const ins = db.prepare("INSERT INTO payment_request (router_id,account,ref,amount,status,token,created_at,dedupe) VALUES (?,?,?,?,?,?,?,?)");
  ins.run("r1","Juan","ABC1",100,"pending","t1","2026-08-17","r1|ABC1");
  assert.throws(() => ins.run("r1","Juan","ABC1",100,"pending","t2","2026-08-17","r1|ABC1"), /UNIQUE/);
  db.close();
});
