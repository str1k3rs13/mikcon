import { test } from "node:test";
import assert from "node:assert/strict";
import { isAllowedExternal, isAllowedLicenseUrl, canOpenExternally } from "../main/allowlist.js";

test("isAllowedExternal accepts approved hosts over https", () => {
  assert.ok(isAllowedExternal("https://mikcon.jeff-network.com/x"));
  assert.ok(isAllowedExternal("https://checkout.paymongo.com/y"));
  assert.ok(isAllowedExternal("https://www.facebook.com/str1k3rs13/"));
});

test("isAllowedExternal rejects scheme, creds, port, and unknown host", () => {
  assert.equal(isAllowedExternal("http://mikcon.jeff-network.com"), false);   // not https
  assert.equal(isAllowedExternal("https://user:pass@mikcon.jeff-network.com"), false);
  assert.equal(isAllowedExternal("https://mikcon.jeff-network.com:8443"), false);
  assert.equal(isAllowedExternal("https://evil.com"), false);
  assert.equal(isAllowedExternal("https://mikcon.jeff-network.com."), true);  // trailing dot tolerated
});

test("canOpenExternally blocks dangerous schemes before host check", () => {
  assert.equal(canOpenExternally("file:///C:/Windows/System32/calc.exe"), false);
  assert.equal(canOpenExternally("ms-msdt:/id"), false);
  assert.equal(canOpenExternally("\\\\attacker\\share"), false);
  assert.equal(canOpenExternally("tel:+639760591988xyz"), false);
  assert.equal(canOpenExternally("tel:1234abc5670890"), false);
  assert.ok(canOpenExternally("tel:+639760591988"));
  assert.ok(canOpenExternally("tel:6391234567"));
  assert.ok(canOpenExternally("https://paymongo.com/pay"));
});

test("isAllowedLicenseUrl allows https hosts + localhost http", () => {
  assert.ok(isAllowedLicenseUrl("https://miklic.jeff-network.com/api/status"));
  assert.equal(isAllowedLicenseUrl("http://localhost:3000/api/status"), false, "loopback is not a license host in production");
  assert.ok(isAllowedLicenseUrl("http://localhost:3000/api/status", { allowLoopback: true }));
  assert.equal(isAllowedLicenseUrl("http://miklic.jeff-network.com/api/status"), false);
  assert.equal(isAllowedLicenseUrl("https://evil.com/api"), false);
  assert.equal(isAllowedLicenseUrl("https://user:pass@miklic.jeff-network.com/api"), false);
  assert.equal(isAllowedLicenseUrl("https://miklic.jeff-network.com:8443/api"), false);
});
