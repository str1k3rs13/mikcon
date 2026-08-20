// Router watchdog: one Telegram per transition, nightly JSON export, no spam.
// Pure decisions live here. I/O (exec, Telegram, disk) is injected by the caller.

export function routerClockYear(rows) {
  const r = (rows && rows[0]) || {};
  const raw = String(r.date || r["date-and-time"] || "");
  const m = raw.match(/(20\d{2})/);
  return m ? Number(m[1]) : null;
}

export function shouldExport(prev, today) {
  return !prev || String(prev.last_export || "") !== String(today);
}

export function nextAlerts({ prev, reachable, cutoffVerdict, clockSane, routerYear, name }) {
  const label = String(name || (prev && prev.router_id) || "Router");
  const alerts = [];
  let key = "ok";

  if (!clockSane) {
    key = "pc-clock";
    if (!prev || prev.last_alert_key !== key) {
      alerts.push({
        type: "pc-clock",
        text: "This PC clock looks wrong. Cut-off checks and backups are paused until the date is 2024 or later.",
      });
    }
    return { alerts, last_alert_key: key };
  }

  if (!reachable) {
    key = "down";
    if (!prev || prev.last_alert_key !== key) {
      alerts.push({ type: "down", text: "Router " + label + " is unreachable." });
    }
    return { alerts, last_alert_key: key };
  }

  if (routerYear != null && routerYear < 2024) {
    key = "router-clock";
    if (!prev || prev.last_alert_key !== key) {
      alerts.push({
        type: "router-clock",
        text: "Router " + label + " clock is wrong (year " + routerYear + "). Set NTP. Nightly cut-off will refuse to run.",
      });
    }
    return { alerts, last_alert_key: key };
  }

  if (cutoffVerdict && cutoffVerdict !== "ok") {
    key = "cutoff:" + cutoffVerdict;
    if (!prev || prev.last_alert_key !== key) {
      alerts.push({
        type: "cutoff",
        text: "Cut-off on " + label + " is " + cutoffVerdict + ". Install or switch it to Cut off for real.",
      });
    }
    return { alerts, last_alert_key: key };
  }

  if (prev && prev.last_alert_key && prev.last_alert_key !== "ok") {
    alerts.push({ type: "up", text: "Router " + label + " is healthy again." });
  }
  return { alerts, last_alert_key: "ok" };
}

export function exportSnapshot({ router, customers, cutoff, today }) {
  return {
    at: today,
    router: {
      id: router && router.id,
      name: router && router.name,
      host: router && router.host,
    },
    cutoff: cutoff || null,
    customers: (customers || []).map((c) => ({
      kind: c.kind,
      key: c.key,
      name: c.name,
      plan: c.plan,
      price: c.price,
      cycle: c.cycle,
      due: c.due,
      wallet: c.wallet,
      phone: c.phone,
    })),
  };
}

export function makeWatchdogStore(db) {
  const read = db.prepare("SELECT * FROM watchdog_state WHERE router_id = ?");
  const write = db.prepare(`
    INSERT INTO watchdog_state
      (router_id, reachable, cutoff, clock_ok, last_alert_key, last_export, checked_at)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(router_id) DO UPDATE SET
      reachable=excluded.reachable, cutoff=excluded.cutoff, clock_ok=excluded.clock_ok,
      last_alert_key=excluded.last_alert_key, last_export=excluded.last_export,
      checked_at=excluded.checked_at`);
  const list = db.prepare("SELECT * FROM watchdog_state");

  function get(id) {
    return read.get(String(id)) || null;
  }

  function put(row) {
    write.run(
      String(row.router_id),
      String(row.reachable || "ok"),
      row.cutoff == null ? null : String(row.cutoff),
      row.clock_ok == null ? null : Number(row.clock_ok),
      row.last_alert_key == null ? null : String(row.last_alert_key),
      row.last_export == null ? null : String(row.last_export),
      String(row.checked_at || "")
    );
    return get(row.router_id);
  }

  function all() {
    return list.all();
  }

  return { get, put, all };
}
