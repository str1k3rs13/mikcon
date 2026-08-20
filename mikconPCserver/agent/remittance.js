// Collector day-close. Cash counted vs what this PIN recorded today. No router I/O.

export function classifyMethod(method, source) {
  const m = String(method || "").toLowerCase();
  const s = String(source || "").toLowerCase();
  if (m === "wallet" || s === "wallet-renew") return "wallet";
  if (m === "cash" || m === "collect") return "cash";
  return "digital";
}

export function summarizeDay(payments, { day, collector } = {}) {
  const who = String(collector || "").trim().toLowerCase();
  const d = String(day || "");
  const out = { day: d, collector: collector || "", cash: 0, digital: 0, wallet: 0, count: 0, rows: [] };
  for (const p of payments || []) {
    if (d && String(p.at || "") !== d) continue;
    if (who && String(p.collected_by || "").trim().toLowerCase() !== who) continue;
    const kind = classifyMethod(p.method, p.source);
    const amt = Number(p.amount) || 0;
    out[kind] += amt;
    out.count += 1;
    out.rows.push(p);
  }
  out.cash = Math.round(out.cash * 100) / 100;
  out.digital = Math.round(out.digital * 100) / 100;
  out.wallet = Math.round(out.wallet * 100) / 100;
  return out;
}

export function shortage(expectedCash, counted) {
  return Math.round(((Number(expectedCash) || 0) - (Number(counted) || 0)) * 100) / 100;
}

export function makeRemittanceStore({ db, clock }) {
  const insert = db.prepare(`
    INSERT INTO remittance (day, collector, role, cash, digital, wallet, cash_counted, note, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)
  `);
  const byDayCollector = db.prepare("SELECT * FROM remittance WHERE day = ? AND collector = ?");
  const listStmt = db.prepare("SELECT * FROM remittance ORDER BY day DESC, id DESC LIMIT 60");
  const listMine = db.prepare(
    "SELECT * FROM remittance WHERE collector = ? ORDER BY day DESC, id DESC LIMIT 60");

  function closeDay({ collector, role, cash, digital, wallet, cashCounted, note }) {
    const day = clock.today();
    const name = String(collector || "").trim() || "Staff";
    const existing = byDayCollector.get(day, name);
    if (existing) return { ok: false, error: "Already closed today.", row: existing };
    const info = insert.run(
      day, name, role == null ? null : String(role),
      Number(cash) || 0, Number(digital) || 0, Number(wallet) || 0,
      Number(cashCounted) || 0,
      note == null ? null : String(note).slice(0, 200),
      day
    );
    const row = db.prepare("SELECT * FROM remittance WHERE id = ?").get(Number(info.lastInsertRowid));
    return { ok: true, row: { ...row, short: shortage(row.cash, row.cash_counted) } };
  }

  function list(actor) {
    const role = String((actor && actor.role) || "").toLowerCase();
    const name = String((actor && (actor.name || actor.by)) || "").trim();
    const rows = role === "admin" || role === "owner" || !name ? listStmt.all() : listMine.all(name);
    return rows.map((r) => ({ ...r, short: shortage(r.cash, r.cash_counted) }));
  }

  function todayOf(collector) {
    return byDayCollector.get(clock.today(), String(collector || "").trim()) || null;
  }

  return { closeDay, list, todayOf, summarizeDay };
}
