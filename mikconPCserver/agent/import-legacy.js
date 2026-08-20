// Imports the app's existing localStorage history into the agent's database.
//
// This runs on EVERY sync, not once, so it must be safe to run repeatedly — which also makes
// it the live mirror: there is no separate mirroring path that could drift from it. Every row
// carries a `dedupe` string with a UNIQUE constraint and is inserted with INSERT OR IGNORE.
//
// localStorage stays the payment ledger of record. Nothing here is ever written back to it.
import { createHash } from "node:crypto";

const str = (v) => (v == null ? "" : String(v));
// Number("") and Number("   ") coerce to 0, which is finite — that silently turns an absent
// amount into a real ₱0 payment recorded against a real customer. Trim first and require the
// remainder to be non-empty so an absent amount is rejected rather than recorded as money paid.
const num = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Short, stable content hash for rows that carry no key of their own.
const hash = (parts) => createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);

// The ledger key is "name|due", taken before the cycle advanced, so the date in it names the
// cycle the money settled. "Ana|2026-07-01#2" is the second cycle paid in the same visit.
export function coversFromLedgerKey(k) {
  const key = str(k);
  if (!key) return null;
  const bar = key.lastIndexOf("|");
  if (bar < 0) return null;
  const due = key.slice(bar + 1).replace(/#\d+$/, "");
  return DATE_RE.test(due) ? due : null;
}

// Keyless rows dedupe on content plus how many identical rows preceded them. This is stable
// under the 500-row cap: if one of two identical rows is shifted off the front, the survivor
// takes occurrence 1 — which already exists, so nothing is duplicated. A genuinely new
// identical payment appends at occurrence 2 and is correctly recorded as a second payment.
function withOccurrence(rows, keyOf) {
  const seen = new Map();
  return rows.map((row) => {
    const base = keyOf(row);
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return { row, dedupe: `${base}#${n}` };
  });
}

export function importSnapshot(db, snapshot, opts = {}) {
  const source = opts.source || "import";
  const seenAt = opts.at || new Date().toISOString().slice(0, 10);
  const snap = snapshot || {};
  // `payments` and `messages` count rows actually INSERTED, which is what makes a second run
  // report zero and is what the idempotence test asserts. `routers` and `sales` are upserts
  // with no meaningful insert/update distinction, so they count rows processed.
  const counts = { routers: 0, payments: 0, messages: 0, sales: 0 };

  const insRouter = db.prepare(`
    INSERT INTO router (id,name,address,first_seen,last_seen) VALUES (?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, address=excluded.address, last_seen=excluded.last_seen`);
  const insPayment = db.prepare(`
    INSERT OR IGNORE INTO payment
      (router_id,customer_key,kind,amount,at,ledger_key,covers_from,covers_to,source,dedupe)
    VALUES (?,?,?,?,?,?,?,NULL,?,?)`);
  const insMessage = db.prepare(`
    INSERT OR IGNORE INTO message
      (router_id,customer,to_number,at,at_time,stage,state,error,source,dedupe)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const insSales = db.prepare(`
    INSERT INTO sales_daily (d,v,source) VALUES (?,?,?)
    ON CONFLICT(d) DO UPDATE SET v=excluded.v, source=excluded.source`);

  for (const r of snap.routers || []) {
    if (!r || !str(r.id)) continue;
    insRouter.run(str(r.id), str(r.name), str(r.address), seenAt, seenAt);
    counts.routers += 1;
  }

  for (const [routerId, rows] of Object.entries(snap.ledgers || {})) {
    // `at` must be a real recorded date: a blank one would satisfy `WHERE at BETWEEN ...` never
    // and `SUM(amount)` always, so two reports built from the same table would disagree.
    const clean = (rows || []).filter((r) => r && str(r.n) && num(r.a) != null && DATE_RE.test(str(r.at)));
    // Keyed rows dedupe on router+key+record-date, not key alone: the ledger caps at 500 rows,
    // so once a "name|due" key is evicted, ledgerFreeKey() can re-mint that exact key for a
    // genuinely new payment. `at` is written once by ledgerAdd() and never mutated, so it is
    // what tells a recurrence apart from the original. Keyless rows have no key at all, so
    // they need an occurrence index instead.
    const keyed = clean.filter((r) => str(r.k));
    const keyless = withOccurrence(
      clean.filter((r) => !str(r.k)),
      (r) => `${routerId}|~${hash([str(r.n), num(r.a), str(r.at), str(r.t)])}`);

    for (const r of keyed) {
      const res = insPayment.run(routerId, str(r.n), str(r.t) || null, num(r.a), str(r.at),
        str(r.k), coversFromLedgerKey(r.k), source, `${routerId}|${str(r.k)}|${str(r.at)}`);
      if (res.changes) counts.payments += 1;
    }
    for (const { row: r, dedupe } of keyless) {
      const res = insPayment.run(routerId, str(r.n), str(r.t) || null, num(r.a), str(r.at),
        null, null, source, dedupe);
      if (res.changes) counts.payments += 1;
    }
  }

  for (const [routerId, rows] of Object.entries(snap.smslogs || {})) {
    const clean = (rows || []).filter((r) => r && str(r.n));
    const withOcc = withOccurrence(clean, (r) =>
      `${routerId}|${hash([str(r.n), str(r.to), str(r.at), str(r.tm), str(r.k), str(r.st)])}`);
    for (const { row: r, dedupe } of withOcc) {
      const res = insMessage.run(routerId, str(r.n), str(r.to) || null, str(r.at), str(r.tm) || null,
        str(r.k) || null, str(r.st) || "sent", str(r.e) || null, source, dedupe);
      if (res.changes) counts.messages += 1;
    }
  }

  for (const s of snap.sales || []) {
    if (!s || !DATE_RE.test(str(s.d)) || num(s.v) == null) continue;
    insSales.run(str(s.d), num(s.v), source);
    counts.sales += 1;
  }

  return counts;
}
