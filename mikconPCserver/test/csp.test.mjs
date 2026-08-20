// Guards the main-process response-header CSP. Electron enforces BOTH this header and
// index.html's meta CSP and applies the stricter per directive, so this header must never
// be narrower than what the app legitimately loads — otherwise it silently breaks features.
// That is exactly what hid the GCash "scan to pay" QR: the header dropped the license host
// from img-src, blocking <img src="https://miklic.jeff-network.com/…">.
//
// Self-contained on purpose: it asserts the header directly rather than diffing against
// index.html, which varies across branches (older revisions ship no meta CSP at all).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const mainJs = readFileSync(path.join(here, "..", "main", "main.js"), "utf8");

function headerCsp() {
  const m = mainJs.match(/"Content-Security-Policy":\s*\["([^"]+)"\]/);
  assert.ok(m, "main.js must set a Content-Security-Policy response header");
  return m[1];
}
function parseCsp(s) {
  const out = {};
  for (const part of s.split(";")) {
    const t = part.trim();
    if (!t) continue;
    const [dir, ...srcs] = t.split(/\s+/);
    out[dir] = srcs;
  }
  return out;
}

test("header CSP img-src permits the license/QR hosts (regression: scan-to-pay QR)", () => {
  const csp = parseCsp(headerCsp());
  for (const src of ["'self'", "data:", "blob:", "https://miklic.jeff-network.com", "https://mikcon.jeff-network.com"]) {
    assert.ok((csp["img-src"] || []).includes(src), `img-src must allow ${src} (else the GCash QR image is blocked)`);
  }
});

test("header CSP connect-src permits the license host", () => {
  const csp = parseCsp(headerCsp());
  for (const src of ["'self'", "https://miklic.jeff-network.com"]) {
    assert.ok((csp["connect-src"] || []).includes(src), `connect-src must allow ${src}`);
  }
});
