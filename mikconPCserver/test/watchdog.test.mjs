import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openStore } from "../agent/store.js";
import {
  exportSnapshot, makeWatchdogStore, nextAlerts, routerClockYear, shouldExport,
} from "../agent/watchdog.js";
import { runWatchdogPass } from "../main/ops-watch.js";

test("routerClockYear reads RouterOS date", () => {
  assert.equal(routerClockYear([{ date: "aug/20/2026" }]), 2026);
  assert.equal(routerClockYear([{ "date-and-time": "2023-01-01 00:00:00" }]), 2023);
  assert.equal(routerClockYear([{}]), null);
});

test("one alert per transition, not every poll", () => {
  const first = nextAlerts({ prev: null, reachable: false, clockSane: true, name: "House" });
  assert.equal(first.last_alert_key, "down");
  assert.equal(first.alerts.length, 1);
  const again = nextAlerts({
    prev: { last_alert_key: "down" }, reachable: false, clockSane: true, name: "House",
  });
  assert.equal(again.alerts.length, 0);
  const back = nextAlerts({
    prev: { last_alert_key: "down" }, reachable: true, cutoffVerdict: "ok", clockSane: true, name: "House",
  });
  assert.equal(back.last_alert_key, "ok");
  assert.match(back.alerts[0].text, /healthy/);
});

test("cutoff and pc-clock and stale router clock alert once", () => {
  const cut = nextAlerts({ prev: null, reachable: true, cutoffVerdict: "dry", clockSane: true, name: "House" });
  assert.equal(cut.last_alert_key, "cutoff:dry");
  const clock = nextAlerts({ prev: null, reachable: true, clockSane: false, name: "House" });
  assert.equal(clock.last_alert_key, "pc-clock");
  const ros = nextAlerts({
    prev: null, reachable: true, clockSane: true, routerYear: 2020, cutoffVerdict: "ok", name: "House",
  });
  assert.equal(ros.last_alert_key, "router-clock");
});

test("shouldExport once a day", () => {
  assert.equal(shouldExport(null, "2026-08-20"), true);
  assert.equal(shouldExport({ last_export: "2026-08-20" }, "2026-08-20"), false);
  assert.equal(shouldExport({ last_export: "2026-08-19" }, "2026-08-20"), true);
});

test("export snapshot never includes router passwords", () => {
  const snap = exportSnapshot({
    router: { id: "r1", name: "House", host: "10.0.0.1", user: "admin", pass: "secret" },
    customers: [{ kind: "ppp", key: "j", name: "Juan", plan: "Fibre", price: 750, cycle: "monthly", due: "2026-09-01", wallet: 0, phone: "09", raw_comment: "x" }],
    cutoff: "ok",
    today: "2026-08-20",
  });
  const blob = JSON.stringify(snap);
  assert.doesNotMatch(blob, /secret/);
  assert.doesNotMatch(blob, /"user"/);
  assert.equal(snap.customers[0].name, "Juan");
});

test("runWatchdogPass writes json and telegrams only on change", async () => {
  const db = openStore(":memory:");
  const store = makeWatchdogStore(db);
  const dir = mkdtempSync(path.join(tmpdir(), "mikcon-exp-"));
  const sent = [];
  const execCalls = [];
  async function exec(o) {
    execCalls.push(o.cmd);
    if (o.cmd === "/system/script/print") return [{ name: "mikcon-cutoff", source: "MIKCON-CUTOFF-V2\n:local grace 3\n:local dry false\n:local expProf \"expired\"" }];
    if (o.cmd === "/system/scheduler/print") return [{ name: "mikcon-cutoff", disabled: "false" }];
    if (o.cmd === "/system/clock/print") return [{ date: "aug/20/2026" }];
    return [];
  }
  const routers = [{ id: "r1", host: "10.0.0.1", port: 8728, user: "a", pass: "p" }];
  await runWatchdogPass({
    routers, failed: [], customers: { r1: [{ name: "Juan", key: "j", kind: "ppp" }] },
    names: { r1: "House" }, store,
    clock: { today: () => "2026-08-20", isSane: () => true },
    exec, sendAlert: async (t) => sent.push(t), exportDir: dir,
  });
  const file = readFileSync(path.join(dir, "r1-2026-08-20.json"), "utf8");
  assert.match(file, /Juan/);
  assert.ok(execCalls.includes("/system/backup/save"));
  const again = [];
  await runWatchdogPass({
    routers, failed: [], customers: { r1: [] }, names: { r1: "House" }, store,
    clock: { today: () => "2026-08-20", isSane: () => true },
    exec, sendAlert: async (t) => again.push(t), exportDir: dir,
  });
  assert.equal(again.length, 0);
  db.close();
});
