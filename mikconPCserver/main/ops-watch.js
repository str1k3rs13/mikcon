// Runs one watchdog pass: reachability, cut-off health, clock, nightly JSON export.
import fs from "node:fs";
import path from "node:path";
import { cutoffHealth } from "../agent/cutoff.js";
import {
  exportSnapshot,
  nextAlerts,
  routerClockYear,
  shouldExport,
} from "../agent/watchdog.js";

function byName(list, name) {
  return (list || []).find((x) => x && x.name === name) || null;
}

export async function runWatchdogPass({
  routers,
  failed,
  customers,
  names,
  store,
  clock,
  exec,
  sendAlert,
  exportDir,
}) {
  const today = clock.today();
  const failedIds = new Set((failed || []).map((f) => String(f.id)));
  const alertsOut = [];

  for (const router of routers || []) {
    const prev = store.get(router.id);
    const reachable = !failedIds.has(String(router.id));
    let cutoffVerdict = prev && prev.cutoff;
    let year = null;

    if (reachable && clock.isSane()) {
      const call = (cmd) => exec({
        host: router.host, port: router.port, user: router.user, pass: router.pass,
        tls: router.tls, tlsFingerprint: router.tlsFingerprint, cmd,
      });
      try {
        const scripts = await call("/system/script/print");
        const schedulers = await call("/system/scheduler/print");
        const h = cutoffHealth({
          script: byName(scripts, "mikcon-cutoff"),
          scheduler: byName(schedulers, "mikcon-cutoff"),
        });
        cutoffVerdict = h.verdict;
      } catch { /* keep previous cutoff if the extra reads fail */ }
      try {
        year = routerClockYear(await call("/system/clock/print"));
      } catch { year = null; }
    }

    const planned = nextAlerts({
      prev,
      reachable,
      cutoffVerdict,
      clockSane: clock.isSane(),
      routerYear: year,
      name: (names && names[router.id]) || router.name || router.id,
    });

    let lastExport = prev && prev.last_export;
    if (reachable && clock.isSane() && shouldExport(prev, today) && exportDir) {
      try {
        fs.mkdirSync(exportDir, { recursive: true });
        const snap = exportSnapshot({
          router: { id: router.id, name: (names && names[router.id]) || router.name, host: router.host },
          customers: (customers && customers[router.id]) || [],
          cutoff: cutoffVerdict || null,
          today,
        });
        const file = path.join(exportDir, String(router.id) + "-" + today + ".json");
        fs.writeFileSync(file, JSON.stringify(snap, null, 2), "utf8");
        lastExport = today;
        try {
          await exec({
            host: router.host, port: router.port, user: router.user, pass: router.pass,
            tls: router.tls, tlsFingerprint: router.tlsFingerprint,
            cmd: "/system/backup/save",
            attrs: { name: "mikcon-auto" },
          });
        } catch { /* JSON on the PC is the copy we own; router backup is best-effort */ }
      } catch { /* export failure is not an alert storm */ }
    }

    store.put({
      router_id: router.id,
      reachable: reachable ? "ok" : "down",
      cutoff: cutoffVerdict || null,
      clock_ok: year == null ? null : (year >= 2024 ? 1 : 0),
      last_alert_key: planned.last_alert_key,
      last_export: lastExport || null,
      checked_at: today,
    });

    for (const a of planned.alerts) {
      alertsOut.push(a);
      if (typeof sendAlert === "function") {
        try { await sendAlert(a.text); } catch { /* one failed Telegram must not stop the pass */ }
      }
    }
  }
  return alertsOut;
}
