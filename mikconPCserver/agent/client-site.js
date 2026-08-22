// Operator-entered client location + NAP/drop ports, joined to billing cache and live sessions.

export function siteStatus({ online, due, today }) {
  const d = String(due || "").slice(0, 10);
  const t = String(today || "").slice(0, 10);
  if (d && t && d < t) return "expired";
  if (online) return "online";
  return "offline";
}

export function parseCoord(v, min, max) {
  if (v == null || String(v).trim() === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

function trim(v, cap) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return cap ? s.slice(0, cap) : s;
}

function decorate(row, today) {
  if (!row) return null;
  const online = Number(row.live) === 1;
  const status = siteStatus({ online, due: row.due, today });
  const lat = row.lat == null || row.lat === "" ? null : Number(row.lat);
  const lng = row.lng == null || row.lng === "" ? null : Number(row.lng);
  const mapped = Number.isFinite(lat) && Number.isFinite(lng);
  return {
    router_id: row.router_id,
    customer_key: row.customer_key,
    kind: row.kind || "",
    name: row.name || row.cust_name || row.customer_key,
    nap_name: row.nap_name || "",
    nap_port: row.nap_port || "",
    drop_port: row.drop_port || "",
    lat: mapped ? lat : null,
    lng: mapped ? lng : null,
    note: row.note || "",
    updated_at: row.updated_at || "",
    plan: row.plan || "",
    due: row.due || "",
    paid: row.paid || "",
    phone: row.phone || "",
    online,
    mapped,
    status,
  };
}

export function makeClientSiteStore({ db, clock }) {
  const listStmt = db.prepare(`
    SELECT s.router_id, s.customer_key, s.name, s.nap_name, s.nap_port, s.drop_port,
           s.lat, s.lng, s.note, s.updated_at,
           c.name AS cust_name, c.plan, c.due, c.paid, c.phone,
           CASE WHEN sl.name IS NULL THEN 0 ELSE 1 END AS live
    FROM client_site s
    LEFT JOIN (
      SELECT router_id, key,
             MAX(name) AS name, MAX(plan) AS plan, MAX(due) AS due,
             MAX(paid) AS paid, MAX(phone) AS phone
      FROM customer
      GROUP BY router_id, key
    ) c ON c.router_id = s.router_id AND c.key = s.customer_key
    LEFT JOIN session_live sl ON sl.router_id = s.router_id AND sl.name = s.customer_key
    WHERE (? = '' OR s.router_id = ?)
    ORDER BY COALESCE(s.name, s.customer_key)
  `);
  const oneStmt = db.prepare(`
    SELECT s.router_id, s.customer_key, s.name, s.nap_name, s.nap_port, s.drop_port,
           s.lat, s.lng, s.note, s.updated_at,
           c.name AS cust_name, c.plan, c.due, c.paid, c.phone,
           CASE WHEN sl.name IS NULL THEN 0 ELSE 1 END AS live
    FROM client_site s
    LEFT JOIN (
      SELECT router_id, key,
             MAX(name) AS name, MAX(plan) AS plan, MAX(due) AS due,
             MAX(paid) AS paid, MAX(phone) AS phone
      FROM customer
      GROUP BY router_id, key
    ) c ON c.router_id = s.router_id AND c.key = s.customer_key
    LEFT JOIN session_live sl ON sl.router_id = s.router_id AND sl.name = s.customer_key
    WHERE s.router_id = ? AND s.customer_key = ?
  `);
  const customersStmt = db.prepare(`
    SELECT c.router_id, c.kind, c.key, c.name, c.plan, c.due, c.paid, c.phone,
           CASE WHEN sl.name IS NULL THEN 0 ELSE 1 END AS live
    FROM customer c
    LEFT JOIN session_live sl ON sl.router_id = c.router_id AND sl.name = c.key
    WHERE (? = '' OR c.router_id = ?)
    ORDER BY c.name, c.key
    LIMIT 800
  `);
  const upsert = db.prepare(`
    INSERT INTO client_site
      (router_id, customer_key, name, nap_name, nap_port, drop_port, lat, lng, note, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(router_id, customer_key) DO UPDATE SET
      name      = excluded.name,
      nap_name  = excluded.nap_name,
      nap_port  = excluded.nap_port,
      drop_port = excluded.drop_port,
      lat       = excluded.lat,
      lng       = excluded.lng,
      note      = excluded.note,
      updated_at = excluded.updated_at
  `);
  const del = db.prepare("DELETE FROM client_site WHERE router_id = ? AND customer_key = ?");

  function today() {
    return (clock && clock.today && clock.today()) || "";
  }

  function list(routerId) {
    const rid = String(routerId || "");
    const day = today();
    const byKey = new Map();
    for (const c of customersStmt.all(rid, rid)) {
      const id = String(c.router_id) + "\0" + String(c.key);
      const prev = byKey.get(id);
      if (prev && prev.kind === "ppp" && c.kind !== "ppp") continue;
      byKey.set(id, decorate({
        router_id: c.router_id,
        customer_key: c.key,
        kind: c.kind,
        name: c.name,
        cust_name: c.name,
        nap_name: "",
        nap_port: "",
        drop_port: "",
        lat: null,
        lng: null,
        note: "",
        plan: c.plan,
        due: c.due,
        paid: c.paid,
        phone: c.phone,
        live: c.live,
      }, day));
    }
    for (const s of listStmt.all(rid, rid)) {
      const id = String(s.router_id) + "\0" + String(s.customer_key);
      const pin = decorate({ ...s, kind: (byKey.get(id) && byKey.get(id).kind) || s.kind }, day);
      const prev = byKey.get(id);
      if (prev) {
        pin.kind = pin.kind || prev.kind;
        if (!pin.name) pin.name = prev.name;
        if (!pin.plan) pin.plan = prev.plan;
        if (!pin.due) pin.due = prev.due;
        if (!pin.phone) pin.phone = prev.phone;
      }
      byKey.set(id, pin);
    }
    return Array.from(byKey.values()).sort((a, b) =>
      String(a.name || a.customer_key).localeCompare(String(b.name || b.customer_key)));
  }

  function customers(routerId) {
    const rid = String(routerId || "");
    return customersStmt.all(rid, rid);
  }

  function get(routerId, customerKey) {
    return decorate(oneStmt.get(String(routerId || ""), String(customerKey || "")), today());
  }

  function save(input) {
    const router_id = String((input && input.router_id) || "").trim();
    const customer_key = String((input && input.customer_key) || "").trim();
    if (!customer_key) return { ok: false, error: "Client username / MAC is required." };
    const latIn = input && input.lat;
    const lngIn = input && input.lng;
    const lat = parseCoord(latIn, -90, 90);
    const lng = parseCoord(lngIn, -180, 180);
    if (latIn != null && String(latIn).trim() !== "" && lat == null) {
      return { ok: false, error: "Latitude must be a number from -90 to 90." };
    }
    if (lngIn != null && String(lngIn).trim() !== "" && lng == null) {
      return { ok: false, error: "Longitude must be a number from -180 to 180." };
    }
    upsert.run(
      router_id,
      customer_key,
      trim(input && input.name, 80),
      trim(input && input.nap_name, 80),
      trim(input && input.nap_port, 40),
      trim(input && input.drop_port, 40),
      lat,
      lng,
      trim(input && input.note, 400),
      today()
    );
    return { ok: true, row: get(router_id, customer_key) };
  }

  function remove(routerId, customerKey) {
    const info = del.run(String(routerId || ""), String(customerKey || ""));
    return { ok: true, deleted: Number(info.changes) || 0 };
  }

  return { list, customers, get, save, remove };
}
