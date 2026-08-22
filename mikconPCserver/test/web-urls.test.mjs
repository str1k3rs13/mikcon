import { test } from "node:test";
import assert from "node:assert/strict";
import { isTailscaleIPv4, lanIPv4s, listenUrls, formatListenBanner } from "../main/web-urls.js";
import { injectShim, LOGIN_PAGE } from "../main/web-html.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseCloudflareUrl, parseTailscaleIPs } from "../main/web-tunnels.js";
import { hashPassword, checkPassword, generatePassword, makeLoginGuard, MAX_PASSWORD_CHARS, loadOrCreatePassword, validateNewPassword, DEFAULT_PASSWORD, savePassword } from "../main/web-auth.js";
import { safeJoin } from "../main/web-server.js";
import path from "node:path";
import os from "node:os";

test("isTailscaleIPv4 matches CGNAT 100.64/10 only", () => {
  assert.equal(isTailscaleIPv4("100.64.0.1"), true);
  assert.equal(isTailscaleIPv4("100.100.20.3"), true);
  assert.equal(isTailscaleIPv4("100.63.0.1"), false);
  assert.equal(isTailscaleIPv4("192.168.1.10"), false);
});

test("listenUrls lists local, LAN and Tailscale separately", () => {
  const ifaces = {
    eth: [{ family: "IPv4", address: "192.168.68.55", internal: false }],
    ts: [{ family: "IPv4", address: "100.87.12.4", internal: false }],
    lo: [{ family: "IPv4", address: "127.0.0.1", internal: true }],
  };
  const info = listenUrls({ port: 8787, extra: ["https://abc.trycloudflare.com"] }, ifaces);
  assert.equal(info.local, "http://127.0.0.1:8787");
  assert.deepEqual(info.lan, ["http://192.168.68.55:8787"]);
  assert.deepEqual(info.tailscale, ["http://100.87.12.4:8787"]);
  assert.ok(info.all.includes("https://abc.trycloudflare.com"));
});

test("formatListenBanner includes port and one-time password", () => {
  const text = formatListenBanner({
    port: 8787, local: "http://127.0.0.1:8787", lan: ["http://192.168.1.8:8787"], tailscale: [], all: [],
  }, { firstLogin: true });
  assert.match(text, /8787/);
  assert.match(text, /192\.168\.1\.8:8787/);
  assert.match(text, /1234/);
  assert.match(text, /new password/);
  assert.match(text, /\/payment/);
});

test("login page has sign-in then new password confirm", () => {
  assert.match(LOGIN_PAGE, /1234/);
  assert.match(LOGIN_PAGE, /New password/);
  assert.match(LOGIN_PAGE, /Confirm password/);
  assert.match(LOGIN_PAGE, /Save password/);
});

test("injectShim inserts the bridge script once", () => {
  const html = "<html><head><title>x</title></head><body></body></html>";
  const once = injectShim(html);
  assert.match(once, /mikcon-digest\.js/);
  assert.match(once, /mikcon-server-shim\.js/);
  assert.match(once, /payment-gateway\.js/);
  assert.match(once, /ops-desk\.js/);
  assert.match(once, /plant-map\.js/);
  assert.match(once, /settings-desk\.js/);
  assert.match(once, /sms-desk\.js/);
  assert.equal(injectShim(once), once);
});

test("PC SMS shim exposes smsInfo and sendSms for notices", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(path.join(here, "..", "public", "mikcon-server-shim.js"), "utf8");
  assert.match(src, /smsInfo/);
  assert.match(src, /sendSms/);
  assert.match(src, /\/api\/bridge\/ops\/sms\/status/);
  assert.match(src, /\/api\/bridge\/ops\/sms\/send/);
});

test("extra tabs follow staff: cashier SMS only, technician Jobs and Map", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const shim = readFileSync(path.join(here, "..", "public", "mikcon-server-shim.js"), "utf8");
  assert.match(shim, /window\.pcCanOpen/);
  assert.match(shim, /has\("pppoe"\)/);
  assert.match(shim, /has\("sms"\)/);
  const settings = readFileSync(path.join(here, "..", "public", "settings-desk.js"), "utf8");
  assert.match(settings, /pcCanOpen/);
  assert.match(settings, /firstSettings/);
  assert.match(settings, /tab-jobs/);
  const jobs = readFileSync(path.join(here, "..", "public", "ops-desk.js"), "utf8");
  assert.match(jobs, /canOpen\("jobs"\)/);
  const map = readFileSync(path.join(here, "..", "public", "plant-map.js"), "utf8");
  assert.match(map, /canOpen\("map"\)/);
});

test("SMS desk covers Semaphore, USB dongle, PPPoE and IPoE notices", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(path.join(here, "..", "public", "sms-desk.js"), "utf8");
  assert.match(src, /Semaphore/);
  assert.match(src, /USB GSM dongle/);
  assert.match(src, /data-kind=\\"ppp\\"/);
  assert.match(src, /data-kind=\\"ipoe\\"/);
  assert.match(src, /sms-gateway-card/);
  assert.match(src, /setSmsConfig/);
});

test("settings extra tab uses a dropdown for business, SMS, pairing and staff", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(path.join(here, "..", "public", "settings-desk.js"), "utf8");
  assert.match(src, /tab-settings/);
  assert.match(src, /settings-menu/);
  assert.match(src, /Business name/);
  assert.match(src, /data-set="sms"/);
  assert.match(src, /Device pairing/);
  assert.match(src, /Add staff/);
  assert.match(src, /biz-card/);
  assert.match(src, /staff-list/);
  assert.match(src, /st-pack/);
  assert.match(src, /view-sms/);
});

test("plant-map extra tab covers location, status, NAP port and plugin port", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(path.join(here, "..", "public", "plant-map.js"), "utf8");
  assert.match(src, /tab-map/);
  assert.match(src, /go\("map"\)/);
  assert.match(src, /Billed client/);
  assert.match(src, /Port on the box/);
  assert.match(src, /Port at the house/);
  assert.match(src, /Pin on map/);
  assert.match(src, /Type numbers/);
  assert.match(src, /site-lat/);
  assert.match(src, /\/leaflet\/leaflet\.js/);
  assert.match(src, /\/map-tiles\//);
  assert.doesNotMatch(src, /unpkg\.com/);
  assert.match(src, /<select id="site-key">/);
  assert.match(src, /isolation:isolate/);
  assert.match(src, /grid-template-columns:300px minmax\(0,1fr\)/);
  assert.match(src, /coord-row/);
});

test("parseCloudflareUrl and tailscale ips from CLI text", () => {
  assert.equal(parseCloudflareUrl("visitors to https://foo-bar.trycloudflare.com"), "https://foo-bar.trycloudflare.com");
  assert.deepEqual(parseTailscaleIPs("100.91.2.8\nfd7a:115c::1\n"), ["100.91.2.8"]);
});

test("oversized login password is refused without hashing", () => {
  const rec = hashPassword("ok");
  assert.equal(checkPassword("x".repeat(MAX_PASSWORD_CHARS + 1), rec.salt, rec.hash), false);
  assert.equal(checkPassword("ok", rec.salt, rec.hash), true);
});

test("login guard locks one IP after repeated fails", () => {
  const g = makeLoginGuard({ maxFails: 3, windowMs: 60_000 });
  assert.equal(g.blocked("10.0.0.8"), false);
  g.fail("10.0.0.8"); g.fail("10.0.0.8"); g.fail("10.0.0.8");
  assert.equal(g.blocked("10.0.0.8"), true);
  assert.equal(g.blocked("10.0.0.9"), false);
  g.ok("10.0.0.8");
  assert.equal(g.blocked("10.0.0.8"), false);
});

test("password hash verifies and rejects", () => {
  const rec = hashPassword("secret");
  assert.equal(checkPassword("secret", rec.salt, rec.hash), true);
  assert.equal(checkPassword("nope", rec.salt, rec.hash), false);
  assert.equal(generatePassword().length, 10);
});

test("first boot password is 1234 and must be changed", () => {
  const dir = path.join(os.tmpdir(), "mikcon-login-" + Date.now());
  const first = loadOrCreatePassword(dir);
  assert.equal(first.password, DEFAULT_PASSWORD);
  assert.equal(first.mustChange, true);
  assert.equal(checkPassword("1234", first.rec.salt, first.rec.hash), true);
  const again = loadOrCreatePassword(dir);
  assert.equal(again.created, false);
  assert.equal(again.mustChange, true);
  const v = validateNewPassword("1234", "1234");
  assert.equal(v.ok, false);
  const ok = validateNewPassword("secret1", "secret1");
  assert.equal(ok.ok, true);
  const saved = savePassword(dir, "secret1", { mustChange: false });
  assert.equal(saved.mustChange, false);
  assert.equal(checkPassword("secret1", saved.salt, saved.hash), true);
});

test("safeJoin blocks path escape", () => {
  const root = path.resolve("/tmp/www");
  assert.equal(safeJoin(root, "/../../etc/passwd"), null);
});

test("lanIPv4s skips loopback", () => {
  assert.deepEqual(lanIPv4s({ lo: [{ family: "IPv4", address: "127.0.0.1", internal: true }] }), []);
});
