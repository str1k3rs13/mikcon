import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  normalizeGatewayConfig,
  mergeGatewayConfig,
  publicGatewayView,
  methodFromRef,
  gatewayRef,
  requestBaseUrl,
  verifyPaymongoSignature,
  verifyXenditToken,
  paymongoPaidToken,
  xenditPaidToken,
  createGatewayCheckout,
  sanitizePublicBaseUrl,
} from "../main/pay-gateway.js";

test("normalize defaults gcash manual on and paymongo selected", () => {
  const c = normalizeGatewayConfig({});
  assert.equal(c.enabled, false);
  assert.equal(c.provider, "paymongo");
  assert.equal(c.gcashManual, true);
});

test("merge keeps existing secrets when the save is blank", () => {
  const prev = normalizeGatewayConfig({
    enabled: true,
    provider: "xendit",
    gcashManual: false,
    paymongo: { secretKey: "sk_live_aaa", webhookSecret: "whsk_1" },
    xendit: { secretKey: "xnd_prod", webhookToken: "tok1" },
  });
  const next = mergeGatewayConfig(prev, {
    enabled: false,
    provider: "paymongo",
    gcashManual: true,
    paymongo: { secretKey: "", webhookSecret: "" },
    xendit: { secretKey: "", webhookToken: "" },
  });
  assert.equal(next.enabled, false);
  assert.equal(next.provider, "paymongo");
  assert.equal(next.gcashManual, true);
  assert.equal(next.paymongo.secretKey, "sk_live_aaa");
  assert.equal(next.xendit.secretKey, "xnd_prod");
});

test("public view never returns secret keys", () => {
  const view = publicGatewayView({
    enabled: true,
    publicBaseUrl: "https://pay.example.com",
    paymongo: { secretKey: "sk_live_secret", webhookSecret: "whsk" },
  });
  assert.equal(view.paymongo.hasSecret, true);
  assert.equal(view.webhookPaymongo, "https://pay.example.com/api/gateway/paymongo");
  assert.equal(JSON.stringify(view).includes("sk_live_secret"), false);
});

test("sanitizePublicBaseUrl rejects credentials and junk", () => {
  assert.equal(sanitizePublicBaseUrl("https://a.trycloudflare.com/"), "https://a.trycloudflare.com");
  assert.equal(sanitizePublicBaseUrl("https://user:pass@evil.com"), "");
  assert.equal(sanitizePublicBaseUrl("javascript:alert(1)"), "");
});

test("gateway refs encode the provider", () => {
  assert.equal(methodFromRef("PMabcd"), "paymongo");
  assert.equal(methodFromRef("XNabcd"), "xendit");
  assert.equal(methodFromRef("GCASH99"), "gcash-manual");
  assert.match(gatewayRef("paymongo", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"), /^PM[a-f0-9]+$/);
});

test("requestBaseUrl prefers the saved public URL", () => {
  const req = { headers: { host: "192.168.1.8:8787", "x-forwarded-proto": "https" } };
  assert.equal(requestBaseUrl(req, "https://pay.example.com"), "https://pay.example.com");
  assert.equal(requestBaseUrl(req, ""), "https://192.168.1.8:8787");
});

test("PayMongo signature is HMAC of timestamp.body", () => {
  const body = '{"data":{"type":"checkout_session.payment.paid"}}';
  const secret = "whsk_test";
  const t = "1700000000";
  const te = createHmac("sha256", secret).update(t + "." + body).digest("hex");
  assert.equal(verifyPaymongoSignature(body, "t=" + t + ",te=" + te + ",li=nope", secret), true);
  assert.equal(verifyPaymongoSignature(body, "t=" + t + ",te=deadbeef", secret), false);
  assert.equal(verifyPaymongoSignature(body, "t=" + t + ",te=" + te, ""), false);
});

test("Xendit callback token is compared in constant time", () => {
  assert.equal(verifyXenditToken("abc", "abc"), true);
  assert.equal(verifyXenditToken("abc", "abd"), false);
  assert.equal(verifyXenditToken("abc", ""), false);
});

test("paid token extractors only accept paid events", () => {
  assert.equal(paymongoPaidToken({
    data: { type: "checkout_session.payment.paid", attributes: { reference_number: "tok1" } },
  }), "tok1");
  assert.equal(paymongoPaidToken({
    data: { type: "checkout_session.payment.failed", attributes: { reference_number: "tok1" } },
  }), "");
  assert.equal(paymongoPaidToken({
    data: {
      type: "event",
      attributes: {
        type: "checkout_session.payment.paid",
        data: { attributes: { reference_number: "tok-live" } },
      },
    },
  }), "tok-live");
  assert.equal(paymongoPaidToken({
    data: {
      type: "event",
      attributes: {
        type: "payment.failed",
        data: { attributes: { reference_number: "tok-live" } },
      },
    },
  }), "");
  assert.equal(xenditPaidToken({ status: "PAID", external_id: "tok2" }), "tok2");
  assert.equal(xenditPaidToken({ status: "PENDING", external_id: "tok2" }), "");
});

test("createGatewayCheckout posts PayMongo centavos and returns checkout_url", async () => {
  const calls = [];
  const fetchImpl = async (url, opt) => {
    calls.push({ url, opt });
    return {
      ok: true,
      json: async () => ({ data: { attributes: { checkout_url: "https://checkout.paymongo.com/cs_1" } } }),
    };
  };
  const out = await createGatewayCheckout({
    cfg: { enabled: true, provider: "paymongo", paymongo: { secretKey: "sk_test_x" } },
    token: "tok99",
    amount: 750.5,
    description: "Bill · Juan",
    successUrl: "https://pay.example.com/payment?wait=tok99",
    cancelUrl: "https://pay.example.com/payment?cancel=1",
    fetchImpl,
  });
  assert.equal(out.ok, true);
  assert.equal(out.url, "https://checkout.paymongo.com/cs_1");
  const sent = JSON.parse(calls[0].opt.body);
  assert.equal(sent.data.attributes.reference_number, "tok99");
  assert.equal(sent.data.attributes.line_items[0].amount, 75050);
});

test("createGatewayCheckout posts Xendit pesos and returns invoice_url", async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ invoice_url: "https://checkout.xendit.co/inv_1" }),
  });
  const out = await createGatewayCheckout({
    cfg: { enabled: true, provider: "xendit", xendit: { secretKey: "xnd_dev" } },
    token: "tok88",
    amount: 600,
    description: "Add credit",
    successUrl: "https://pay.example.com/payment?wait=tok88",
    cancelUrl: "https://pay.example.com/payment?cancel=1",
    fetchImpl,
  });
  assert.equal(out.ok, true);
  assert.equal(out.provider, "xendit");
  assert.equal(out.url, "https://checkout.xendit.co/inv_1");
});

test("createGatewayCheckout refuses when the gateway is off", async () => {
  const out = await createGatewayCheckout({
    cfg: { enabled: false, provider: "paymongo", paymongo: { secretKey: "sk" } },
    token: "t", amount: 100, description: "x", successUrl: "https://a/", cancelUrl: "https://a/",
    fetchImpl: async () => { throw new Error("should not fetch"); },
  });
  assert.equal(out.ok, false);
});
