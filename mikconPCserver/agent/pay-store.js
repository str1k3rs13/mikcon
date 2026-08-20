// Thin accessor for the payment_request table (schema v4). Customer-submitted GCash payment
// requests awaiting the owner's Telegram approval — the reference is unverified text; only an
// owner decide() turns a row from pending into approved/declined. Pure persistence: no Telegram,
// no router calls, no Electron. The intake server (create/byToken) and the approval bot loop
// (listPending/decide/setMessageId) both build on this.
import { randomUUID } from "node:crypto";
import { dedupeKey } from "./pay-request.js";

export function normalizeActor(raw) {
  const o = raw && typeof raw === "object" ? raw : {};
  let role = String(o.role || "").trim().toLowerCase();
  if (role === "owner") role = "admin";
  const name = String(o.by || o.name || "").trim().slice(0, 80);
  if (role === "cashier" || role === "technician") return { name: name || "Staff", role };
  if (role === "system") return { name: name || "Wallet", role: "system" };
  return { name: name || "Admin", role: "admin" };
}

export function actorCanClearHistory(actor) {
  return normalizeActor(actor).role === "admin";
}

export function makePayStore({ db, clock, token = randomUUID }) {
  const insert = db.prepare(`
    INSERT INTO payment_request
      (router_id, account, customer_key, ref, amount, status, token, tg_message_id,
       client_ip, created_at, decided_at, dedupe, purpose)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL, ?, ?, NULL, ?, ?)
  `);
  const byTokenStmt = db.prepare("SELECT * FROM payment_request WHERE token = ?");
  const byRefStmt = db.prepare("SELECT * FROM payment_request WHERE router_id = ? AND ref = ?");
  const byIdStmt = db.prepare("SELECT * FROM payment_request WHERE id = ?");
  const listPendingStmt = db.prepare(
    "SELECT * FROM payment_request WHERE router_id = ? AND status = 'pending' ORDER BY created_at, id");
  const decideStmt = db.prepare(`
    UPDATE payment_request SET status = ?, tg_message_id = COALESCE(?, tg_message_id), decided_at = ?,
      decided_by = ?, decided_role = ?
    WHERE id = ? AND status = 'pending'
  `);
  const setMessageIdStmt = db.prepare("UPDATE payment_request SET tg_message_id = ? WHERE id = ?");
  const listHistoryStmt = db.prepare(`
    SELECT * FROM payment_request WHERE status IN ('approved','declined')
    ORDER BY decided_at DESC, id DESC LIMIT 200`);
  const clearHistoryStmt = db.prepare(
    "DELETE FROM payment_request WHERE status IN ('approved','declined')");

  function create({ routerId, request, customerKey, clientIp, purpose }) {
    const tk = token();
    const dedupe = dedupeKey(routerId, request.ref);
    const kind = String(purpose || request.purpose || "bill").toLowerCase() === "topup" ? "topup" : "bill";
    const info = insert.run(
      String(routerId), String(request.account), customerKey == null ? null : String(customerKey),
      String(request.ref), Number(request.amount), tk, clientIp == null ? null : String(clientIp),
      clock.today(), dedupe, kind);
    return { id: Number(info.lastInsertRowid), token: tk };
  }

  function byToken(tk) {
    return byTokenStmt.get(String(tk)) || null;
  }

  function byRef(routerId, ref) {
    return byRefStmt.get(String(routerId), String(ref)) || null;
  }

  function byId(id) {
    return byIdStmt.get(Number(id)) || null;
  }

  function listPending(routerId) {
    return listPendingStmt.all(String(routerId));
  }

  function decide(id, status, { messageId, by, role } = {}) {
    const actor = normalizeActor({ by, role, name: by });
    decideStmt.run(
      String(status),
      messageId == null ? null : String(messageId),
      clock.today(),
      actor.name,
      actor.role,
      Number(id)
    );
    return byIdStmt.get(Number(id));
  }

  function setMessageId(id, messageId) {
    setMessageIdStmt.run(String(messageId), Number(id));
  }

  function listHistory() {
    return listHistoryStmt.all();
  }

  function clearHistory() {
    const info = clearHistoryStmt.run();
    return { ok: true, removed: Number(info.changes) || 0 };
  }

  return { create, byToken, byRef, byId, listPending, decide, setMessageId, listHistory, clearHistory };
}
