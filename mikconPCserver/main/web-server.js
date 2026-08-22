import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { exec as routerExec } from "./routeros.js";
import { discover } from "./mndp.js";
import { machineId } from "./machine-id.js";
import { makeSecureStore } from "./secure-store.js";
import { makeFileEncryptor } from "./file-encryptor.js";
import { isAllowedLicenseUrl } from "./allowlist.js";
import { injectShim, LOGIN_PAGE } from "./web-html.js";
import { parseCookie, checkPassword, makeLoginGuard, savePassword, validateNewPassword } from "./web-auth.js";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { openStore } from "../agent/store.js";
import { makeClock } from "../agent/clock.js";
import { makePayStore } from "../agent/pay-store.js";
import { makeRecordPayment, makeResolveCustomers, makeListSales } from "./pay-wiring.js";
import { actorCanClearHistory, normalizeActor } from "../agent/pay-store.js";
import { makePayBot, makeReconnector } from "./pay-bot.js";
import { computeRenewal } from "../agent/wallet-renew.js";
import { billComment, parseBill } from "../agent/billing.js";
import { reconnectSpec } from "../agent/pay-approve.js";
import * as tg from "../agent/telegram.js";
import { routersForPolling, routersFromSecureBlob } from "./agent-host.js";
import { pollAll } from "../agent/poller.js";
import { makePaymentApi } from "./payment-page.js";
import { sanitizeBrand, mergeBrand, mergeGcash } from "./brand.js";
import { makeReceiptStore, formatReceiptTelegram, receiptFromOutcome } from "../agent/receipt.js";
import { makeRemittanceStore, summarizeDay } from "../agent/remittance.js";
import { makeWatchdogStore } from "../agent/watchdog.js";
import { makeJobStore } from "../agent/job-ticket.js";
import { makeDueRemindStore } from "../agent/due-remind.js";
import { makeClientSiteStore } from "../agent/client-site.js";
import { runWatchdogPass } from "./ops-watch.js";
import { runDueRemindPass } from "./ops-remind.js";
import {
  DEFAULT_SMS,
  mergeSmsConfig,
  publicSmsConfig,
  canSendSms,
  sendSms as sendGatewaySms,
  listSerialPorts,
} from "../agent/sms-send.js";
import {
  normalizeGatewayConfig,
  mergeGatewayConfig,
  publicGatewayView,
  createGatewayCheckout,
  gatewayRef,
  requestBaseUrl,
  verifyPaymongoSignature,
  verifyXenditToken,
  paymongoPaidToken,
  xenditPaidToken,
} from "./pay-gateway.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function digestBrowserScript() {
  const src = fs.readFileSync(path.join(here, "web-digest.js"), "utf8")
    .replace(/export function /g, "function ");
  return src + "\ninstallSubtleDigestPolyfill(window.crypto || (window.crypto = {}));\n";
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

export const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "X-DNS-Prefetch-Control": "off",
  "Cache-Control": "no-store",
};

function send(res, status, body, headers = {}) {
  const isObj = body && typeof body === "object" && !Buffer.isBuffer(body);
  const data = isObj ? JSON.stringify(body) : (body == null ? "" : body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    ...(isObj ? { "Content-Type": "application/json; charset=utf-8" } : {}),
    ...headers,
  });
  res.end(data);
}

function sessionCookie(token, req, { clear = false } = {}) {
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  const secure = proto === "https" ? "; Secure" : "";
  if (clear) return "mikcon_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" + secure;
  return "mikcon_session=" + token + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200" + secure;
}

function clientIp(req) {
  return (req.socket && req.socket.remoteAddress) || "unknown";
}

function readBody(req, cap = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n > cap) { req.destroy(); reject(new Error("body too large")); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(String(urlPath || "/").split("?")[0]);
  const rel = decoded.replace(/^\/+/, "");
  const full = path.normalize(path.join(root, rel || "index.html"));
  const rootFull = path.normalize(root + path.sep);
  if (full !== path.normalize(root) && !full.startsWith(rootFull)) return null;
  return full;
}

export function startHttpServer({
  host = "0.0.0.0",
  port = 8787,
  wwwDir,
  publicDir,
  dataDir,
  sessions,
  passwordRecord,
}) {
  const loginGuard = makeLoginGuard();
  let rec = passwordRecord || {};
  const store = makeSecureStore({ encryptor: makeFileEncryptor(dataDir), dir: dataDir });
  const db = openStore(path.join(dataDir, "agent.db"));
  const clock = makeClock();
  const payStore = makePayStore({ db, clock, token: randomUUID });
  const recordPayment = makeRecordPayment(db);
  const resolveCustomers = makeResolveCustomers(db);
  const listSales = makeListSales(db);
  const receipts = makeReceiptStore({ db, clock, code: randomUUID });
  const remit = makeRemittanceStore({ db, clock });
  const watchdog = makeWatchdogStore(db);
  const jobs = makeJobStore({ db, clock });
  const dueReminds = makeDueRemindStore(db);
  const sites = makeClientSiteStore({ db, clock });
  let routerNames = {};
  let payConfig = { gcash: {}, brand: {} };
  let gatewayCfg = normalizeGatewayConfig({});
  let smsCfg = mergeSmsConfig(DEFAULT_SMS, {});
  const tgCfg = { token: "", chatId: "" };

  async function loadSmsConfig() {
    try {
      const r = await store.get("sms-gateway");
      if (r && r.found && r.value) smsCfg = mergeSmsConfig(DEFAULT_SMS, JSON.parse(r.value));
    } catch { /* missing config is fine */ }
  }

  async function loadPayConfig() {
    try {
      const r = await store.get("payreminder-config");
      if (r && r.found && r.value) {
        const parsed = JSON.parse(r.value);
        payConfig = {
          gcash: (parsed && parsed.gcash) || {},
          brand: sanitizeBrand((parsed && parsed.brand) || {}),
          routerId: parsed && parsed.routerId || "",
        };
      }
    } catch { /* missing config is fine */ }
  }

  async function routerBlob() {
    try {
      const r = await store.get("routers");
      return r && r.found ? r.value : "";
    } catch { return ""; }
  }

  async function getRouter(id) {
    const list = routersForPolling(await routerBlob());
    return list.find((r) => r.id === String(id)) || null;
  }

  async function sendOpsTelegram(text) {
    if (!tgCfg.token || !tgCfg.chatId) return;
    try { await tg.sendMessage(tgCfg, text); } catch (e) {
      console.error("mikcon-pc-server: ops telegram failed", (e && e.message) || e);
    }
  }

  const payBot = makePayBot({
    tg,
    cfg: tgCfg,
    payStore,
    resolveCustomers,
    getRouter,
    exec: routerExec,
    recordPayment,
    clock,
    onApproved: async ({ row, customer, outcome, actor }) => {
      const rec = receipts.record(receiptFromOutcome({
        row, customer, outcome, actor, today: clock.today(),
      }));
      if (rec) await sendOpsTelegram(formatReceiptTelegram(rec, tg.esc));
    },
  });

  const payment = makePaymentApi({
    db,
    payStore,
    clock,
    getConfig: () => ({
      ...payConfig,
      gcashManual: gatewayCfg.gcashManual,
      gateway: { enabled: gatewayCfg.enabled, provider: gatewayCfg.provider },
    }),
    onPending: (row) => {
      if (!gatewayCfg.gcashManual) return Promise.resolve();
      return payBot.notify(row).catch((e) => {
        console.error("mikcon-pc-server: telegram notify failed", (e && e.message) || e);
      });
    },
    routerNameOf: (id) => routerNames[id] || "",
    receipts,
    gateway: {
      enabled: () => !!gatewayCfg.enabled,
      provider: () => gatewayCfg.provider,
      gcashManual: () => !!gatewayCfg.gcashManual,
      ref: gatewayRef,
      successUrl: (token, req) => {
        const base = requestBaseUrl(req, gatewayCfg.publicBaseUrl);
        return base + "/payment?wait=" + encodeURIComponent(token);
      },
      cancelUrl: (req) => {
        const base = requestBaseUrl(req, gatewayCfg.publicBaseUrl);
        return base + "/payment?cancel=1";
      },
      createCheckout: (o) => createGatewayCheckout({ cfg: gatewayCfg, ...o }),
    },
  });

  const reconnectOnRouter = makeReconnector(routerExec);

  async function renewWallets(routers, customersByRouter) {
    const today = clock.today();
    for (const router of routers || []) {
      const rows = (customersByRouter && customersByRouter[router.id]) || resolveCustomers(router.id) || [];
      for (const c of rows) {
        const r = computeRenewal({ due: c.due, wallet: c.wallet, price: c.price, cycle: c.cycle, today });
        if (!r.rounds) continue;
        const note = parseBill(c.raw_comment).note;
        const comment = billComment(note, {
          price: c.price, cycle: c.cycle, due: r.newDue, paid: today, bal: 0,
          phone: c.phone, wallet: r.newWallet, plan: c.plan,
        });
        try {
          await reconnectOnRouter(router, {
            comment,
            reconnect: reconnectSpec(c),
            shouldReconnect: true,
          });
          c.due = r.newDue;
          c.wallet = r.newWallet;
          c.raw_comment = comment;
          for (let i = 0; i < r.rounds; i++) {
            recordPayment({
              router_id: router.id, customer_key: c.key, kind: c.kind, amount: c.price, at: today,
              method: "wallet", source: "wallet-renew", collected_by: "Wallet",
              ref: c.key + "@" + r.newDue + "#" + i,
            });
          }
          const rec = receipts.record({
            router_id: router.id, customer_key: c.key, account: c.name || c.key,
            amount: (Number(c.price) || 0) * r.rounds, due: r.newDue, wallet: r.newWallet,
            purpose: "wallet", method: "wallet", source: "wallet-renew",
            ref: c.key + "@" + r.newDue, collected_by: "Wallet", at: today,
          });
          await sendOpsTelegram(formatReceiptTelegram(rec, tg.esc));
        } catch (e) {
          console.error("mikcon-pc-server: wallet renew failed for " + c.key, (e && e.message) || e);
        }
      }
    }
  }

  async function refreshCustomers() {
    try {
      await loadGateway();
      await loadTelegram();
      const raw = await routerBlob();
      const routers = routersForPolling(raw);
      const named = routersFromSecureBlob(raw);
      routerNames = Object.fromEntries(named.map((r) => [r.id, r.name || r.id]));
      if (routers.length) {
        const polled = await pollAll({ db, client: routerExec, routers, clock });
        await renewWallets(routers, polled.customers);
        await runWatchdogPass({
          routers,
          failed: polled.failed,
          customers: polled.customers,
          names: routerNames,
          store: watchdog,
          clock,
          exec: routerExec,
          sendAlert: sendOpsTelegram,
          exportDir: path.join(dataDir, "exports"),
        });
        const payBase = String(gatewayCfg.publicBaseUrl || "").replace(/\/+$/, "");
        await loadSmsConfig();
        await runDueRemindPass({
          customers: polled.customers,
          names: routerNames,
          store: dueReminds,
          clock,
          sendAlert: sendOpsTelegram,
          sendSms: canSendSms(smsCfg)
            ? (msg) => sendGatewaySms(smsCfg, { number: msg && msg.number, body: msg && msg.body })
            : undefined,
          payUrl: payBase ? payBase + "/payment" : "",
          esc: tg.esc,
        });
      }
    } catch (e) {
      console.error("mikcon-pc-server: customer refresh failed", (e && e.message) || e);
    }
  }
  async function loadGateway() {
    try {
      const r = await store.get("paygateway-config");
      if (r && r.found && r.value) gatewayCfg = normalizeGatewayConfig(JSON.parse(r.value));
    } catch { /* missing gateway config is fine */ }
  }

  async function loadTelegram() {
    try {
      const r = await store.get("payreminder-telegram");
      if (r && r.found && r.value) {
        const parsed = JSON.parse(r.value);
        tgCfg.token = String((parsed && parsed.token) || "");
        tgCfg.chatId = String((parsed && parsed.chatId) || "");
      }
    } catch { /* missing telegram is fine */ }
  }

  async function applyGatewayPaid(token) {
    const row = token ? payStore.byToken(String(token)) : null;
    if (!row) return { ok: false, reason: "unknown" };
    if (row.status !== "pending") return { ok: true, status: row.status };
    return payBot.decideDirect(row.id, true);
  }

  async function handlePaymongoWebhook(req, res) {
    await loadGateway();
    let raw;
    try { raw = await readBody(req, 256 * 1024); }
    catch { return send(res, 400, { ok: false, error: "bad body" }); }
    if (!verifyPaymongoSignature(raw.toString("utf8"), req.headers["paymongo-signature"], gatewayCfg.paymongo.webhookSecret)) {
      return send(res, 401, { ok: false, error: "bad signature" });
    }
    let body = {};
    try { body = JSON.parse(raw.toString("utf8")); } catch { return send(res, 400, { ok: false }); }
    const token = paymongoPaidToken(body);
    if (!token) return send(res, 200, { ok: true, ignored: true });
    const out = await applyGatewayPaid(token);
    return send(res, 200, { ok: true, status: out.status || out.reason || "ok" });
  }

  async function handleXenditWebhook(req, res) {
    await loadGateway();
    let raw;
    try { raw = await readBody(req, 256 * 1024); }
    catch { return send(res, 400, { ok: false, error: "bad body" }); }
    if (!verifyXenditToken(req.headers["x-callback-token"], gatewayCfg.xendit.webhookToken)) {
      return send(res, 401, { ok: false, error: "bad token" });
    }
    let body = {};
    try { body = JSON.parse(raw.toString("utf8")); } catch { return send(res, 400, { ok: false }); }
    const token = xenditPaidToken(body);
    if (!token) return send(res, 200, { ok: true, ignored: true });
    const out = await applyGatewayPaid(token);
    return send(res, 200, { ok: true, status: out.status || out.reason || "ok" });
  }

  loadPayConfig();
  loadSmsConfig();
  loadGateway();
  loadTelegram().then(function () {
    if (gatewayCfg.gcashManual && tgCfg.token && tgCfg.chatId) {
      payBot.start().catch(function (e) {
        console.error("mikcon-pc-server: telegram bot failed", (e && e.message) || e);
      });
    }
  });
  refreshCustomers();
  const pollTimer = setInterval(refreshCustomers, 15 * 60 * 1000);
  if (pollTimer.unref) pollTimer.unref();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://mikcon.internal");
      const pathname = url.pathname;

      if (pathname === "/payment" && req.method === "GET") {
        await loadPayConfig();
        await loadGateway();
        return payment.handlePage(req, res);
      }
      if (pathname === "/api/payment/lookup" && req.method === "POST") {
        return payment.handleLookup(req, res);
      }
      if (pathname === "/api/payment/submit" && req.method === "POST") {
        return payment.handleSubmit(req, res);
      }
      if (pathname === "/api/payment/checkout" && req.method === "POST") {
        await loadGateway();
        return payment.handleCheckout(req, res);
      }
      if (pathname === "/api/payment/status" && req.method === "GET") {
        return payment.handleStatus(req, res, url);
      }
      if (pathname === "/api/payment/receipt" && req.method === "GET") {
        return payment.handleReceipt(req, res, url);
      }
      if (pathname === "/api/gateway/paymongo" && req.method === "POST") {
        return handlePaymongoWebhook(req, res);
      }
      if (pathname === "/api/gateway/xendit" && req.method === "POST") {
        return handleXenditWebhook(req, res);
      }

      if (pathname === "/api/login" && req.method === "POST") {
        const ip = clientIp(req);
        if (loginGuard.blocked(ip)) return send(res, 429, { ok: false, error: "Too many attempts. Wait a minute." });
        let b = {};
        try { b = JSON.parse((await readBody(req, 4096)).toString("utf8") || "{}"); } catch { b = {}; }
        if (!checkPassword(b.password, rec.salt, rec.hash)) {
          loginGuard.fail(ip);
          return send(res, 401, { ok: false, error: "Wrong password." });
        }
        loginGuard.ok(ip);
        const mustChange = !!rec.mustChange;
        const token = sessions.create({ mustChange: mustChange });
        return send(res, 200, { ok: true, mustChange: mustChange }, { "Set-Cookie": sessionCookie(token, req) });
      }
      if (pathname === "/api/logout" && req.method === "POST") {
        sessions.drop(parseCookie(req.headers.cookie, "mikcon_session"));
        return send(res, 200, { ok: true }, { "Set-Cookie": sessionCookie("", req, { clear: true }) });
      }

      const sessionTok = parseCookie(req.headers.cookie, "mikcon_session");
      const signedIn = sessions.valid(sessionTok);
      if (pathname === "/api/session" && req.method === "GET") {
        return send(res, 200, { ok: signedIn, mustChange: sessions.needsPasswordChange(sessionTok) });
      }
      if (pathname === "/api/password" && req.method === "POST") {
        if (!signedIn) return send(res, 401, { ok: false, error: "Please sign in." });
        let b = {};
        try { b = JSON.parse((await readBody(req, 4096)).toString("utf8") || "{}"); } catch { b = {}; }
        const v = validateNewPassword(b.password, b.confirm);
        if (!v.ok) return send(res, 400, { ok: false, error: v.error });
        rec = savePassword(dataDir, v.password, { mustChange: false });
        sessions.markPasswordChanged(sessionTok);
        return send(res, 200, { ok: true });
      }
      if (signedIn && sessions.needsPasswordChange(sessionTok)) {
        if (pathname.startsWith("/api/")) return send(res, 403, { ok: false, error: "Set a new password first.", mustChange: true });
        if (pathname !== "/login") {
          res.writeHead(302, { Location: "/login", ...SECURITY_HEADERS });
          return res.end();
        }
      }
      if (pathname === "/login") return send(res, 200, LOGIN_PAGE, { "Content-Type": "text/html; charset=utf-8" });
      if (pathname === "/mikcon-digest.js") {
        return send(res, 200, digestBrowserScript(), { "Content-Type": "text/javascript; charset=utf-8" });
      }
      if (pathname === "/mikcon-server-shim.js" || pathname.startsWith("/mikcon-server-shim.js")) {
        const file = path.join(publicDir, "mikcon-server-shim.js");
        return send(res, 200, fs.readFileSync(file), { "Content-Type": "text/javascript; charset=utf-8" });
      }
      if (pathname === "/payment-gateway.js") {
        const file = path.join(publicDir, "payment-gateway.js");
        return send(res, 200, fs.readFileSync(file), { "Content-Type": "text/javascript; charset=utf-8" });
      }
      if (pathname === "/ops-desk.js" || pathname.startsWith("/ops-desk.js")) {
        const file = path.join(publicDir, "ops-desk.js");
        return send(res, 200, fs.readFileSync(file), { "Content-Type": "text/javascript; charset=utf-8" });
      }
      if (pathname === "/plant-map.js" || pathname.startsWith("/plant-map.js")) {
        const file = path.join(publicDir, "plant-map.js");
        return send(res, 200, fs.readFileSync(file), { "Content-Type": "text/javascript; charset=utf-8" });
      }
      if (pathname === "/settings-desk.js" || pathname.startsWith("/settings-desk.js")) {
        const file = path.join(publicDir, "settings-desk.js");
        return send(res, 200, fs.readFileSync(file), { "Content-Type": "text/javascript; charset=utf-8" });
      }
      if (pathname === "/sms-desk.js" || pathname.startsWith("/sms-desk.js")) {
        const file = path.join(publicDir, "sms-desk.js");
        return send(res, 200, fs.readFileSync(file), { "Content-Type": "text/javascript; charset=utf-8" });
      }
      if (pathname.startsWith("/leaflet/")) {
        const file = safeJoin(path.join(publicDir, "leaflet"), pathname.slice("/leaflet".length) || "/");
        if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
          return send(res, 404, "not found", { "Content-Type": "text/plain" });
        }
        const ext = path.extname(file).toLowerCase();
        return send(res, 200, fs.readFileSync(file), { "Content-Type": TYPES[ext] || "application/octet-stream" });
      }
      if (pathname.startsWith("/map-tiles/")) {
        const m = /^\/map-tiles\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(pathname);
        if (!m) return send(res, 400, "bad tile", { "Content-Type": "text/plain" });
        const z = Number(m[1]);
        const x = Number(m[2]);
        const y = Number(m[3]);
        const max = 2 ** z;
        if (z > 19 || x < 0 || y < 0 || x >= max || y >= max) {
          return send(res, 400, "bad tile", { "Content-Type": "text/plain" });
        }
        try {
          const r = await fetch("https://tile.openstreetmap.org/" + z + "/" + x + "/" + y + ".png", {
            headers: { "User-Agent": "MikconPC-Server/3.16.13 (WISP map)" },
          });
          if (!r.ok) return send(res, r.status, "tile error", { "Content-Type": "text/plain" });
          const buf = Buffer.from(await r.arrayBuffer());
          return send(res, 200, buf, { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" });
        } catch {
          return send(res, 502, "tile unavailable", { "Content-Type": "text/plain" });
        }
      }

      if (pathname.startsWith("/api/")) {
        if (!signedIn) return send(res, 401, { ok: false, error: "Please sign in." });
        let b = {};
        if (req.method !== "GET") {
          try { b = JSON.parse((await readBody(req, 256 * 1024)).toString("utf8") || "{}"); }
          catch { return send(res, 400, { ok: false, error: "Invalid JSON." }); }
        }
        if (pathname === "/api/bridge/machine-id") return send(res, 200, await machineId());
        if (pathname === "/api/bridge/secure/get") return send(res, 200, await store.get(b.key));
        if (pathname === "/api/bridge/secure/set") { await store.set(b.key, b.value); return send(res, 200, { ok: true }); }
        if (pathname === "/api/bridge/secure/remove") { await store.remove(b.key); return send(res, 200, { ok: true }); }
        if (pathname === "/api/bridge/router/exec") {
          try { return send(res, 200, { ok: true, data: await routerExec(b || {}) }); }
          catch (e) { return send(res, 200, { ok: false, error: e.message || String(e) }); }
        }
        if (pathname === "/api/bridge/router/discover") {
          return send(res, 200, { ok: true, data: await discover(b || {}) });
        }
        if (pathname === "/api/bridge/http") {
          const target = String(b.url || "");
          if (!isAllowedLicenseUrl(target)) return send(res, 400, { ok: false, error: "License server URL is not allowed" });
          const method = String(b.method || "GET").toUpperCase();
          if (method !== "GET" && method !== "POST") return send(res, 400, { ok: false, error: "License request method is not allowed" });
          const res2 = await fetch(target, {
            method,
            redirect: "error",
            headers: { "Content-Type": "application/json" },
            body: b.data != null ? (typeof b.data === "string" ? b.data : JSON.stringify(b.data)) : undefined,
          });
          let data = await res2.text();
          try { data = JSON.parse(data); } catch {}
          return send(res, 200, { status: res2.status, data });
        }
        if (pathname === "/api/bridge/pay/getConfig") {
          await loadPayConfig();
          return send(res, 200, {
            config: {
              enabled: true,
              port: port,
              routerId: payConfig.routerId || "",
              host: "",
              gcash: payConfig.gcash || {},
              brand: payConfig.brand || {},
            },
            telegram: { chatId: tgCfg.chatId || "", hasToken: !!tgCfg.token },
          });
        }
        if (pathname === "/api/bridge/pay/setConfig") {
          if (b.config && typeof b.config === "object") {
            const clean = {
              enabled: true,
              port: Number(b.config.port) || 0,
              routerId: b.config.routerId ? String(b.config.routerId) : "",
              host: "",
              gcash: mergeGcash(payConfig.gcash, b.config.gcash),
              brand: mergeBrand(payConfig.brand, b.config.brand),
            };
            await store.set("payreminder-config", JSON.stringify(clean));
            await loadPayConfig();
          }
          if (b.telegram && typeof b.telegram === "object") {
            const existing = { token: tgCfg.token, chatId: tgCfg.chatId };
            const merged = {
              token: b.telegram.token ? String(b.telegram.token) : existing.token,
              chatId: b.telegram.chatId != null && b.telegram.chatId !== "" ? String(b.telegram.chatId) : existing.chatId,
            };
            await store.set("payreminder-telegram", JSON.stringify(merged));
            await loadTelegram();
            if (gatewayCfg.gcashManual && tgCfg.token && tgCfg.chatId) {
              payBot.start().catch(function (e) {
                console.error("mikcon-pc-server: telegram bot failed", (e && e.message) || e);
              });
            } else {
              try { payBot.stop(); } catch {}
            }
          }
          return send(res, 200, { ok: true });
        }
        if (pathname === "/api/bridge/pay/getGateway") {
          await loadGateway();
          return send(res, 200, publicGatewayView(gatewayCfg));
        }
        if (pathname === "/api/bridge/pay/setGateway") {
          await loadGateway();
          const merged = mergeGatewayConfig(gatewayCfg, b || {});
          await store.set("paygateway-config", JSON.stringify(merged));
          gatewayCfg = merged;
          if (gatewayCfg.gcashManual && tgCfg.token && tgCfg.chatId) {
            payBot.start().catch(function (e) {
              console.error("mikcon-pc-server: telegram bot failed", (e && e.message) || e);
            });
          } else {
            try { payBot.stop(); } catch {}
          }
          return send(res, 200, publicGatewayView(gatewayCfg));
        }
        if (pathname === "/api/bridge/pay/listPending") {
          const rows = payConfig.routerId
            ? payStore.listPending(payConfig.routerId)
            : db.prepare("SELECT * FROM payment_request WHERE status = 'pending' ORDER BY created_at, id").all();
          return send(res, 200, rows);
        }
        if (pathname === "/api/bridge/pay/decide") {
          return send(res, 200, await payBot.decideDirect(b.id, b.approve, { by: b.by, role: b.role, name: b.by }));
        }
        if (pathname === "/api/bridge/pay/listHistory") {
          return send(res, 200, payStore.listHistory());
        }
        if (pathname === "/api/bridge/pay/clearHistory") {
          if (!actorCanClearHistory({ by: b.by, role: b.role, name: b.by })) {
            return send(res, 403, { ok: false, error: "Only an admin can clear approval history." });
          }
          return send(res, 200, payStore.clearHistory());
        }
        if (pathname === "/api/bridge/pay/listSales") {
          await loadPayConfig();
          return send(res, 200, listSales(b.routerId || payConfig.routerId || ""));
        }
        if (pathname === "/api/bridge/ops/receipts") {
          return send(res, 200, receipts.listRecent());
        }
        if (pathname === "/api/bridge/ops/day") {
          const actor = normalizeActor({ by: b.by, role: b.role, name: b.by });
          const sales = listSales("");
          const sum = summarizeDay(sales, { day: clock.today(), collector: actor.name });
          const closed = remit.todayOf(actor.name);
          return send(res, 200, {
            ...sum,
            closed: !!closed,
            closedRow: closed,
            short: closed ? Math.round((Number(closed.cash) - Number(closed.cash_counted)) * 100) / 100 : null,
          });
        }
        if (pathname === "/api/bridge/ops/closeDay") {
          const actor = normalizeActor({ by: b.by, role: b.role, name: b.by });
          const sales = listSales("");
          const sum = summarizeDay(sales, { day: clock.today(), collector: actor.name });
          return send(res, 200, remit.closeDay({
            collector: actor.name, role: actor.role,
            cash: sum.cash, digital: sum.digital, wallet: sum.wallet,
            cashCounted: b.cashCounted, note: b.note,
          }));
        }
        if (pathname === "/api/bridge/ops/remit") {
          const actor = normalizeActor({ by: b.by, role: b.role, name: b.by });
          return send(res, 200, remit.list(actor));
        }
        if (pathname === "/api/bridge/ops/jobs") {
          if (req.method === "GET") return send(res, 200, jobs.list());
          await loadPayConfig();
          const row = jobs.create({ ...(b || {}), router_id: (b && b.router_id) || payConfig.routerId || "" });
          return send(res, 200, row);
        }
        if (pathname === "/api/bridge/ops/jobAdvance") {
          return send(res, 200, jobs.advance(b.id, b.action, {
            assigned_to: b.assigned_to, customer_key: b.customer_key, note: b.note,
          }));
        }
        if (pathname === "/api/bridge/ops/jobClose") {
          const ticket = jobs.byId(b.id);
          if (!ticket) return send(res, 404, { ok: false, error: "Ticket not found." });
          const key = String(b.customer_key || ticket.customer_key || "");
          const people = resolveCustomers(ticket.router_id) || [];
          const customer = people.find((c) => String(c.key) === key)
            || people.find((c) => String(c.name || "").trim().toLowerCase() === String(ticket.name || "").trim().toLowerCase())
            || null;
          return send(res, 200, jobs.close(b.id, { customer, customer_key: key || (customer && customer.key) }));
        }
        if (pathname === "/api/bridge/ops/watchdog") {
          return send(res, 200, {
            clockSane: clock.isSane(),
            today: clock.today(),
            routers: watchdog.all().map((r) => ({ ...r, name: routerNames[r.router_id] || r.router_id })),
          });
        }
        if (pathname === "/api/bridge/ops/reminders") {
          return send(res, 200, {
            today: clock.today(),
            rows: dueReminds.listRecent(50),
          });
        }
        if (pathname === "/api/bridge/ops/sites") {
          await loadPayConfig();
          const qid = req.method === "GET"
            ? String((url.searchParams && url.searchParams.get("router_id")) || "")
            : String((b && b.router_id) || "");
          const rid = qid || payConfig.routerId || "";
          if (req.method === "GET") {
            return send(res, 200, {
              today: clock.today(),
              rows: sites.list(rid),
              customers: sites.customers(rid),
            });
          }
          const saved = sites.save({ ...(b || {}), router_id: rid });
          if (!saved.ok) return send(res, 400, saved);
          return send(res, 200, saved);
        }
        if (pathname === "/api/bridge/ops/sites/delete") {
          await loadPayConfig();
          const rid = String((b && b.router_id) || payConfig.routerId || "");
          return send(res, 200, sites.remove(rid, b && b.customer_key));
        }
        if (pathname === "/api/bridge/ops/sms/status") {
          await loadSmsConfig();
          return send(res, 200, publicSmsConfig(smsCfg));
        }
        if (pathname === "/api/bridge/ops/sms/ports") {
          const ports = await listSerialPorts();
          return send(res, 200, { ok: true, ports });
        }
        if (pathname === "/api/bridge/ops/sms/config") {
          if (req.method !== "POST") return send(res, 405, { ok: false, error: "POST only" });
          await loadSmsConfig();
          smsCfg = mergeSmsConfig(smsCfg, b || {});
          await store.set("sms-gateway", JSON.stringify(smsCfg));
          return send(res, 200, publicSmsConfig(smsCfg));
        }
        if (pathname === "/api/bridge/ops/sms/send") {
          if (req.method !== "POST") return send(res, 405, { ok: false, error: "POST only" });
          await loadSmsConfig();
          try {
            await sendGatewaySms(smsCfg, { number: b && b.number, body: b && (b.body != null ? b.body : b.message) });
            return send(res, 200, { ok: true });
          } catch (e) {
            return send(res, 200, { ok: false, error: (e && e.message) || String(e) });
          }
        }
        if (pathname.startsWith("/api/bridge/pay/")) return send(res, 200, { ok: true });
        if (pathname.startsWith("/api/bridge/ops/")) return send(res, 404, { ok: false, error: "unknown ops api" });
        return send(res, 404, { ok: false, error: "unknown api" });
      }

      if (!signedIn) {
        res.writeHead(302, { Location: "/login" });
        return res.end();
      }

      let file = safeJoin(wwwDir, pathname === "/" ? "/index.html" : pathname);
      if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        file = path.join(wwwDir, "index.html");
      }
      if (!fs.existsSync(file)) return send(res, 404, "not found", { "Content-Type": "text/plain" });
      let body = fs.readFileSync(file);
      const ext = path.extname(file).toLowerCase();
      if (ext === ".html") body = Buffer.from(injectShim(body.toString("utf8")), "utf8");
      return send(res, 200, body, { "Content-Type": TYPES[ext] || "application/octet-stream" });
    } catch (e) {
      if (!res.headersSent) send(res, 500, { ok: false, error: e.message || "server error" });
    }
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}
