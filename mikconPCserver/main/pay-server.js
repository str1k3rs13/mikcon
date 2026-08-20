// LAN-only HTTP intake server a disconnected customer reaches through the router's walled
// garden to submit their GCash payment reference. This is the ONLY customer-facing inbound
// endpoint in the whole payment-reminder feature, so it is treated as hostile-input surface:
//
//   - It can only ever CREATE a pending payment_request row. It never approves, never
//     reconnects, never touches the router, never reads secure-store or any file. Approval
//     lives entirely in main/pay-bot.js (Task 8), driven by the owner's Telegram tap.
//   - Every value that reaches the rendered HTML is HTML-escaped, including brand/gcash
//     config, because an operator's own brand.message or a banner data URL is still
//     attacker-reachable text as far as this file is concerned.
//   - The JSON body is capped, content-type checked, and per-IP rate limited before any of it
//     is parsed or handed to normalizeSubmission.
//
// node:http only — no framework, matching the rest of mikconPC's zero-dependency posture.
import { createServer } from "node:http";
import { normalizeSubmission, resolveCustomer } from "../agent/pay-request.js";

// Never "0.0.0.0" and never a public interface. In production the caller (Task 9) passes the
// machine's actual LAN IP explicitly; this default only covers callers (and tests) that don't.
const DEFAULT_HOST = "127.0.0.1";
const BODY_CAP_BYTES = 4096;
const RATE_LIMIT_CAPACITY = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;

export function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Simple per-IP token bucket. capacity tokens refill continuously over windowMs; each /submit
// attempt costs one token regardless of whether it later turns out valid, so a flood of
// malformed bodies cannot dodge the limiter by failing validation.
function makeRateLimiter({ capacity = RATE_LIMIT_CAPACITY, windowMs = RATE_LIMIT_WINDOW_MS } = {}) {
  const buckets = new Map();
  return function take(key) {
    const now = Date.now();
    let b = buckets.get(key);
    if (!b) {
      b = { tokens: capacity, last: now };
      buckets.set(key, b);
    }
    const elapsed = now - b.last;
    if (elapsed > 0) {
      b.tokens = Math.min(capacity, b.tokens + (elapsed / windowMs) * capacity);
      b.last = now;
    }
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  };
}

// Reads the request body up to capBytes. Bytes are counted as they arrive (not trusted from
// Content-Length) so a lying or absent header cannot bypass the cap. Once the cap is crossed
// the buffered chunks are dropped immediately (bounded memory) and the promise rejects with
// BODY_TOO_LARGE without waiting for the rest of the body to arrive.
function readBody(req, capBytes) {
  return new Promise((resolve, reject) => {
    let total = 0;
    let settled = false;
    let chunks = [];
    function fail(code, err) {
      if (settled) return;
      settled = true;
      chunks = [];
      reject(Object.assign(err || new Error(code), { code }));
    }
    req.on("data", (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > capBytes) {
        fail("BODY_TOO_LARGE");
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", (e) => fail("BODY_ERROR", e));
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function renderPage(config) {
  const brand = config.brand || {};
  const gcash = config.gcash || {};
  const message = escapeHtml(brand.message || "");
  const banner = escapeHtml(brand.bannerDataUrl || "");
  const gname = escapeHtml(gcash.name || "");
  const gnumber = escapeHtml(gcash.number || "");
  const qr = escapeHtml(gcash.qrDataUrl || "");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Payment Reminder</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:16px;color:#111}
  .banner{max-width:100%;display:block;margin-bottom:12px}
  .qr{max-width:220px;display:block;margin:8px 0}
  form{display:flex;flex-direction:column;gap:8px;margin-top:16px}
  input,button{font-size:16px;padding:8px}
  #result{margin-top:12px;font-weight:bold}
</style>
</head>
<body>
${banner ? `<img class="banner" src="${banner}" alt="">` : ""}
<p>${message}</p>
<section>
  <h2>Pay via GCash</h2>
  <p>Name: ${gname}</p>
  <p>Number: ${gnumber}</p>
  ${qr ? `<img class="qr" src="${qr}" alt="GCash QR code">` : ""}
</section>
<form id="pay-form">
  <label>Account name/number<input name="account" required maxlength="120"></label>
  <label>GCash reference<input name="ref" required maxlength="40"></label>
  <label>Amount paid<input name="amount" type="number" min="0" step="0.01" required></label>
  <button type="submit">Submit payment</button>
</form>
<p id="result"></p>
<script>
document.getElementById("pay-form").addEventListener("submit", async function (e) {
  e.preventDefault();
  var f = e.target;
  var out = document.getElementById("result");
  out.textContent = "Submitting...";
  try {
    var res = await fetch("/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account: f.account.value, ref: f.ref.value, amount: f.amount.value }),
    });
    var data = await res.json().catch(function () { return {}; });
    if (res.ok) { out.textContent = "Submitted. We will confirm shortly."; }
    else { out.textContent = data && data.error ? data.error : "Could not submit. Please try again."; }
  } catch (err) {
    out.textContent = "Could not reach the server. Please try again.";
  }
});
</script>
</body>
</html>`;
}

export async function startPayServer({ payStore, resolveCustomers, onPending, config }) {
  const cfg = config || {};
  const host = cfg.host || DEFAULT_HOST;
  const port = cfg.port == null ? 0 : cfg.port;
  const routerId = cfg.routerId;
  const take = makeRateLimiter();

  async function handleSubmit(req, res) {
    const ip = (req.socket && req.socket.remoteAddress) || "unknown";
    if (!take(ip)) {
      sendJson(res, 429, { error: "Too many requests. Please wait a moment and try again." });
      return;
    }

    const contentType = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (contentType !== "application/json") {
      sendJson(res, 400, { error: "Content-Type must be application/json." });
      return;
    }

    let rawBody;
    try {
      rawBody = await readBody(req, BODY_CAP_BYTES);
    } catch (e) {
      if (e && e.code === "BODY_TOO_LARGE") {
        sendJson(res, 413, { error: "Request body is too large." });
      } else {
        sendJson(res, 400, { error: "Could not read the request body." });
      }
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(rawBody.toString("utf8"));
    } catch {
      sendJson(res, 400, { error: "Invalid JSON." });
      return;
    }

    const norm = normalizeSubmission(parsed);
    if (!norm.ok) {
      sendJson(res, 400, { error: norm.error });
      return;
    }

    let customers = [];
    try {
      customers = (await resolveCustomers(routerId)) || [];
    } catch {
      customers = [];
    }
    const { customer } = resolveCustomer(norm.request, customers);
    const customerKey = customer ? customer.key : null;

    let created;
    try {
      created = payStore.create({ routerId, request: norm.request, customerKey, clientIp: ip });
    } catch {
      // Most likely the dedupe unique constraint (same ref already submitted on this router).
      sendJson(res, 400, { error: "That reference was already submitted." });
      return;
    }

    const row = payStore.byToken(created.token);
    await onPending(row);
    sendJson(res, 200, { token: created.token });
  }

  function handleStatus(req, res, url) {
    const tk = url.searchParams.get("token");
    const row = tk ? payStore.byToken(tk) : null;
    if (!row) {
      sendJson(res, 404, { status: "unknown" });
      return;
    }
    sendJson(res, 200, { status: row.status });
  }

  const server = createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, "http://payserver.internal");
    } catch {
      sendJson(res, 400, { error: "Bad request." });
      return;
    }
    const method = req.method || "GET";

    if (method === "GET" && url.pathname === "/") {
      const html = renderPage(cfg);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(html) });
      res.end(html);
      return;
    }

    if (method === "GET" && url.pathname === "/status") {
      handleStatus(req, res, url);
      return;
    }

    if (method === "POST" && url.pathname === "/submit") {
      handleSubmit(req, res).catch(() => {
        if (!res.headersSent) sendJson(res, 500, { error: "Internal error." });
        else res.end();
      });
      return;
    }

    sendJson(res, 404, { error: "Not found." });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  return {
    server,
    port: server.address().port,
    close() {
      return new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}
