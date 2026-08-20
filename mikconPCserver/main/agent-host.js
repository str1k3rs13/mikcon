// Hosts agent/ inside Electron. This is the ONLY file that connects the two, and the only
// place Electron and the agent appear together.
//
// The history lives in two places, and this file is where that split is reconciled:
//
//   - The ROUTER LIST is in DPAPI, not localStorage. index.html writes it to encrypted
//     storage and then removes jf_routers (see its saveRouters() and hydrateSecureData()),
//     so on a real MikconPC install that key does not exist. Reading it main-side is also
//     race-free: the blob is on disk before the window opens, whereas the renderer only
//     populates its own copy after hydrateSecureData() resolves.
//   - The LEDGER, SMS LOG and SALES are in localStorage, which belongs to Chromium, so the
//     agent cannot read them. main pulls them out of the renderer instead.
//
// Pulling rather than having the page push means juanfi-app/www/index.html - the file the
// Android app also loads - needs no change at all.
import path from "node:path";
import { randomUUID } from "node:crypto";
import { openStore } from "../agent/store.js";
import { makeClock } from "../agent/clock.js";
import { createAgent } from "../agent/index.js";
import { cutoffHealth, worstVerdict } from "../agent/cutoff.js";
import { makePayStore } from "../agent/pay-store.js";
import * as tg from "../agent/telegram.js";
import { startPayServer as defaultStartPayServer } from "./pay-server.js";
import { makePayBot as defaultMakePayBot, makeReconnector } from "./pay-bot.js";
import { makeRecordPayment, makeResolveCustomers } from "./pay-wiring.js";
import { parseBill, billComment } from "../agent/billing.js";
import { computeRenewal } from "../agent/wallet-renew.js";

// uid() in the app mints "r" + randomUUID. Anything outside that shape is not an id we wrote,
// and these ids are both interpolated into a script and concatenated into localStorage key
// names — so they are checked rather than trusted.
export function isSafeRouterId(id) {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

// Both projections start here. One parse, so the two can never disagree about which entries exist.
// A missing or unreadable blob parses to zero routers exactly as an empty fleet does, and the two
// must not be treated alike when the consequence is deleting state. Wiping every cut-off verdict
// because DPAPI hiccupped, or because the poll ran before the blob was written, would throw away
// the alarm this stage exists to raise - and it would come back silently, at the next daily check.
function blobIsReadable(raw) {
  const s = String(raw || "").trim();
  if (!s) return false;
  try { JSON.parse(s); return true; } catch { return false; }
}

function parseRouterList(raw) {
  let parsed = null;
  try { parsed = JSON.parse(String(raw || "") || "null"); } catch { return []; }
  // hydrateSecureData() accepts a bare array (the older shape) or { routers, activeId }.
  const list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.routers) ? parsed.routers : []);
  return list.filter((r) => r && typeof r === "object" && isSafeRouterId(r.id));
}

// Projects the encrypted router blob down to the three fields the database has columns for.
// The blob also holds the live router username, password and TLS fingerprint; none of them
// may ride along into the snapshot, and a test asserts they do not.
export function routersFromSecureBlob(raw) {
  return parseRouterList(raw)
    .map((r) => ({ id: String(r.id), name: String(r.name || ""), address: String(r.ip || "") }));
}

// The SECOND projection of the same blob: what exec() needs to reach a router. This output is
// request-scoped and is NEVER persisted — routersFromSecureBlob() above is the only projection the
// database sees. Two functions rather than one with a flag, so that no later edit can widen the
// database-bound projection by accident.
//
// `ip` is the app's field name; exec() and agent/poller.js both want `host`. Stage 1 shipped a
// poller reading router.host from a list that only ever had .ip, so every poll went to `undefined`.
// This is where that is corrected.
export function routersForPolling(raw) {
  return parseRouterList(raw)
    .map((r) => ({
      id: String(r.id),
      host: String(r.ip || ""),
      // apiPortOf() in the shared UI: an explicit port, else 8729 with TLS and 8728 without.
      port: Number(r.port) || (r.tls ? 8729 : 8728),
      user: String(r.user || ""),
      pass: String(r.pass || ""),
      tls: !!r.tls,
      tlsFingerprint: String(r.tlsFingerprint || ""),
    }))
    // A router with no address cannot be reached, and counting it as an outage would be a lie.
    .filter((r) => r.host);
}

// Evaluated in the renderer. Deliberately narrow: it reads the ledger and sms log of the
// router ids it is given, plus the one global sales key, and nothing else. Widening this into
// a general "return localStorage" would turn a scoped extraction into an open renderer-eval
// channel and would sweep up jf_license with it. A test asserts which keys it asks for.
export function snapshotJs(routerIds) {
  const ids = (routerIds || []).filter(isSafeRouterId);
  return `(function(){
  var out = { ledgers: {}, smslogs: {}, sales: [] };
  function read(k){ try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } }
  var sales = read("jf_sales_hist");
  out.sales = Array.isArray(sales) ? sales : [];
  var ids = ${JSON.stringify(ids)};
  for (var i = 0; i < ids.length; i++) {
    var led = read("jf_ledger_" + ids[i]);
    if (Array.isArray(led) && led.length) out.ledgers[ids[i]] = led;
    var log = read("jf_smslog_" + ids[i]);
    if (Array.isArray(log) && log.length) out.smslogs[ids[i]] = log;
  }
  return out;
})()`;
}

// Long enough that it is not a busy loop, short enough that closing the app shortly after a
// collection still mirrors it.
const SYNC_INTERVAL_MS = 60_000;
// A pass is sequential across every configured router over what may be a VPN link, and nothing
// reads the customer cache until Stage 3 — so this buys freshness nobody is waiting on. Fifteen
// minutes.
const POLL_INTERVAL_MS = 15 * 60_000;

// isUnlocked defaults to "unlocked" so a caller that predates the licence gate — the smoke harness,
// which drives the host directly against a page it loaded itself — keeps working unchanged. In the
// app, main.js always injects the real one.
export function startAgentHost({
  app, win, exec, store, isUnlocked = async () => true, onState = () => {}, clock = makeClock(),
  // Injectable so a test can prove reconcilePayReminder() never starts real network listeners
  // while the licence gate is up, without a real HTTP server or a real Telegram long-poll loop.
  // Production callers (main.js) never pass these — the defaults are the real modules.
  startPayServer = defaultStartPayServer, makePayBot = defaultMakePayBot,
}) {
  const db = openStore(path.join(app.getPath("userData"), "agent.db"));
  const agent = createAgent({ db, client: exec, clock });
  // Payment-reminder wiring (Task 9). Built eagerly (cheap: a few prepared statements) so the
  // IPC-facing payReminder.* API below works even before the licence gate is first checked; only
  // the intake server and the Telegram poll loop are gated.
  const recordPayment = makeRecordPayment(db);
  const reconnectOnRouter = makeReconnector(exec);
  const resolveCustomers = makeResolveCustomers(db);
  const payStore = makePayStore({ db, clock, token: randomUUID });
  const listPendingAllStmt = db.prepare(
    "SELECT * FROM payment_request WHERE status = 'pending' ORDER BY created_at, id");

  // What the tray renders. Owned here because this is the only place that knows whether a pass
  // happened; main.js just draws it.
  const state = { locked: false, lastSyncAt: null, unreachable: 0, cutoff: { affected: [], worst: null } };
  const publish = () => { try { onState({ ...state }); } catch { /* a tray failure is not fatal */ } };

  let routerNames = {};

  // Read from cutoff_state rather than starting empty. An in-memory-only warning is lost on every
  // restart, and would then stay lost until the next date change - up to a full day of saying
  // nothing about a router whose cut-off is missing.
  function loadCutoffState() {
    const rows = db.prepare("SELECT router_id, verdict FROM cutoff_state WHERE verdict != 'ok'").all();
    state.cutoff = {
      affected: rows.map((r) => ({
        id: r.router_id, name: routerNames[r.router_id] || r.router_id, verdict: r.verdict,
      })),
      worst: worstVerdict(rows.map((r) => r.verdict)),
    };
  }

  // A router the operator removed must stop warning. cutoff_state outlives the router list
  // otherwise, and routerNames no longer resolves it either - so the tray settles into naming a raw
  // id for a router that is not in the app any more, with no way to clear it. A warning nobody can
  // dismiss is worse than none: it teaches the operator to ignore the line, and then the real one
  // arrives on a line they have stopped reading.
  //
  // Only cutoff_state is pruned. The event rows stay, because they answer "when did this break" and
  // that history is still true after the router is gone. customer rows stay too - reaping those is
  // the aging question the design defers to Stage 7, and it is not this function's to decide.
  function pruneCutoffState(ids) {
    const keep = new Set(ids);
    const gone = db.prepare("SELECT router_id FROM cutoff_state").all()
      .map((r) => r.router_id).filter((id) => !keep.has(id));
    if (!gone.length) return;
    const drop = db.prepare("DELETE FROM cutoff_state WHERE router_id = ?");
    for (const id of gone) drop.run(id);
  }

  const readCutoff = db.prepare("SELECT * FROM cutoff_state WHERE router_id = ?");
  const writeCutoff = db.prepare(`
    INSERT INTO cutoff_state (router_id,verdict,version,grace,exp_profile,since,checked_at)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(router_id) DO UPDATE SET
      verdict=excluded.verdict, version=excluded.version, grace=excluded.grace,
      exp_profile=excluded.exp_profile, since=excluded.since, checked_at=excluded.checked_at`);
  const writeEvent = db.prepare(
    "INSERT INTO event (router_id,type,at,detail,source) VALUES (?,?,?,?,?)");

  // Two extra reads per router, and the answer changes only when a human installs a script - so
  // once a day. Triggered by checked_at not being today rather than by a wall-clock hour: a fixed
  // 01:00 trigger is skipped entirely on a machine that happens to be asleep at 01:00.
  async function checkCutoff(router, today) {
    const prev = readCutoff.get(router.id);
    if (prev && prev.checked_at === today) return;

    const call = (cmd) => exec({
      host: router.host, port: router.port, user: router.user, pass: router.pass,
      tls: router.tls, tlsFingerprint: router.tlsFingerprint, cmd,
    });
    // Throws on an unreachable router, which the caller catches - so a router that could not be
    // reached writes NOTHING. Recording "cut-off missing" for a router we simply could not reach
    // would cry wolf, and an alert that cries wolf gets ignored.
    const scripts = await call("/system/script/print");
    const schedulers = await call("/system/scheduler/print");
    const byName = (list) => (list || []).find((x) => x && x.name === "mikcon-cutoff") || null;

    const h = cutoffHealth({ script: byName(scripts), scheduler: byName(schedulers) });
    const changed = !prev || prev.verdict !== h.verdict;
    writeCutoff.run(router.id, h.verdict, h.version, h.grace, h.expProfile,
                    changed ? today : prev.since, today);
    if (changed) {
      writeEvent.run(router.id, "cutoff_check", today,
        JSON.stringify({ verdict: h.verdict, version: h.version, from: prev ? prev.verdict : null }),
        "agent");
    }
  }

  async function routerBlob() {
    const blob = store ? await store.get("routers") : { found: false, value: "" };
    return blob && blob.found ? String(blob.value) : "";
  }

  // The polling projection carries the live host/port/credentials pay-bot's reconnect path needs.
  // Request-scoped, like routersForPolling itself — never cached across calls, since the router
  // list (and a router's own address) can change under the app at any time.
  async function getRouter(routerId) {
    const routers = routersForPolling(await routerBlob());
    return routers.find((r) => r.id === routerId) || null;
  }

  // The two DPAPI blobs the payment-reminder feature reads. Telegram credentials are kept apart
  // from the rest of the config so payReminderGetConfig() (the IPC-facing read) can hand the config
  // to the renderer without ever including the token — only whether one is set.
  async function payReminderCreds() {
    const blob = store ? await store.get("payreminder-telegram") : { found: false, value: "" };
    if (!blob || !blob.found) return { token: "", chatId: "" };
    try {
      const parsed = JSON.parse(String(blob.value || "") || "null") || {};
      return { token: String(parsed.token || ""), chatId: String(parsed.chatId || "") };
    } catch {
      return { token: "", chatId: "" };
    }
  }

  function defaultPayReminderConfig() {
    return { enabled: false, port: 0, routerId: "", host: "", gcash: {}, brand: {} };
  }

  async function payReminderConfig() {
    const blob = store ? await store.get("payreminder-config") : { found: false, value: "" };
    const defaults = defaultPayReminderConfig();
    if (!blob || !blob.found) return defaults;
    try {
      const parsed = JSON.parse(String(blob.value || "") || "null");
      if (!parsed || typeof parsed !== "object") return defaults;
      return {
        ...defaults, ...parsed,
        gcash: { ...(parsed.gcash || {}) },
        brand: { ...(parsed.brand || {}) },
      };
    } catch {
      return defaults;
    }
  }

  // Both timers ask the same question, and it fails closed: isUnlocked() already returns false when
  // the check throws. An unlicensed install does no polling and no mirroring.
  async function gateIsUp() {
    const unlocked = await isUnlocked();
    if (state.locked === !unlocked) return !unlocked;   // unchanged; no need to redraw
    state.locked = !unlocked;
    publish();
    // A gate transition is exactly when the payment reminder must react: locking must stop the
    // intake server and Telegram loop, and unlocking (with an already-saved config) must start
    // them. Fire-and-forget — reconcilePayReminder() never throws, and nothing here needs to wait
    // on it before continuing the poll or sync it was called from.
    reconcilePayReminder();
    return !unlocked;
  }

  // ---------------------------------------------------------------------------
  // Payment reminder: intake server + Telegram bot, hosted under the licence gate
  // ---------------------------------------------------------------------------

  let payRuntime = null;               // { server, bot, key } while running; null while stopped
  let reconcileChain = Promise.resolve();

  // A fingerprint of everything that would require a restart to pick up. Compared against the
  // currently-running runtime so an unrelated reconcile call (e.g. a second gate check in the same
  // tick) is a no-op rather than a pointless stop/start.
  function reconcileKeyOf(config, creds) {
    return JSON.stringify({
      enabled: !!config.enabled, port: config.port || 0, routerId: config.routerId || "",
      host: config.host || "", gcash: config.gcash || {}, brand: config.brand || {},
      token: creds.token || "", chatId: creds.chatId || "",
    });
  }

  async function stopPayRuntime() {
    if (!payRuntime) return;
    const { server, bot } = payRuntime;
    payRuntime = null;
    try { await bot.stop(); } catch (e) { console.error("agent host: pay-bot stop failed", (e && e.message) || e); }
    try { await server.close(); } catch (e) { console.error("agent host: pay-server close failed", (e && e.message) || e); }
  }

  // The actual reconcile step. Never throws — callers (gateIsUp, host startup, setConfig) must be
  // free to fire this without a try/catch of their own.
  async function reconcilePayReminderOnce() {
    const [config, creds] = await Promise.all([payReminderConfig(), payReminderCreds()]);
    const wantsRunning = !!(config.enabled && creds.token && creds.chatId);
    const locked = await gateIsUp();
    if (!wantsRunning || locked) {
      await stopPayRuntime();
      return;
    }

    const key = reconcileKeyOf(config, creds);
    if (payRuntime && payRuntime.key === key) return;   // already running this exact config
    await stopPayRuntime();

    const tgCfg = { token: creds.token, chatId: creds.chatId };
    const bot = makePayBot({ tg, cfg: tgCfg, payStore, resolveCustomers, getRouter, exec, recordPayment, clock });
    try {
      // Never "0.0.0.0" — pay-server.js itself refuses to default there, and this feature must not
      // widen that. An empty/omitted config.host falls through to pay-server's own loopback
      // default; the pane supplies the machine's real LAN IP when it wants the walled-garden page
      // reachable from a customer's phone.
      const server = await startPayServer({
        payStore, resolveCustomers, onPending: (row) => bot.notify(row),
        config: {
          host: config.host || undefined, port: config.port || 0,
          routerId: config.routerId || "", gcash: config.gcash || {}, brand: config.brand || {},
        },
      });
      await bot.start();
      payRuntime = { server, bot, key };
    } catch (e) {
      // A start failure (e.g. the configured port is already in use) must not be fatal to the rest
      // of the app — it is logged and left stopped, not thrown up into the gate check that called
      // reconcilePayReminder().
      console.error("agent host: payreminder start failed", (e && e.message) || e);
      try { await bot.stop(); } catch { /* it never started its loop */ }
      payRuntime = null;
    }
  }

  // Serialized: two reconcile triggers landing in the same tick (a gate check plus an explicit
  // setConfig call, say) must not run reconcilePayReminderOnce concurrently and race each other's
  // stop/start. Every call chains onto the last, and the chain never itself rejects.
  function reconcilePayReminder() {
    reconcileChain = reconcileChain.then(reconcilePayReminderOnce, reconcilePayReminderOnce)
      .catch((e) => console.error("agent host: payreminder reconcile failed", (e && e.message) || e));
    return reconcileChain;
  }

  // ---------------------------------------------------------------------------
  // Payment reminder: the IPC-facing API (see registerPayReminderIpc at the bottom of this file)
  // ---------------------------------------------------------------------------

  async function payReminderGetConfig() {
    const [config, creds] = await Promise.all([payReminderConfig(), payReminderCreds()]);
    return {
      config: {
        enabled: !!config.enabled,
        port: Number(config.port) || 0,
        routerId: config.routerId || "",
        host: config.host || "",
        gcash: { name: "", number: "", qrDataUrl: "", ...(config.gcash || {}) },
        brand: { message: "", bannerDataUrl: "", ...(config.brand || {}) },
      },
      // The raw token NEVER crosses into the renderer — only whether one is set.
      telegram: { chatId: creds.chatId || "", hasToken: !!creds.token },
    };
  }

  async function payReminderSetConfig({ config, telegram } = {}) {
    if (config && typeof config === "object") {
      const host = config.host ? String(config.host) : "";
      const clean = {
        enabled: !!config.enabled,
        port: Number(config.port) || 0,
        routerId: config.routerId ? String(config.routerId) : "",
        // Refuse a wildcard bind even if it somehow reaches this call — the intake server must
        // only ever be reachable on loopback or the operator's own LAN IP.
        host: host && host !== "0.0.0.0" ? host : "",
        gcash: {
          name: String((config.gcash && config.gcash.name) || ""),
          number: String((config.gcash && config.gcash.number) || ""),
          qrDataUrl: String((config.gcash && config.gcash.qrDataUrl) || ""),
        },
        brand: {
          message: String((config.brand && config.brand.message) || ""),
          bannerDataUrl: String((config.brand && config.brand.bannerDataUrl) || ""),
        },
      };
      if (store) await store.set("payreminder-config", JSON.stringify(clean));
    }
    if (telegram && typeof telegram === "object" && (telegram.token || telegram.chatId != null)) {
      const existing = await payReminderCreds();
      const merged = {
        token: telegram.token ? String(telegram.token) : existing.token,
        chatId: telegram.chatId != null && telegram.chatId !== "" ? String(telegram.chatId) : existing.chatId,
      };
      if (store) await store.set("payreminder-telegram", JSON.stringify(merged));
    }
    await reconcilePayReminder();
    return { ok: true };
  }

  async function payReminderListPending() {
    const config = await payReminderConfig();
    if (config.routerId) return payStore.listPending(config.routerId);
    return listPendingAllStmt.all();
  }

  async function payReminderDecide(id, approve) {
    const bot = payRuntime && payRuntime.bot;
    if (!bot) return { ok: false, reason: "not running" };
    return bot.decideDirect(id, approve);
  }

  async function syncOnce() {
    if (!win || win.isDestroyed()) return;
    if (await gateIsUp()) return;
    try {
      // The router list first — without it there are no ledger keys to ask the renderer for.
      // On a machine that has not yet written the encrypted blob this is empty, and the
      // snapshot is simply sales-only until the next tick finds it.
      const routers = routersFromSecureBlob(await routerBlob());
      // This runs on did-finish-load, a quarter of an hour before the first poll. The warning
      // seeded from cutoff_state at start-up has no names until something reads the blob, and a
      // raw id in the tray is worse than the count it replaced - so the names are taken here and
      // the seeded warning redrawn with them.
      routerNames = Object.fromEntries(routers.map((r) => [r.id, r.name || r.id]));
      loadCutoffState();
      const rest = await win.webContents.executeJavaScript(snapshotJs(routers.map((r) => r.id)));
      agent.sync({ routers, ...rest });
      state.lastSyncAt = new Date();
    } catch (e) {
      // Never fatal: localStorage is the record and the app must work without the mirror.
      console.error("agent host: sync failed", (e && e.message) || e);
    }
    publish();
  }

  // Prepaid wallet auto-renew. For each billable customer whose bill is due and whose wallet
  // covers a cycle, deduct the price, advance the due date, reconnect if cut off, and record
  // the spend. Never throws up into the poll — a failure is logged and retried next pass.
  async function renewFromWallets(router, rows, today) {
    for (const c of rows || []) {
      const r = computeRenewal({ due: c.due, wallet: c.wallet, price: c.price, cycle: c.cycle, today });
      if (!r.rounds) continue;
      const note = parseBill(c.raw_comment).note;
      const comment = billComment(note, {
        price: c.price, cycle: c.cycle, due: r.newDue, paid: today, bal: 0,
        phone: c.phone, wallet: r.newWallet, plan: c.plan,
      });
      const reconnect = { kind: c.kind, key: c.key, address: c.kind === "ipoe" ? c.key : "", profile: c.plan };
      try {
        await reconnectOnRouter({
          host: router.host, port: router.port, user: router.user, pass: router.pass,
          tls: router.tls, tlsFingerprint: router.tlsFingerprint,
        }, { comment, reconnect });
        for (let i = 0; i < r.rounds; i++) {
          recordPayment({
            router_id: router.id, customer_key: c.key, kind: c.kind, amount: c.price, at: today,
            method: "wallet", source: "wallet-renew", collected_by: "Wallet",
            ref: c.key + "@" + r.newDue + "#" + i,
          });
        }
      } catch (e) {
        console.error("agent host: wallet renew failed for " + c.key, (e && e.message) || e);
      }
    }
  }

  // Skipping a tick rather than queueing it is deliberate: a backlog of stale passes all firing at
  // a router that has just come back is how RouterOS is provoked into refusing API logins.
  let polling = false;
  async function pollOnce() {
    if (polling) return;
    if (await gateIsUp()) return;
    polling = true;
    try {
      const raw = await routerBlob();
      const routers = routersForPolling(raw);
      // Names come from the OTHER projection — the database-bound one — because routersForPolling
      // deliberately carries no name, and widening it would blur the line this design keeps sharp.
      const configured = routersFromSecureBlob(raw);
      routerNames = Object.fromEntries(configured.map((r) => [r.id, r.name || r.id]));
      // Pruned against the CONFIGURED list, not the pollable one: a router whose address the
      // operator left blank is still theirs, and dropping its verdict would keep re-raising the
      // warning from scratch every time they fixed the address.
      if (blobIsReadable(raw)) pruneCutoffState(configured.map((r) => r.id));
      if (!routers.length) {
        // Before the early return, or an outage count outlives the routers it described and the
        // tray keeps reporting a failure for something that is no longer configured.
        state.unreachable = 0;
        loadCutoffState();
        return;
      }

      const today = clock.today();
      for (const router of routers) {
        try { await checkCutoff(router, today); }
        catch (e) { console.error("agent host: cut-off check failed for " + router.id, (e && e.message) || e); }
      }

      // pollAll() records failures instead of throwing, so one unreachable router does not cost
      // the others their refresh.
      const { failed, customers } = await agent.poll(routers);
      state.unreachable = failed.length;
      for (const f of failed) console.error("agent host: poll failed for " + f.id, f.error);
      const failedIds = new Set((failed || []).map((f) => f.id));
      for (const router of routers) {
        if (failedIds.has(router.id)) continue;
        try {
          await renewFromWallets(router, (customers && customers[router.id]) || [], today);
        } catch (e) {
          console.error("agent host: wallet renew failed for " + router.id, (e && e.message) || e);
        }
      }
      loadCutoffState();
    } catch (e) {
      console.error("agent host: poll failed", (e && e.message) || e);
    } finally {
      polling = false;
      publish();
    }
  }

  // Before any timer: the tray must be right the moment the app starts, not after the first check.
  loadCutoffState();
  // gateIsUp() only triggers a reconcile on a LOCKED<->UNLOCKED transition; a host that starts
  // already unlocked (the common case) with a saved, enabled config would otherwise never reach
  // reconcilePayReminder() at all, because state.locked already matches on the very first check.
  // Fire-and-forget — reconcilePayReminder() never throws.
  reconcilePayReminder();

  win.webContents.on("did-finish-load", syncOnce);
  const syncTimer = setInterval(syncOnce, SYNC_INTERVAL_MS);
  // Deliberately NOT also kicked off by did-finish-load: a reload would then be a router hit, and
  // at startup the licence gate is normally still up so it would no-op anyway.
  const pollTimer = setInterval(pollOnce, POLL_INTERVAL_MS);

  return {
    syncOnce,
    pollOnce,
    // The planner's handlers write plant tables through THIS handle. Opening a second connection
    // to the same file would put two writers on one sqlite database, which is how a planner
    // corrupts a billing cache.
    db,
    getState: () => ({ ...state }),
    // Exposed mainly as a test seam (see test/agent-host.test.mjs): tests await this directly to
    // prove the intake server/bot do or don't start, without waiting on a timer or a fake window's
    // did-finish-load. Production code never needs to call it — gateIsUp() and setConfig already do.
    reconcilePayReminder,
    payReminder: {
      getConfig: payReminderGetConfig,
      setConfig: payReminderSetConfig,
      listPending: payReminderListPending,
      decide: payReminderDecide,
    },
    stop() {
      clearInterval(syncTimer);
      clearInterval(pollTimer);
      // Fire-and-forget, same as the reconcile triggers above: stopPayRuntime() never throws, and
      // the app is exiting regardless of whether the intake server has finished closing its sockets.
      stopPayRuntime().catch(() => {});
      agent.close();
    },
  };
}

// Registers the PayReminder.* IPC surface the pane (Task 10) drives. Split out from
// startAgentHost() rather than folded into it because ipcMain must be wired before the window is
// created and the host itself has opened its database — getHost() is a FUNCTION so this can be
// called before `agentHost` exists in main.js.
export function registerPayReminderIpc({ ipcMain, getHost }) {
  const host = () => {
    const h = getHost();
    if (!h) throw new Error("the payment reminder is not ready yet");
    return h;
  };
  ipcMain.handle("payreminder:getConfig", () => host().payReminder.getConfig());
  ipcMain.handle("payreminder:setConfig", (_e, o) => host().payReminder.setConfig(o));
  ipcMain.handle("payreminder:listPending", () => host().payReminder.listPending());
  ipcMain.handle("payreminder:decide", (_e, { id, approve }) => host().payReminder.decide(id, approve));
}
