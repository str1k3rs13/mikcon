// PayMongo / Xendit checkout for mikconPCserver /payment.
// Secret keys stay on this PC. Webhooks are the only path that auto-approves.
import { createHmac, timingSafeEqual } from "node:crypto";

const PAYMONGO_URL = "https://api.paymongo.com/v2/checkout_sessions";
const XENDIT_URL = "https://api.xendit.co/v2/invoices";
const AMOUNT_CAP = 100000;

export function sanitizePublicBaseUrl(raw) {
  const s = String(raw == null ? "" : raw).trim().replace(/\/+$/, "");
  if (!s) return "";
  let u;
  try { u = new URL(s); } catch { return ""; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "";
  if (u.username || u.password) return "";
  return u.origin;
}

export function normalizeGatewayConfig(raw) {
  const o = raw && typeof raw === "object" ? raw : {};
  const pm = o.paymongo && typeof o.paymongo === "object" ? o.paymongo : {};
  const xn = o.xendit && typeof o.xendit === "object" ? o.xendit : {};
  return {
    enabled: !!o.enabled,
    provider: o.provider === "xendit" ? "xendit" : "paymongo",
    gcashManual: o.gcashManual !== false,
    publicBaseUrl: sanitizePublicBaseUrl(o.publicBaseUrl),
    paymongo: {
      secretKey: String(pm.secretKey || "").trim(),
      webhookSecret: String(pm.webhookSecret || "").trim(),
    },
    xendit: {
      secretKey: String(xn.secretKey || "").trim(),
      webhookToken: String(xn.webhookToken || "").trim(),
    },
  };
}

export function mergeGatewayConfig(prev, patch) {
  const cur = normalizeGatewayConfig(prev);
  const p = patch && typeof patch === "object" ? patch : {};
  const pm = p.paymongo && typeof p.paymongo === "object" ? p.paymongo : {};
  const xn = p.xendit && typeof p.xendit === "object" ? p.xendit : {};
  return normalizeGatewayConfig({
    enabled: p.enabled != null ? !!p.enabled : cur.enabled,
    provider: p.provider != null ? p.provider : cur.provider,
    gcashManual: p.gcashManual != null ? !!p.gcashManual : cur.gcashManual,
    publicBaseUrl: p.publicBaseUrl != null ? p.publicBaseUrl : cur.publicBaseUrl,
    paymongo: {
      secretKey: pm.secretKey ? String(pm.secretKey).trim() : cur.paymongo.secretKey,
      webhookSecret: pm.webhookSecret ? String(pm.webhookSecret).trim() : cur.paymongo.webhookSecret,
    },
    xendit: {
      secretKey: xn.secretKey ? String(xn.secretKey).trim() : cur.xendit.secretKey,
      webhookToken: xn.webhookToken ? String(xn.webhookToken).trim() : cur.xendit.webhookToken,
    },
  });
}

export function publicGatewayView(cfg) {
  const c = normalizeGatewayConfig(cfg);
  const base = c.publicBaseUrl;
  return {
    enabled: c.enabled,
    provider: c.provider,
    gcashManual: c.gcashManual,
    publicBaseUrl: c.publicBaseUrl,
    paymongo: { hasSecret: !!c.paymongo.secretKey, hasWebhook: !!c.paymongo.webhookSecret },
    xendit: { hasSecret: !!c.xendit.secretKey, hasWebhook: !!c.xendit.webhookToken },
    webhookPaymongo: base ? base + "/api/gateway/paymongo" : "",
    webhookXendit: base ? base + "/api/gateway/xendit" : "",
  };
}

export function methodFromRef(ref) {
  const r = String(ref == null ? "" : ref);
  if (r.startsWith("PM")) return "paymongo";
  if (r.startsWith("XN")) return "xendit";
  return "gcash-manual";
}

export function gatewayRef(provider, token) {
  const hex = String(token || "").replace(/-/g, "").slice(0, 16);
  const prefix = provider === "xendit" ? "XN" : "PM";
  return (prefix + hex).slice(0, 40);
}

export function requestBaseUrl(req, fallback) {
  const fromCfg = sanitizePublicBaseUrl(fallback);
  if (fromCfg) return fromCfg;
  const proto = String(req && req.headers && (req.headers["x-forwarded-proto"] || "")).split(",")[0].trim()
    || "http";
  const host = String(
    (req && req.headers && (req.headers["x-forwarded-host"] || req.headers.host)) || ""
  ).split(",")[0].trim();
  if (!host) return "";
  const guess = (proto === "https" ? "https" : "http") + "://" + host;
  return sanitizePublicBaseUrl(guess);
}

function basicAuth(secret) {
  return "Basic " + Buffer.from(String(secret) + ":", "utf8").toString("base64");
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ""), "utf8");
  const bb = Buffer.from(String(b || ""), "utf8");
  if (aa.length !== bb.length || aa.length === 0) return false;
  return timingSafeEqual(aa, bb);
}

export function verifyPaymongoSignature(rawBody, header, secret) {
  if (!secret) return false;
  const parts = {};
  String(header || "").split(",").forEach((p) => {
    const i = p.indexOf("=");
    if (i > 0) parts[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  });
  const t = parts.t;
  const sig = parts.te || parts.li;
  if (!t || !sig) return false;
  const expected = createHmac("sha256", secret).update(t + "." + String(rawBody || "")).digest("hex");
  return safeEqual(expected, sig);
}

export function verifyXenditToken(headerToken, expected) {
  if (!expected) return false;
  return safeEqual(headerToken, expected);
}

function pick(obj, path) {
  let cur = obj;
  for (const k of path) {
    if (!cur || typeof cur !== "object") return "";
    cur = cur[k];
  }
  return cur == null ? "" : String(cur);
}

export function paymongoPaidToken(body) {
  // Live PayMongo webhooks wrap the event as data.type === "event" and put the
  // real event name on data.attributes.type. Tests and older payloads put the
  // paid name on data.type. Accept both so a real Event is not ignored.
  const type = pick(body, ["data", "attributes", "type"])
    || pick(body, ["data", "type"])
    || pick(body, ["type"]);
  if (type !== "checkout_session.payment.paid" && type !== "payment.paid") return "";
  return pick(body, ["data", "attributes", "data", "attributes", "reference_number"])
    || pick(body, ["data", "attributes", "reference_number"])
    || pick(body, ["data", "data", "attributes", "reference_number"])
    || "";
}

export function xenditPaidToken(body) {
  const status = String((body && body.status) || "").toUpperCase();
  if (status !== "PAID" && status !== "SETTLED") return "";
  return String((body && (body.external_id || body.externalId)) || "");
}

export async function createGatewayCheckout({ cfg, token, amount, description, successUrl, cancelUrl, fetchImpl }) {
  const c = normalizeGatewayConfig(cfg);
  if (!c.enabled) return { ok: false, error: "Payment gateway is off." };
  const n = Math.round(Number(amount) * 100) / 100;
  if (!(n > 0) || n > AMOUNT_CAP) return { ok: false, error: "Enter a valid amount." };
  const doFetch = fetchImpl || fetch;
  const desc = String(description || "Internet payment").slice(0, 200);
  if (c.provider === "xendit") {
    if (!c.xendit.secretKey) return { ok: false, error: "Paste the Xendit secret key in Payment Gateway." };
    const res = await doFetch(XENDIT_URL, {
      method: "POST",
      headers: {
        Authorization: basicAuth(c.xendit.secretKey),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        external_id: String(token),
        amount: n,
        currency: "PHP",
        description: desc,
        success_redirect_url: successUrl,
        failure_redirect_url: cancelUrl,
      }),
    });
    const json = await res.json().catch(() => ({}));
    const url = json.invoice_url || json.invoiceUrl || "";
    if (!res.ok || !url) {
      return { ok: false, error: (json.message || json.error || "Xendit did not create the invoice.") };
    }
    return { ok: true, url: String(url), provider: "xendit" };
  }
  if (!c.paymongo.secretKey) return { ok: false, error: "Paste the PayMongo secret key in Payment Gateway." };
  const centavos = Math.round(n * 100);
  const res = await doFetch(PAYMONGO_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuth(c.paymongo.secretKey),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      data: {
        attributes: {
          line_items: [{ name: desc, amount: centavos, currency: "PHP", quantity: 1 }],
          payment_method_types: ["gcash", "card", "qrph", "paymaya"],
          success_url: successUrl,
          cancel_url: cancelUrl,
          reference_number: String(token),
          description: desc,
        },
      },
    }),
  });
  const json = await res.json().catch(() => ({}));
  const url = pick(json, ["data", "attributes", "checkout_url"]);
  if (!res.ok || !url) {
    const err = pick(json, ["errors", "0", "detail"]) || json.detail || "PayMongo did not create the checkout.";
    return { ok: false, error: err };
  }
  return { ok: true, url, provider: "paymongo" };
}
