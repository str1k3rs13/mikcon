// Install / repair jobs. Close only when the billed client exists on the router cache.

const INSTALL = ["open", "survey", "assigned", "closed"];
const REPAIR = ["open", "assigned", "closed"];

export function slaHoursFor(kind) {
  return String(kind || "") === "repair" ? 24 : 48;
}

export function addHours(ymdHm, hours) {
  const raw = String(ymdHm || "");
  const d = raw.length >= 10 ? new Date(raw.slice(0, 10) + "T" + (raw.slice(11, 19) || "00:00:00")) : new Date(NaN);
  if (Number.isNaN(d.getTime())) return raw;
  d.setHours(d.getHours() + (Number(hours) || 0));
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return y + "-" + m + "-" + day + " " + hh + ":" + mm;
}

export function isOverdue(ticket, nowYmd) {
  if (!ticket || ticket.status === "closed" || ticket.status === "cancelled") return false;
  const due = String(ticket.due_by || "").slice(0, 10);
  return !!(due && nowYmd && due < String(nowYmd));
}

export function nextStatus(kind, current, action) {
  const chain = String(kind) === "repair" ? REPAIR : INSTALL;
  const cur = String(current || "open");
  if (action === "cancel") return cur === "closed" ? cur : "cancelled";
  if (action === "close") return "closed";
  if (action === "assign") return chain.includes("assigned") ? "assigned" : cur;
  if (action === "survey") return String(kind) === "install" && cur === "open" ? "survey" : cur;
  const i = chain.indexOf(cur);
  if (action === "advance" && i >= 0 && i < chain.length - 1) return chain[i + 1];
  return cur;
}

export function planMatches(ticketPlan, customerPlan) {
  const a = String(ticketPlan || "").trim().toLowerCase();
  const b = String(customerPlan || "").trim().toLowerCase();
  if (!a) return true;
  return a === b;
}

export function canClose({ ticket, customer }) {
  if (!ticket) return { ok: false, error: "Ticket not found." };
  if (ticket.status === "closed") return { ok: false, error: "Already closed." };
  if (ticket.status === "cancelled") return { ok: false, error: "Cancelled tickets cannot be closed." };
  if (!customer) {
    return { ok: false, error: "Client is not on this router yet. Add the PPPoE or IPoE row first." };
  }
  if (!planMatches(ticket.plan, customer.plan)) {
    return {
      ok: false,
      error: "Plan on the router is " + (customer.plan || "(none)") + ", ticket is " + ticket.plan + ".",
    };
  }
  return { ok: true };
}

export function makeJobStore({ db, clock, nowStamp }) {
  const stamp = () => {
    if (nowStamp) return nowStamp();
    const d = (clock && clock.now && clock.now()) || new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return y + "-" + m + "-" + day + " " + hh + ":" + mm;
  };
  const insert = db.prepare(`
    INSERT INTO job_ticket
      (router_id, kind, status, name, phone, address, plan, link_kind, customer_key,
       assigned_to, sla_hours, due_by, note, created_at, updated_at, closed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)
  `);
  const byIdStmt = db.prepare("SELECT * FROM job_ticket WHERE id = ?");
  const listStmt = db.prepare("SELECT * FROM job_ticket ORDER BY id DESC LIMIT 120");

  function create(input) {
    const kind = String(input.kind || "install") === "repair" ? "repair" : "install";
    const sla = Number(input.sla_hours) > 0 ? Number(input.sla_hours) : slaHoursFor(kind);
    const created = stamp();
    const info = insert.run(
      String(input.router_id || ""),
      kind,
      "open",
      String(input.name || "").trim() || "Customer",
      input.phone == null ? null : String(input.phone),
      input.address == null ? null : String(input.address),
      input.plan == null ? null : String(input.plan),
      input.link_kind == null ? null : String(input.link_kind),
      input.customer_key == null ? null : String(input.customer_key),
      input.assigned_to == null ? null : String(input.assigned_to),
      sla,
      addHours(created, sla),
      input.note == null ? null : String(input.note).slice(0, 400),
      created,
      created
    );
    return byId(Number(info.lastInsertRowid));
  }

  function byId(id) {
    return byIdStmt.get(Number(id)) || null;
  }

  function list() {
    const today = clock.today();
    return listStmt.all().map((t) => ({ ...t, overdue: isOverdue(t, today) }));
  }

  function update(id, patch) {
    const cur = byId(id);
    if (!cur) return null;
    const next = { ...cur, ...patch, id: cur.id, updated_at: stamp() };
    db.prepare(`
      UPDATE job_ticket SET status=?, name=?, phone=?, address=?, plan=?, link_kind=?,
        customer_key=?, assigned_to=?, note=?, updated_at=?, closed_at=?
      WHERE id=?
    `).run(
      next.status, next.name, next.phone, next.address, next.plan, next.link_kind,
      next.customer_key, next.assigned_to, next.note, next.updated_at, next.closed_at || null,
      cur.id
    );
    return byId(cur.id);
  }

  function advance(id, action, extra) {
    const cur = byId(id);
    if (!cur) return { ok: false, error: "Ticket not found." };
    const status = nextStatus(cur.kind, cur.status, action);
    const patch = { ...(extra || {}), status };
    if (action === "assign" && extra && extra.assigned_to) patch.assigned_to = extra.assigned_to;
    if (status === "cancelled") return { ok: true, row: update(id, patch) };
    return { ok: true, row: update(id, patch) };
  }

  function close(id, { customer, customer_key } = {}) {
    const cur = byId(id);
    const check = canClose({ ticket: cur, customer });
    if (!check.ok) return check;
    const row = update(id, {
      status: "closed",
      closed_at: stamp(),
      customer_key: customer_key || (customer && customer.key) || cur.customer_key,
    });
    return { ok: true, row };
  }

  return { create, byId, list, update, advance, close };
}
