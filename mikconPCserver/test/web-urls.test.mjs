import { test } from "node:test";
import assert from "node:assert/strict";
import { isTailscaleIPv4, lanIPv4s, listenUrls, formatListenBanner } from "../main/web-urls.js";
import { injectShim, LOGIN_PAGE } from "../main/web-html.js";
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
  assert.equal(injectShim(once), once);
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
