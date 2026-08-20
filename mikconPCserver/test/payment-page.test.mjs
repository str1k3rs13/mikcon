import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { openStore } from "../agent/store.js";
import { makePayStore } from "../agent/pay-store.js";
import { makePaymentApi, renderPaymentPage } from "../main/payment-page.js";
import { makeReceiptStore } from "../agent/receipt.js";

const clock = { today: () => "2026-08-19" };
let seq = 0;
const token = () => "tok" + (++seq);

function seed(db) {
  db.prepare(`INSERT INTO customer (router_id,kind,key,raw_comment,last_seen,src,name,phone,plan,price,cycle,due,paid,bal,wallet)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    "r1", "ppp", "juan01",
    "Juan Dela Cruz [bill p=750 c=monthly due=2026-09-01 w=100 plan=Fibre]",
    "2026-08-19", "secret", "Juan Dela Cruz", "", "Fibre", 750, "monthly", "2026-09-01", "", 0, 100);
  db.prepare(`INSERT INTO customer (router_id,kind,key,raw_comment,last_seen,src,name,phone,plan,price,cycle,due,paid,bal,wallet)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    "r1", "ppp", "ana01",
    "Cruz, Ana [bill p=600 c=monthly due=2026-08-20 ph=09171234567 plan=Basic]",
    "2026-08-19", "secret", "Cruz, Ana", "09171234567", "Basic", 600, "monthly", "2026-08-20", "", 0, 0);
}

async function start() {
  const db = openStore(":memory:");
  seed(db);
  const payStore = makePayStore({ db, clock, token });
  const api = makePaymentApi({
    db, payStore, clock,
    getConfig: () => ({ gcash: { name: "Jeff", number: "0917" }, brand: { message: "Pay here" } }),
    routerNameOf: () => "Main",
  });
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://pay.internal");
    if (url.pathname === "/payment") return api.handlePage(req, res);
    if (url.pathname === "/api/payment/lookup") return api.handleLookup(req, res);
    if (url.pathname === "/api/payment/submit") return api.handleSubmit(req, res);
    if (url.pathname === "/api/payment/checkout") return api.handleCheckout(req, res);
    if (url.pathname === "/api/payment/status") return api.handleStatus(req, res, url);
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    port, db, payStore,
    async close() { await new Promise((r) => server.close(r)); db.close(); },
  };
}

async function post(port, path, body) {
  const res = await fetch("http://127.0.0.1:" + port + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

test("payment page is a last-name form, not the operator login", () => {
  const html = renderPaymentPage({ gcash: { name: "Jeff" }, brand: { message: "Hello" } });
  assert.match(html, /Last name/);
  assert.match(html, /First name/);
  assert.match(html, /Last 4 digits/);
  assert.match(html, /Pay full bill/);
  assert.match(html, /Pay partial/);
  assert.match(html, /Add credit/);
  assert.match(html, /Open GCash and pay/);
  assert.match(html, /Waiting for approval/);
  assert.match(html, /wait-receipt/);
  assert.match(html, /dash-due/);
  assert.match(html, /dash-wallet/);
  assert.match(html, /dash-status/);
  assert.match(html, /dash-receipt/);
  assert.match(html, /Hello/);
  const branded = renderPaymentPage({
    brand: { name: "JeffNet", phone: "09171234567", address: "Purok 1, Town", logoDataUrl: "data:image/png;base64,aaa", message: "Hello" },
  });
  assert.match(branded, /JeffNet/);
  assert.match(branded, /09171234567/);
  assert.match(branded, /Purok 1, Town/);
  assert.match(branded, /mark-img/);
  assert.match(branded, /JeffNet — Pay/);
  assert.doesNotMatch(html, /Pay now with/);
  assert.doesNotMatch(html, /Sign in to open it/);
  assert.match(html, /openBtn\.onclick[\s\S]*link\.click/);
});

test("gateway page shows Pay now and can hide GCash manual", () => {
  const both = renderPaymentPage({
    gcash: { name: "Jeff" }, brand: { message: "Hello" },
    gateway: { enabled: true, provider: "paymongo" }, gcashManual: true,
  });
  assert.match(both, /Pay now with PayMongo/);
  assert.match(both, /Open GCash and pay/);
  const onlyGw = renderPaymentPage({
    gcash: { name: "Jeff" },
    gateway: { enabled: true, provider: "xendit" }, gcashManual: false,
  });
  assert.match(onlyGw, /Pay now with Xendit/);
  assert.doesNotMatch(onlyGw, /Open GCash and pay/);
  assert.doesNotMatch(onlyGw, /id="send"/);
});

test("lookup by last name alone is refused", async () => {
  const h = await start();
  try {
    const r = await post(h.port, "/api/payment/lookup", { lastName: "Cruz" });
    assert.equal(r.status, 400);
  } finally { await h.close(); }
});

test("lookup needs first name, and last 4 when a phone is on file", async () => {
  const h = await start();
  try {
    const miss = await post(h.port, "/api/payment/lookup", { lastName: "Cruz", firstName: "Ana" });
    assert.equal(miss.status, 200);
    assert.deepEqual(miss.json.matches, []);
    const hit = await post(h.port, "/api/payment/lookup", { lastName: "Cruz", firstName: "Ana", phoneTail: "4567" });
    assert.equal(hit.status, 200);
    assert.equal(hit.json.matches.length, 1);
    assert.equal(hit.json.matches[0].name, "Cruz, Ana");
    assert.equal(hit.json.matches[0].key, undefined);
    assert.equal(hit.json.matches[0].amountDue, 600);
    assert.equal(hit.json.matches[0].status.kind, "ok");
    assert.equal(hit.json.matches[0].status.until, "2026-08-20");
    assert.equal(hit.json.matches[0].status.days, 1);
  } finally { await h.close(); }
});

test("submit records a pending topup against the picked customer", async () => {
  const h = await start();
  try {
    const found = await post(h.port, "/api/payment/lookup", { lastName: "Dela Cruz", firstName: "Juan" });
    assert.equal(found.json.matches.length, 1);
    const pick = found.json.matches[0].pick;
    const sub = await post(h.port, "/api/payment/submit", {
      pick, purpose: "topup", ref: "GCASH99", amount: "1500",
    });
    assert.equal(sub.status, 200);
    const row = h.payStore.byToken(sub.json.token);
    assert.equal(row.status, "pending");
    assert.equal(row.purpose, "topup");
    assert.equal(row.customer_key, "juan01");
    assert.equal(row.amount, 1500);
  } finally { await h.close(); }
});

test("a pick token cannot be reused after a successful submit", async () => {
  const h = await start();
  try {
    const found = await post(h.port, "/api/payment/lookup", { lastName: "Dela Cruz", firstName: "Juan" });
    const pick = found.json.matches[0].pick;
    const first = await post(h.port, "/api/payment/submit", {
      pick, purpose: "bill", ref: "GCASH11", amount: "750",
    });
    assert.equal(first.status, 200);
    const second = await post(h.port, "/api/payment/submit", {
      pick, purpose: "bill", ref: "GCASH12", amount: "750",
    });
    assert.equal(second.status, 400);
  } finally { await h.close(); }
});

test("unknown last name is an empty list, not an error", async () => {
  const h = await start();
  try {
    const r = await post(h.port, "/api/payment/lookup", { lastName: "Nobody", firstName: "Juan" });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.matches, []);
  } finally { await h.close(); }
});

test("checkout creates a pending row and returns the provider URL", async () => {
  const db = openStore(":memory:");
  seed(db);
  const payStore = makePayStore({ db, clock, token });
  const api = makePaymentApi({
    db, payStore, clock,
    getConfig: () => ({ gateway: { enabled: true, provider: "paymongo" }, gcashManual: false }),
    routerNameOf: () => "Main",
    gateway: {
      enabled: () => true,
      provider: () => "paymongo",
      ref: (p, t) => "PM" + String(t).replace(/-/g, "").slice(0, 8),
      successUrl: (tok) => "https://pay.example.com/payment?wait=" + tok,
      cancelUrl: () => "https://pay.example.com/payment?cancel=1",
      createCheckout: async () => ({ ok: true, url: "https://checkout.paymongo.com/cs_test" }),
    },
  });
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://pay.internal");
    if (url.pathname === "/api/payment/lookup") return api.handleLookup(req, res);
    if (url.pathname === "/api/payment/checkout") return api.handleCheckout(req, res);
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const found = await post(port, "/api/payment/lookup", { lastName: "Dela Cruz", firstName: "Juan" });
    const pick = found.json.matches[0].pick;
    const chk = await post(port, "/api/payment/checkout", { pick, purpose: "bill", amount: 750 });
    assert.equal(chk.status, 200);
    assert.equal(chk.json.url, "https://checkout.paymongo.com/cs_test");
    const row = payStore.byToken(chk.json.token);
    assert.equal(row.status, "pending");
    assert.match(row.ref, /^PM/);
    assert.equal(row.amount, 750);
  } finally {
    await new Promise((r) => server.close(r));
    db.close();
  }
});

test("status stays pending until the office approves", async () => {
  const h = await start();
  try {
    const found = await post(h.port, "/api/payment/lookup", { lastName: "Dela Cruz", firstName: "Juan" });
    const pick = found.json.matches[0].pick;
    const sub = await post(h.port, "/api/payment/submit", {
      pick, purpose: "bill", ref: "GCASH77", amount: "750",
    });
    assert.equal(sub.status, 200);
    const st = await fetch("http://127.0.0.1:" + h.port + "/api/payment/status?token=" + sub.json.token);
    const body = await st.json();
    assert.equal(st.status, 200);
    assert.equal(body.status, "pending");
    assert.equal(body.purpose, "topup", "a bill paid before the due date is stored as wallet credit");
    h.payStore.decide(h.payStore.byToken(sub.json.token).id, "approved");
    const st2 = await fetch("http://127.0.0.1:" + h.port + "/api/payment/status?token=" + sub.json.token);
    const body2 = await st2.json();
    assert.equal(body2.status, "approved");
  } finally { await h.close(); }
});

test("status and receipt code return the last receipt after approve", async () => {
  const db = openStore(":memory:");
  seed(db);
  const payStore = makePayStore({ db, clock, token });
  const receipts = makeReceiptStore({ db, clock, code: () => "rcpt-1" });
  const api = makePaymentApi({
    db, payStore, clock, receipts,
    getConfig: () => ({ gcash: { name: "Jeff" } }),
    routerNameOf: () => "Main",
  });
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://pay.internal");
    if (url.pathname === "/api/payment/lookup") return api.handleLookup(req, res);
    if (url.pathname === "/api/payment/submit") return api.handleSubmit(req, res);
    if (url.pathname === "/api/payment/status") return api.handleStatus(req, res, url);
    if (url.pathname === "/api/payment/receipt") return api.handleReceipt(req, res, url);
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const found = await post(port, "/api/payment/lookup", { lastName: "Dela Cruz", firstName: "Juan" });
    const pick = found.json.matches[0].pick;
    const sub = await post(port, "/api/payment/submit", {
      pick, purpose: "topup", ref: "GCASH88", amount: "100",
    });
    const row = payStore.byToken(sub.json.token);
    receipts.record({
      router_id: row.router_id, customer_key: row.customer_key, account: row.account,
      amount: 100, due: "2026-09-01", wallet: 200, request_id: row.id, collected_by: "Admin",
    });
    payStore.decide(row.id, "approved");
    const st = await fetch("http://127.0.0.1:" + port + "/api/payment/status?token=" + sub.json.token);
    const body = await st.json();
    assert.equal(body.status, "approved");
    assert.equal(body.receipt.code, "rcpt-1");
    assert.match(body.receipt.text, /₱100/);
    const rec = await fetch("http://127.0.0.1:" + port + "/api/payment/receipt?code=rcpt-1");
    assert.equal(rec.status, 200);
    assert.equal((await rec.json()).amount, 100);
  } finally {
    await new Promise((r) => server.close(r));
    db.close();
  }
});
