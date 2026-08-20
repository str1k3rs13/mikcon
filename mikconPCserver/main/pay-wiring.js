// Small, directly-testable wiring helpers for the payment-reminder feature (Task 9), factored out
// of main/agent-host.js so they can be unit-tested against openStore(":memory:") with no Electron,
// no BrowserWindow, no DPAPI store. agent-host.js is still the only place that assembles these into
// the running app under the licence gate — this module only builds the two pieces that talk to the
// shared sqlite handle directly.
//
//   - makeRecordPayment: the idempotency fix carried over from Task 8's review. A Telegram retry
//     (or a crash between recordPayment and payStore.decide) must not double-record the same GCash
//     ref, so the insert is deduped on (router_id, ref) via the payment table's UNIQUE dedupe column
//     and ON CONFLICT DO NOTHING — a repeated approval of the same reference records the money AT
//     MOST ONCE.
//   - makeResolveCustomers: the customer cache read pay-bot and pay-server both need to match a
//     submitted account against a known customer. Read-only, one router at a time.
export function makeRecordPayment(db) {
  const insert = db.prepare(`
    INSERT INTO payment (router_id, customer_key, kind, amount, at, collected_by, method, source, dedupe)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(dedupe) DO NOTHING
  `);
  return function recordPayment(ledger) {
    const dedupe = "reminder:" + ledger.router_id + ":" + ledger.ref;
    insert.run(
      String(ledger.router_id || ""),
      String(ledger.customer_key || ""),
      ledger.kind == null ? null : String(ledger.kind),
      Number(ledger.amount) || 0,
      String(ledger.at || ""),
      ledger.collected_by == null ? null : String(ledger.collected_by),
      ledger.method == null ? null : String(ledger.method),
      String(ledger.source || ""),
      dedupe
    );
  };
}

export function makeListSales(db) {
  const stmt = db.prepare(`
    SELECT p.id, p.router_id, p.customer_key, p.kind, p.amount, p.at, p.collected_by,
           p.method, p.source, COALESCE(c.name, p.customer_key) AS account
    FROM payment p
    LEFT JOIN customer c ON c.router_id = p.router_id AND c.key = p.customer_key
    ORDER BY p.at DESC, p.id DESC
    LIMIT 300`);
  return function listSales(routerId) {
    const rows = stmt.all();
    if (routerId == null || routerId === "") return rows;
    return rows.filter((r) => String(r.router_id) === String(routerId));
  };
}

export function makeResolveCustomers(db) {
  const stmt = db.prepare(
    "SELECT kind,key,name,phone,plan,price,cycle,due,paid,bal,wallet,raw_comment FROM customer WHERE router_id=?");
  return function resolveCustomers(routerId) {
    return stmt.all(String(routerId));
  };
}
