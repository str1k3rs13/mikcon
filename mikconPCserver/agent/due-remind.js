// Due-date reminder sequence: 3 days before, 1 day before, then due day.
// One send per customer per due date per stage. A later due (after pay or wallet
// renew) is a new cycle. Overdue is the cut-off script's job, not this list.
import { amountDue } from "./last-name.js";
import { peso } from "./receipt.js";

export const STAGES = [
  { id: "d3", days: 3, when: "in 3 days" },
  { id: "d1", days: 1, when: "tomorrow" },
  { id: "due", days: 0, when: "today" },
];

export const PASS_CAP = 40;

function parseYmd(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || "").slice(0, 10));
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export function daysUntil(due, today) {
  const a = parseYmd(due);
  const b = parseYmd(today);
  if (a == null || b == null) return null;
  return Math.round((a - b) / 86400000);
}

export function stageFor(days) {
  if (days !== 0 && days !== 1 && days !== 3) return null;
  return STAGES.find((s) => s.days === days) || null;
}

export function remindDedupe(customer, due, stage) {
  return [
    String((customer && customer.router_id) || ""),
    String((customer && customer.key) || ""),
    String(due || "").slice(0, 10),
    String(stage || ""),
  ].join("|");
}

export function nextReminder({ customer, today, already }) {
  const c = customer || {};
  if (!String(c.key || "").trim()) return null;
  const due = String(c.due || "").slice(0, 10);
  const days = daysUntil(due, today);
  const stage = stageFor(days);
  if (!stage) return null;
  if (amountDue(c) <= 0) return null;
  const dedupe = remindDedupe(c, due, stage.id);
  if (already && already.has(stage.id)) return null;
  return {
    stage: stage.id,
    when: stage.when,
    days,
    due,
    amount: amountDue(c),
    name: String(c.name || c.key || "Customer"),
    phone: String(c.phone || ""),
    plan: String(c.plan || ""),
    key: String(c.key || ""),
    router_id: String(c.router_id || ""),
    dedupe,
  };
}

export function formatRemindSms(row, { payUrl, site } = {}) {
  const lines = [
    "Bill reminder",
    String(row.name || row.key || "Customer"),
    "Due " + String(row.when || row.stage) + " (" + String(row.due) + ")",
    "Amount " + peso(row.amount),
  ];
  if (row.plan) lines.push("Plan " + String(row.plan));
  if (site) lines.push(String(site));
  if (payUrl) lines.push("Pay at " + String(payUrl));
  return lines.join("\n");
}

export function formatRemindTelegram(row, { esc, payUrl, site } = {}) {
  const e = typeof esc === "function" ? esc : (s) => String(s == null ? "" : s);
  const lines = [
    "<b>Bill reminder</b>",
    e(row.name || row.key || "Customer"),
    "Due " + e(row.when || row.stage) + " (" + e(row.due) + ")",
    "Amount " + e(peso(row.amount)),
  ];
  if (row.plan) lines.push("Plan " + e(row.plan));
  if (site) lines.push(e(site));
  if (row.phone) lines.push(e(row.phone));
  if (payUrl) lines.push("Pay at " + e(payUrl));
  return lines.join("\n");
}

export function makeDueRemindStore(db) {
  const hasStmt = db.prepare(
    "SELECT 1 AS ok FROM due_remind WHERE router_id = ? AND customer_key = ? AND due = ? AND stage = ?");
  const ins = db.prepare(`
    INSERT OR IGNORE INTO due_remind
      (router_id, customer_key, due, stage, amount, name, phone, at)
    VALUES (?,?,?,?,?,?,?,?)`);
  const listStmt = db.prepare("SELECT * FROM due_remind ORDER BY id DESC LIMIT ?");
  const todayStmt = db.prepare("SELECT * FROM due_remind WHERE at = ? ORDER BY id DESC");

  function has(routerId, key, due, stage) {
    return !!hasStmt.get(String(routerId || ""), String(key || ""), String(due || "").slice(0, 10), String(stage || ""));
  }

  function record(row) {
    const info = ins.run(
      String(row.router_id || ""),
      String(row.customer_key || row.key || ""),
      String(row.due || "").slice(0, 10),
      String(row.stage || ""),
      row.amount == null ? null : Number(row.amount),
      row.name == null ? null : String(row.name),
      row.phone == null ? null : String(row.phone),
      String(row.at || "")
    );
    return info.changes > 0;
  }

  function listRecent(limit = 50) {
    return listStmt.all(Math.max(1, Math.min(200, Number(limit) || 50)));
  }

  function listToday(day) {
    return todayStmt.all(String(day || ""));
  }

  return { has, record, listRecent, listToday };
}
