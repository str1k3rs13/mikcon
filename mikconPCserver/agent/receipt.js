// Receipts for approved / wallet / gateway payments. Pure format + sqlite. No Telegram, no router.
import { randomUUID } from "node:crypto";

export function peso(n) {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  return "₱" + v.toLocaleString("en-PH", { minimumFractionDigits: v % 1 ? 2 : 0 });
}

export function formatReceipt(row) {
  const lines = [
    "MIKCON RECEIPT",
    row.code ? "#" + row.code.slice(0, 8) : "",
    String(row.account || row.customer_key || "Customer"),
    "Paid " + peso(row.amount),
  ];
  if (row.due) lines.push("New due " + row.due);
  if (row.wallet != null && row.wallet !== "") lines.push("Wallet " + peso(row.wallet));
  const how = [row.method, row.at].filter(Boolean).join(" · ");
  if (how) lines.push(how);
  if (row.collected_by) lines.push("Approved by " + row.collected_by);
  if (row.ref) lines.push("Ref " + row.ref);
  return lines.filter(Boolean).join("\n");
}

export function formatReceiptTelegram(row, esc) {
  const e = typeof esc === "function" ? esc : (s) => String(s == null ? "" : s);
  return (
    "🧾 <b>Receipt</b> #" + e(String(row.code || "").slice(0, 8)) + "\n" +
    e(row.account || row.customer_key || "Customer") + "\n" +
    "Paid " + e(peso(row.amount)) + "\n" +
    (row.due ? "New due " + e(row.due) + "\n" : "") +
    (row.wallet != null && row.wallet !== "" ? "Wallet " + e(peso(row.wallet)) + "\n" : "") +
    (row.collected_by ? "By " + e(row.collected_by) + "\n" : "") +
    (row.ref ? "Ref " + e(row.ref) : "")
  ).trim();
}

export function publicReceipt(row) {
  if (!row) return null;
  return {
    code: row.code,
    account: row.account || "",
    amount: Number(row.amount) || 0,
    due: row.due || "",
    wallet: row.wallet == null ? null : Number(row.wallet),
    at: row.at || "",
    method: row.method || "",
    collected_by: row.collected_by || "",
    text: row.body || formatReceipt(row),
  };
}

export function receiptFromOutcome({ row, customer, outcome, actor, today }) {
  const purpose = outcome && outcome.enoughWallet ? "wallet"
    : String((row && row.purpose) || (outcome && outcome.fullyPaid ? "bill" : "partial"));
  return {
    router_id: (row && row.router_id) || (customer && customer.router_id) || "",
    customer_key: (customer && customer.key) || (row && row.customer_key) || "",
    account: (row && row.account) || (customer && customer.name) || "",
    amount: (outcome && outcome.ledger && outcome.ledger.amount) || (row && row.amount) || 0,
    due: (outcome && outcome.due) || "",
    wallet: outcome && outcome.wallet != null ? outcome.wallet : (customer && customer.wallet),
    purpose,
    method: (outcome && outcome.ledger && outcome.ledger.method) || "",
    source: (outcome && outcome.ledger && outcome.ledger.source) || "",
    ref: (row && row.ref) || (outcome && outcome.ledger && outcome.ledger.ref) || "",
    collected_by: (actor && (actor.name || actor.by)) || "",
    at: today || "",
    request_id: row && row.id != null ? Number(row.id) : null,
  };
}

export function makeReceiptStore({ db, clock, code = randomUUID }) {
  const insert = db.prepare(`
    INSERT INTO receipt
      (router_id, customer_key, account, amount, due, wallet, purpose, method, source, ref,
       collected_by, at, request_id, code, body)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const byCodeStmt = db.prepare("SELECT * FROM receipt WHERE code = ?");
  const byRequestStmt = db.prepare(
    "SELECT * FROM receipt WHERE request_id = ? ORDER BY id DESC LIMIT 1");
  const lastCustStmt = db.prepare(
    "SELECT * FROM receipt WHERE router_id = ? AND customer_key = ? ORDER BY id DESC LIMIT 1");
  const listStmt = db.prepare("SELECT * FROM receipt ORDER BY id DESC LIMIT 80");

  function record(input) {
    const today = (clock && clock.today && clock.today()) || String(input.at || "");
    const rec = {
      ...input,
      at: input.at || today,
      code: input.code || String(code()),
    };
    rec.body = input.body || formatReceipt(rec);
    const info = insert.run(
      String(rec.router_id || ""),
      String(rec.customer_key || ""),
      rec.account == null ? null : String(rec.account),
      Number(rec.amount) || 0,
      rec.due == null ? null : String(rec.due),
      rec.wallet == null || rec.wallet === "" ? null : Number(rec.wallet),
      rec.purpose == null ? null : String(rec.purpose),
      rec.method == null ? null : String(rec.method),
      rec.source == null ? null : String(rec.source),
      rec.ref == null ? null : String(rec.ref),
      rec.collected_by == null ? null : String(rec.collected_by),
      rec.at,
      rec.request_id == null ? null : Number(rec.request_id),
      rec.code,
      rec.body
    );
    return byId(Number(info.lastInsertRowid));
  }

  function byId(id) {
    return db.prepare("SELECT * FROM receipt WHERE id = ?").get(Number(id)) || null;
  }

  function byCode(c) {
    return c ? (byCodeStmt.get(String(c)) || null) : null;
  }

  function lastForRequest(id) {
    if (id == null) return null;
    return byRequestStmt.get(Number(id)) || null;
  }

  function lastForCustomer(routerId, key) {
    if (!routerId || !key) return null;
    return lastCustStmt.get(String(routerId), String(key)) || null;
  }

  function listRecent() {
    return listStmt.all();
  }

  return { record, byId, byCode, lastForRequest, lastForCustomer, listRecent };
}
