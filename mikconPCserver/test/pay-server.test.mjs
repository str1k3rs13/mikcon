// LAN-only intake server: the ONLY customer-facing inbound endpoint in the whole payment-
// reminder feature. It can only ever CREATE a pending request — it never approves or
// reconnects. These tests exercise the hardening (body cap, per-IP rate limit, HTML escaping,
// unknown-route handling) as much as the happy path, because that hardening is the point.
import test from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../agent/store.js";
import { makePayStore } from "../agent/pay-store.js";
import { startPayServer } from "../main/pay-server.js";

const clock = { today: () => "2026-08-17" };

function makeHarness(overrides = {}) {
  const db = openStore(":memory:");
  let seq = 0;
  const token = () => "tok" + (++seq);
  const payStore = makePayStore({ db, clock, token });
  const resolveCustomers = overrides.resolveCustomers || (() => [
    { key: "juan01", name: "Juan", kind: "ppp", price: 1000, cycle: "monthly", due: "2026-08-30", plan: "Fiber 50" },
  ]);
  const pending = [];
  const onPending = overrides.onPending || (async (row) => { pending.push(row); });
  const config = Object.assign(
    {
      host: "127.0.0.1",
      port: 0,
      routerId: "r1",
      gcash: { name: "Juan Dela Cruz", number: "0917-000-0000", qrDataUrl: "data:image/png;base64,ABC" },
      brand: { message: "Please settle your bill.", bannerDataUrl: "" },
    },
    overrides.config || {},
  );
  return { db, payStore, resolveCustomers, onPending, pending, config };
}

test("valid submit creates a pending row and notifies onPending once", async (t) => {
  const h = makeHarness();
  const { port, close } = await startPayServer(h);
  t.after(() => close());

  const res = await fetch(`http://127.0.0.1:${port}/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ account: "Juan", ref: "GC-0001", amount: 500 }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.token);

  const row = h.payStore.byToken(body.token);
  assert.equal(row.status, "pending");
  assert.equal(row.customer_key, "juan01");
  assert.equal(h.pending.length, 1);
  assert.equal(h.pending[0].token, body.token);
});

test("status reflects pending then approved after a direct payStore.decide", async (t) => {
  const h = makeHarness();
  const { port, close } = await startPayServer(h);
  t.after(() => close());

  const submit = await fetch(`http://127.0.0.1:${port}/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ account: "Juan", ref: "GC-0002", amount: 300 }),
  });
  const { token } = await submit.json();

  const s1 = await fetch(`http://127.0.0.1:${port}/status?token=${token}`);
  assert.equal(s1.status, 200);
  assert.deepEqual(await s1.json(), { status: "pending" });

  const row = h.payStore.byToken(token);
  h.payStore.decide(row.id, "approved", {});

  const s2 = await fetch(`http://127.0.0.1:${port}/status?token=${token}`);
  assert.deepEqual(await s2.json(), { status: "approved" });
});

test("an unknown token is a 404", async (t) => {
  const h = makeHarness();
  const { port, close } = await startPayServer(h);
  t.after(() => close());

  const res = await fetch(`http://127.0.0.1:${port}/status?token=nope-not-a-real-token`);
  assert.equal(res.status, 404);
});

test("bad ref and bad amount are refused with 400, and create nothing", async (t) => {
  const h = makeHarness();
  const { port, close } = await startPayServer(h);
  t.after(() => close());

  const badRef = await fetch(`http://127.0.0.1:${port}/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ account: "Juan", ref: "!!", amount: 100 }),
  });
  assert.equal(badRef.status, 400);

  const badAmount = await fetch(`http://127.0.0.1:${port}/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ account: "Juan", ref: "GC-BAD1", amount: 0 }),
  });
  assert.equal(badAmount.status, 400);

  assert.equal(h.pending.length, 0);
});

test("a body over the 4KB cap is rejected with 413", async (t) => {
  const h = makeHarness();
  const { port, close } = await startPayServer(h);
  t.after(() => close());

  const huge = "x".repeat(6000);
  const res = await fetch(`http://127.0.0.1:${port}/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ account: "Juan", ref: "GC-HUGE", amount: 1, note: huge }),
  });
  assert.equal(res.status, 413);
  assert.equal(h.pending.length, 0);
});

test("an unknown route is a 404", async (t) => {
  const h = makeHarness();
  const { port, close } = await startPayServer(h);
  t.after(() => close());

  const res = await fetch(`http://127.0.0.1:${port}/nope`);
  assert.equal(res.status, 404);
});

test("an 11th rapid submit from one IP is rate limited with 429", async (t) => {
  const h = makeHarness();
  const { port, close } = await startPayServer(h);
  t.after(() => close());

  let last;
  for (let i = 0; i < 11; i++) {
    last = await fetch(`http://127.0.0.1:${port}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account: "Juan", ref: "GC-R" + i, amount: 1 }),
    });
  }
  assert.equal(last.status, 429);
});

test("GET / contains the GCash number and HTML-escapes an XSS-laden brand message", async (t) => {
  const h = makeHarness({
    config: { brand: { message: "<script>alert(1)</script>", bannerDataUrl: "" } },
  });
  const { port, close } = await startPayServer(h);
  t.after(() => close());

  const res = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /text\/html/);

  const html = await res.text();
  assert.ok(html.includes(h.config.gcash.number), "GCash number should appear");
  assert.ok(!html.includes("<script>alert(1)</script>"), "raw script tag must not appear");
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), "message must be escaped");
});

test("host defaults to a loopback/LAN address, never 0.0.0.0", async (t) => {
  const h = makeHarness();
  delete h.config.host;
  const { server, close } = await startPayServer(h);
  t.after(() => close());
  const addr = server.address();
  assert.notEqual(addr.address, "0.0.0.0");
});
