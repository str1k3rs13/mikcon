// The agent's memory. node:sqlite is a Node builtin as of 22.5, which is why Stage 0 moved
// this app to Electron 43 (Node 24.18.1) — it keeps the zero-runtime-dependency property.
//
// Router credentials NEVER appear here. They stay in DPAPI via main/secure-store.js. A test
// asserts no column is even named like one.
import { DatabaseSync } from "node:sqlite";

export const SCHEMA_VERSION = 8;

// Append-only. To change the schema, add a function; never edit one that has shipped, because
// an operator's database has already run it.
const MIGRATIONS = [
  // -> version 1
  (db) => db.exec(`
    CREATE TABLE router (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      address     TEXT NOT NULL,
      first_seen  TEXT NOT NULL,
      last_seen   TEXT
    );

    -- A refreshed cache of the router's own state, never an authority. raw_comment holds the
    -- [bill ...] tag verbatim; parsing it is Stage 3's job.
    CREATE TABLE customer (
      router_id    TEXT NOT NULL,
      kind         TEXT NOT NULL,
      key          TEXT NOT NULL,
      raw_comment  TEXT,
      last_seen    TEXT NOT NULL,
      PRIMARY KEY (router_id, kind, key)
    );

    -- customer_key is the ledger's display NAME and does not reliably join to customer.key,
    -- which is a PPPoE secret name or an IPoE lease MAC. Stage 3 resolves that match.
    CREATE TABLE payment (
      id            INTEGER PRIMARY KEY,
      router_id     TEXT NOT NULL,
      customer_key  TEXT NOT NULL,
      kind          TEXT,
      amount        REAL NOT NULL,
      at            TEXT NOT NULL,
      ledger_key    TEXT,
      covers_from   TEXT,
      covers_to     TEXT,
      collected_by  TEXT,
      method        TEXT,
      source        TEXT NOT NULL,
      dedupe        TEXT NOT NULL UNIQUE
    );

    CREATE TABLE message (
      id         INTEGER PRIMARY KEY,
      router_id  TEXT NOT NULL,
      customer   TEXT NOT NULL,
      to_number  TEXT,
      at         TEXT NOT NULL,
      at_time    TEXT,
      stage      TEXT,
      state      TEXT NOT NULL,
      error      TEXT,
      source     TEXT NOT NULL,
      dedupe     TEXT NOT NULL UNIQUE
    );

    CREATE TABLE event (
      id            INTEGER PRIMARY KEY,
      router_id     TEXT,
      customer_key  TEXT,
      type          TEXT NOT NULL,
      at            TEXT NOT NULL,
      detail        TEXT,
      source        TEXT NOT NULL
    );

    -- No router_id: jf_sales_hist is a single global series. Attributing it to a router
    -- would invent data that was never recorded.
    CREATE TABLE sales_daily (
      d       TEXT PRIMARY KEY,
      v       REAL NOT NULL,
      source  TEXT NOT NULL
    );

    CREATE INDEX payment_by_router ON payment (router_id, customer_key);
    CREATE INDEX message_by_router ON message (router_id, customer);
  `),

  // -> version 2
  //
  // Stage 1 stored the [bill ...] tag verbatim and deferred parsing; this is where it becomes
  // readable. raw_comment STAYS - it is the evidence behind every column below, and keeping it is
  // what makes a parser bug diagnosable after the fact rather than only reproducible.
  //
  // All nullable, so the rows already mirrored into v1 survive and read as unparsed rather than as
  // a price of zero, which would be a lie about a customer nobody has tagged yet.
  //
  // src records which of the three router tables a customer came from. It is deliberately NOT part
  // of the primary key: the three sources key on three different namespaces - a secret name, a MAC,
  // an address - so it could never disambiguate two rows that (router_id, kind, key) does not.
  (db) => db.exec(`
    ALTER TABLE customer ADD COLUMN src   TEXT;
    ALTER TABLE customer ADD COLUMN name  TEXT;
    ALTER TABLE customer ADD COLUMN phone TEXT;
    ALTER TABLE customer ADD COLUMN plan  TEXT;
    ALTER TABLE customer ADD COLUMN price REAL;
    ALTER TABLE customer ADD COLUMN cycle TEXT;
    ALTER TABLE customer ADD COLUMN due   TEXT;
    ALTER TABLE customer ADD COLUMN paid  TEXT;
    ALTER TABLE customer ADD COLUMN bal   REAL;

    -- Current cut-off health, one row per router, rewritten on every check. Separate from the
    -- event log on purpose: event records TRANSITIONS, which answer "when did this break", while
    -- checked_at answers "when did we last look". Without the second, the absence of an event is
    -- ambiguous - it means either nothing changed or nobody checked, and those are opposite facts.
    CREATE TABLE cutoff_state (
      router_id   TEXT PRIMARY KEY,
      verdict     TEXT NOT NULL,   -- missing | stale | unscheduled | dry | ok
      version     INTEGER,
      grace       INTEGER,
      exp_profile TEXT,
      since       TEXT NOT NULL,   -- when this verdict was first seen
      checked_at  TEXT NOT NULL    -- YYYY-MM-DD, the day the check last ran
    );
  `),

  // -> version 3
  //
  // The optical plant planner. Nothing here relates to billing: a plant is a physical description
  // of fibre, and it is stored beside the billing cache only because there is one database.
  //
  // One self-referencing node table expresses all three levels of the real plant - taps on the
  // trunk (parent_id NULL), a box hanging off its tap, and NAPs nested under an LCP where the build
  // is two-stage. Both shapes this network uses are covered by the same table.
  (db) => db.exec(`
    CREATE TABLE plant (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      olt_tx_dbm   REAL NOT NULL,
      -- NULL means "the bottom of the class range". Planning on a best-case ONU blesses routes
      -- that fail with the ONUs actually deployed, and upstream is the direction that usually
      -- binds - so the pessimistic default is the safe one.
      onu_tx_dbm   REAL,
      gpon_class   TEXT NOT NULL,
      margin_db    REAL NOT NULL,
      -- NULL means "the tables this app shipped with". A plant planned against a supplier's own
      -- figures keeps them here, so correcting the shipped defaults later cannot silently restate
      -- what an already-built route was planned against.
      tables_json  TEXT,
      notes        TEXT,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    );

    CREATE TABLE plant_node (
      id          TEXT NOT NULL,
      plant_id    TEXT NOT NULL,
      parent_id   TEXT,
      seq         INTEGER NOT NULL,
      kind        TEXT NOT NULL,      -- tap | lcp | nap
      label       TEXT,
      span_km     REAL NOT NULL DEFAULT 0,
      tap_ratio   TEXT,
      splitter    INTEGER,
      customers   INTEGER,
      drop_km     REAL,
      connectors  INTEGER NOT NULL DEFAULT 0,
      splices     INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (plant_id, id)
    );

    CREATE INDEX plant_node_by_parent ON plant_node (plant_id, parent_id, seq);
  `),

  // -> version 4
  //
  // Customer-submitted GCash payment requests awaiting the owner's Telegram approval. The reference
  // is unverified text; only an owner approval turns a row from pending into a reconnect. dedupe is
  // router_id + ref so the same reference cannot be replayed on one router.
  (db) => db.exec(`
    CREATE TABLE payment_request (
      id            INTEGER PRIMARY KEY,
      router_id     TEXT NOT NULL,
      account       TEXT NOT NULL,
      customer_key  TEXT,
      ref           TEXT NOT NULL,
      amount        REAL NOT NULL,
      status        TEXT NOT NULL,          -- pending | approved | declined
      token         TEXT NOT NULL UNIQUE,   -- opaque handle the intake page polls
      tg_message_id TEXT,
      client_ip     TEXT,
      created_at    TEXT NOT NULL,
      decided_at    TEXT,
      dedupe        TEXT NOT NULL UNIQUE
    );
    CREATE INDEX payment_request_pending ON payment_request (router_id, status);
  `),

  // -> version 5
  //
  // Customer self-pay on /payment: a request is either this cycle's bill or a wallet top-up.
  // wallet is cached so the page can show the current credit without re-parsing raw_comment.
  (db) => db.exec(`
    ALTER TABLE payment_request ADD COLUMN purpose TEXT NOT NULL DEFAULT 'bill';
    ALTER TABLE customer ADD COLUMN wallet REAL;
  `),

  // -> version 6
  // Who approved a /payment request (staff name + cashier/admin). Sales rows already have
  // collected_by; this is the approval-history pane.
  (db) => db.exec(`
    ALTER TABLE payment_request ADD COLUMN decided_by TEXT;
    ALTER TABLE payment_request ADD COLUMN decided_role TEXT;
  `),

  // -> version 7
  // Operator desk: printed receipts, collector day-close, watchdog last-seen, install/repair jobs.
  // No credential columns. Receipt `code` is a public lookup handle, not a secret.
  (db) => db.exec(`
    CREATE TABLE receipt (
      id            INTEGER PRIMARY KEY,
      router_id     TEXT NOT NULL,
      customer_key  TEXT NOT NULL,
      account       TEXT,
      amount        REAL NOT NULL,
      due           TEXT,
      wallet        REAL,
      purpose       TEXT,
      method        TEXT,
      source        TEXT,
      ref           TEXT,
      collected_by  TEXT,
      at            TEXT NOT NULL,
      request_id    INTEGER,
      code          TEXT NOT NULL UNIQUE,
      body          TEXT NOT NULL
    );
    CREATE INDEX receipt_by_customer ON receipt (router_id, customer_key, id DESC);
    CREATE INDEX receipt_by_request ON receipt (request_id);

    CREATE TABLE remittance (
      id            INTEGER PRIMARY KEY,
      day           TEXT NOT NULL,
      collector     TEXT NOT NULL,
      role          TEXT,
      cash          REAL NOT NULL,
      digital       REAL NOT NULL,
      wallet        REAL NOT NULL,
      cash_counted  REAL NOT NULL,
      note          TEXT,
      created_at    TEXT NOT NULL,
      UNIQUE (day, collector)
    );

    CREATE TABLE watchdog_state (
      router_id       TEXT PRIMARY KEY,
      reachable       TEXT NOT NULL,
      cutoff          TEXT,
      clock_ok        INTEGER,
      last_alert_key  TEXT,
      last_export     TEXT,
      checked_at      TEXT NOT NULL
    );

    CREATE TABLE job_ticket (
      id            INTEGER PRIMARY KEY,
      router_id     TEXT NOT NULL,
      kind          TEXT NOT NULL,
      status        TEXT NOT NULL,
      name          TEXT NOT NULL,
      phone         TEXT,
      address       TEXT,
      plan          TEXT,
      link_kind     TEXT,
      customer_key  TEXT,
      assigned_to   TEXT,
      sla_hours     INTEGER,
      due_by        TEXT,
      note          TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL,
      closed_at     TEXT
    );
    CREATE INDEX job_ticket_open ON job_ticket (status, due_by);
  `),

  // -> version 8
  // Due reminder sequence (3 days, 1 day, due day). Unique per customer + due + stage so a
  // paid bill (new due) can be reminded again next cycle. No credential columns.
  (db) => db.exec(`
    CREATE TABLE due_remind (
      id            INTEGER PRIMARY KEY,
      router_id     TEXT NOT NULL,
      customer_key  TEXT NOT NULL,
      due           TEXT NOT NULL,
      stage         TEXT NOT NULL,
      amount        REAL,
      name          TEXT,
      phone         TEXT,
      at            TEXT NOT NULL,
      UNIQUE (router_id, customer_key, due, stage)
    );
    CREATE INDEX due_remind_by_day ON due_remind (at, id DESC);
  `),
];

export function migrate(db, migrations = MIGRATIONS) {
  let v = db.prepare("PRAGMA user_version").get().user_version;
  while (v < migrations.length) {
    // SQLite has transactional DDL, but exec() runs in autocommit: each CREATE in a
    // multi-statement migration commits on its own. Without this wrapper, a migration that
    // throws halfway leaves its earlier tables committed while user_version stays put — and
    // every later launch retries from the same version and dies on "table already exists",
    // with no route back for an operator whose database is already in that state.
    db.exec("BEGIN");
    try {
      migrations[v](db);
      v += 1;
      // PRAGMA cannot be parameterised. v is an integer from our own array index, never input.
      db.exec(`PRAGMA user_version = ${v}`);
      db.exec("COMMIT");
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch {}
      throw e;
    }
  }
  return v;
}

export function openStore(file) {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}
