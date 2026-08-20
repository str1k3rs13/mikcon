// The owner's Telegram approve/decline loop. parseCallback/approvalButtons/esc are the REAL
// functions from agent/telegram.js (untouched — the owner-only auth gate lives there); only the
// network calls (sendMessage/editMessage/answerCallback) are faked so tests can assert exact
// arguments without a real HTTP request. exec is a fake that answers reads from the shared
// routeros7 fixture (fleet.secrets/leases/queues) plus a per-test NO-PAY address-list, and records
// every call so the reconnect command SHAPE can be pinned. This does not prove real-router
// behaviour (see ipoe-decoupling-from-pppoe / the module header of pay-bot.js) — it proves the
// commands pay-bot builds have the shape agent/routeros.js expects.
import test from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../agent/store.js";
import { makePayStore } from "../agent/pay-store.js";
import { makePayBot, pickUniqueProfileName } from "../main/pay-bot.js";
import { encodeCode } from "../agent/pay-code.js";
import { esc, approvalButtons, parseCallback } from "../agent/telegram.js";
import { FLEET } from "./fixtures/routeros7.mjs";

const clock = { today: () => "2026-08-17" };

function clone(arr) {
  return (arr || []).map((r) => ({ ...r }));
}

function setup({ resolveCustomersImpl, addressList = [], profiles, activeSessions = [], onApproved } = {}) {
  const db = openStore(":memory:");
  let seq = 0;
  const token = () => "tok" + (++seq);
  const payStore = makePayStore({ db, clock, token });

  const tgCalls = { sendMessage: [], editMessage: [], answerCallback: [] };
  let nextMsgId = 100;
  const tg = {
    esc,
    approvalButtons,
    parseCallback,
    async sendMessage(cfgArg, text, extra) {
      const message_id = nextMsgId++;
      tgCalls.sendMessage.push({ cfg: cfgArg, text, extra, message_id });
      return { message_id };
    },
    async editMessage(cfgArg, chatId, messageId, text) {
      tgCalls.editMessage.push({ cfg: cfgArg, chatId, messageId, text });
      return {};
    },
    async answerCallback(cfgArg, id, text) {
      tgCalls.answerCallback.push({ cfg: cfgArg, id, text });
      return {};
    },
  };

  const execCalls = [];
  async function exec(o) {
    execCalls.push({ host: o.host, cmd: o.cmd, attrs: o.attrs, queries: o.queries });
    switch (o.cmd) {
      case "/ppp/secret/print": return clone(FLEET.secrets);
      case "/ppp/secret/set": return [];
      case "/ppp/active/print": return clone(activeSessions);
      case "/ppp/active/remove": return [];
      case "/ppp/profile/print": return clone(profiles || [
        { ".id": "*P1", name: "Fibre 20 Mbps" },
        { ".id": "*P2", name: "Home 10 Mbps" },
        { ".id": "*P3", name: "default" },
        { ".id": "*P4", name: "expired" },
      ]);
      case "/ip/dhcp-server/lease/print": return clone(FLEET.leases);
      case "/ip/dhcp-server/lease/set": return [];
      case "/queue/simple/print": return clone(FLEET.queues);
      case "/queue/simple/set": return [];
      case "/ip/firewall/address-list/print": return clone(addressList);
      case "/ip/firewall/address-list/remove": return [];
      default: return [];
    }
  }

  const recorded = [];
  async function recordPayment(ledger) {
    recorded.push(ledger);
  }

  const getRouterCalls = [];
  // async on purpose: the production getRouter (agent-host.js) reads the DPAPI router blob and
  // returns a Promise. A synchronous double here hid a real bug where pay-bot passed the un-awaited
  // Promise straight into reconnectOnRouter, stripping every reconnect exec of host/credentials.
  async function getRouter(routerId) {
    getRouterCalls.push(routerId);
    return { host: "10.0.0.1", port: 8728, user: "admin", pass: "x" };
  }

  const resolveCustomers = resolveCustomersImpl || (() => []);
  const cfg = { chatId: "42", token: "T" };
  const bot = makePayBot({ tg, cfg, payStore, resolveCustomers, getRouter, exec, recordPayment, clock, onApproved, logger: { error() {} } });

  return { db, payStore, bot, tgCalls, execCalls, recorded, getRouterCalls, cfg };
}

function callbackUpdate({ id = "cb", from = "42", chat = "42", messageId = 500, data }) {
  return { callback_query: { id, from: { id: from }, data, message: { chat: { id: chat }, message_id: messageId } } };
}

test("pickUniqueProfileName refuses a plan that prefixes two profiles", () => {
  const profiles = [{ name: "Fibre 10" }, { name: "Fibre 20" }, { name: "expired" }];
  const hit = pickUniqueProfileName(profiles, "Fibre");
  assert.equal(hit.name, "");
  assert.equal(hit.reason, "ambiguous");
  assert.match(hit.error, /more than one PPP profile/);
  assert.equal(pickUniqueProfileName(profiles, "Fibre 20").name, "Fibre 20");
  assert.equal(pickUniqueProfileName(profiles, "").reason, "empty");
  assert.equal(
    pickUniqueProfileName([{ name: "Home 10" }], "Home 10 Mbps").reason,
    "missing",
    "a longer plan name must not land on a shorter profile"
  );
});

test("notify sends the encoded code and stores the message id", async () => {
  const { payStore, bot, tgCalls } = setup();
  const { id } = payStore.create({
    routerId: "r1", request: { account: "Ana Cruz", ref: "ABCD", amount: 750 }, customerKey: "ana", clientIp: "10.0.0.5",
  });
  const row = payStore.byId(id);

  await bot.notify(row);

  assert.equal(tgCalls.sendMessage.length, 1);
  const code = encodeCode(id);
  assert.match(code, /^[2-9A-HJ-NP-Z]{4}$/);
  const buttons = tgCalls.sendMessage[0].extra.reply_markup.inline_keyboard[0];
  assert.equal(buttons[0].callback_data, "ok:" + code);
  assert.equal(buttons[1].callback_data, "no:" + code);
  assert.equal(payStore.byId(id).tg_message_id, String(tgCalls.sendMessage[0].message_id));
});

test("authorized Approve of a pending matched ppp request reconnects and records payment; a repeat tap is a no-op", async () => {
  const ana = { kind: "ppp", key: "ana", name: "Ana Cruz", phone: "", plan: "Fibre 20 Mbps",
    price: 750, cycle: "monthly", due: "2026-08-17", paid: "", bal: 0 };
  const { payStore, bot, tgCalls, execCalls, recorded } = setup({
    resolveCustomersImpl: (routerId) => (routerId === "r1" ? [ana] : []),
  });
  const { id } = payStore.create({
    routerId: "r1", request: { account: "Ana Cruz", ref: "ABCD", amount: 750 }, customerKey: "ana", clientIp: "10.0.0.5",
  });
  const code = encodeCode(id);
  const update = callbackUpdate({ id: "cb1", data: "ok:" + code });

  await bot.handleUpdate(update);

  assert.equal(payStore.byId(id).status, "approved");
  assert.equal(execCalls.length, 4, "secret lookup + profile lookup + secret set + active print");
  // The resolved router's connection params must reach exec. getRouter is async in production, so
  // this fails if pay-bot passes its Promise into reconnectOnRouter without awaiting it (spreading
  // a Promise yields {}, silently dropping host/port/credentials off the reconnect commands).
  assert.equal(execCalls[0].host, "10.0.0.1", "resolved router host must reach the secret lookup");
  assert.equal(execCalls[2].host, "10.0.0.1", "resolved router host must reach the secret set");
  assert.equal(execCalls[0].cmd, "/ppp/secret/print");
  assert.deepEqual(execCalls[0].queries, { name: "ana" });
  assert.equal(execCalls[1].cmd, "/ppp/profile/print");
  assert.equal(execCalls[2].cmd, "/ppp/secret/set");
  assert.equal(execCalls[2].attrs[".id"], "*1");
  assert.equal(execCalls[2].attrs.profile, "Fibre 20 Mbps");
  assert.equal(execCalls[2].attrs.disabled, "no");
  assert.match(execCalls[2].attrs.comment, /\[bill/);
  assert.equal(execCalls[3].cmd, "/ppp/active/print");
  assert.deepEqual(execCalls[3].queries, { name: "ana" });

  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].amount, 750);
  assert.equal(recorded[0].customer_key, "ana");
  assert.equal(recorded[0].kind, "ppp");
  assert.equal(recorded[0].method, "gcash-manual");
  assert.equal(recorded[0].ref, "ABCD");

  assert.equal(tgCalls.editMessage.length, 1);
  assert.match(tgCalls.editMessage[0].text, /Approved/);
  assert.equal(tgCalls.answerCallback.length, 1);
  assert.match(tgCalls.answerCallback[0].text, /Approved and reconnected/);

  // Telegram retry / double-tap: same callback_data replayed.
  await bot.handleUpdate(update);
  assert.equal(execCalls.length, 4, "no second reconnect exec call");
  assert.equal(recorded.length, 1, "no second ledger row");
  assert.equal(tgCalls.editMessage.length, 1, "no second edit");
  assert.equal(tgCalls.answerCallback.length, 2);
  assert.match(tgCalls.answerCallback[1].text, /Already approved/);
});

test("PPPoE approve drops the live /ppp/active session by exact name so the new plan takes effect", async () => {
  const ana = { kind: "ppp", key: "ana", name: "Ana Cruz", phone: "", plan: "Fibre 20 Mbps",
    price: 750, cycle: "monthly", due: "2026-08-17", paid: "", bal: 0 };
  const { payStore, bot, execCalls } = setup({
    resolveCustomersImpl: (routerId) => (routerId === "r1" ? [ana] : []),
    activeSessions: [
      { ".id": "*A1", name: "ana" },
      { ".id": "*A2", name: "ana-guest" },
    ],
  });
  const { id } = payStore.create({
    routerId: "r1", request: { account: "Ana Cruz", ref: "DROP1", amount: 750 }, customerKey: "ana", clientIp: "10.0.0.5",
  });
  const result = await bot.decideDirect(id, true);
  assert.equal(result.ok, true);
  const drop = execCalls.find((c) => c.cmd === "/ppp/active/remove");
  assert.ok(drop, "must kick the live session after secret set");
  assert.equal(drop.attrs[".id"], "*A1");
  assert.equal(execCalls.filter((c) => c.cmd === "/ppp/active/remove").length, 1, "must not drop a similarly named session");
});

test("Approve from a wrong chat is rejected before touching the store or the router", async () => {
  const { payStore, bot, tgCalls, execCalls } = setup();
  const { id } = payStore.create({
    routerId: "r1", request: { account: "Ana Cruz", ref: "WXYZ", amount: 500 }, customerKey: "ana", clientIp: "10.0.0.5",
  });
  const code = encodeCode(id);
  const update = callbackUpdate({ id: "cb2", from: "99", chat: "99", data: "ok:" + code });

  await bot.handleUpdate(update);

  assert.equal(payStore.byId(id).status, "pending");
  assert.equal(execCalls.length, 0);
  assert.equal(tgCalls.editMessage.length, 0);
  assert.equal(tgCalls.answerCallback.length, 1);
  assert.match(tgCalls.answerCallback[0].text, /Not authorised/);
});

test("Decline marks the request declined without any router write", async () => {
  const { payStore, bot, tgCalls, execCalls } = setup();
  const { id } = payStore.create({
    routerId: "r1", request: { account: "Ben Reyes", ref: "DEC1", amount: 200 }, customerKey: "ben", clientIp: "10.0.0.6",
  });
  const code = encodeCode(id);
  const update = callbackUpdate({ id: "cb3", data: "no:" + code });

  await bot.handleUpdate(update);

  assert.equal(payStore.byId(id).status, "declined");
  assert.equal(execCalls.length, 0);
  assert.equal(tgCalls.editMessage.length, 1);
  assert.match(tgCalls.editMessage[0].text, /Declined/);
});

test("Approve of an unmatched request is answered but left pending for a manual reconnect", async () => {
  const { payStore, bot, tgCalls, execCalls } = setup();
  const { id } = payStore.create({
    routerId: "r1", request: { account: "Unknown Guy", ref: "UNMT", amount: 300 }, customerKey: null, clientIp: "10.0.0.7",
  });
  const code = encodeCode(id);
  const update = callbackUpdate({ id: "cb4", data: "ok:" + code });

  await bot.handleUpdate(update);

  assert.equal(payStore.byId(id).status, "pending");
  assert.equal(execCalls.length, 0);
  assert.equal(tgCalls.answerCallback.length, 1);
  assert.match(tgCalls.answerCallback[0].text, /reconnect manually/);
});

test("an ipoe lease-backed approve resolves the MAC to an IP, clears NO-PAY, and writes the comment", async () => {
  // Dina Lim in the fixture: lease .id *4, address 10.0.0.21, mac AA:BB:CC:00:00:21; her dynamic
  // rate-limit queue *D shadows the same target, which is exactly the row the comment write must land on.
  const dina = { kind: "ipoe", key: "AA:BB:CC:00:00:21", name: "Dina Lim", phone: "", plan: "Home 10 Mbps",
    price: 600, cycle: "monthly", due: "2026-09-05", paid: "", bal: 0 };
  const noPay = [
    { ".id": "*99", list: "NO-PAY", address: "10.0.0.21" },
    { ".id": "*98", list: "NO-PAY", address: "10.0.0.22" },
  ];
  const { payStore, bot, execCalls, recorded } = setup({
    resolveCustomersImpl: (routerId) => (routerId === "r1" ? [dina] : []),
    addressList: noPay,
  });
  const { id } = payStore.create({
    routerId: "r1", request: { account: "Dina Lim", ref: "IPOE1", amount: 600 },
    customerKey: "AA:BB:CC:00:00:21", clientIp: "10.0.0.8",
  });
  const code = encodeCode(id);
  const update = callbackUpdate({ id: "cb5", data: "ok:" + code });

  await bot.handleUpdate(update);

  assert.equal(payStore.byId(id).status, "approved");

  const cmds = execCalls.map((c) => c.cmd);
  assert.deepEqual(cmds, [
    "/ip/dhcp-server/lease/print",
    "/ip/firewall/address-list/print",
    "/ip/firewall/address-list/remove",
    "/ip/dhcp-server/lease/set",
    "/queue/simple/print",
    "/queue/simple/set",
  ]);

  assert.deepEqual(execCalls[1].queries, { list: "NO-PAY", address: "10.0.0.21" });
  assert.equal(execCalls[2].attrs[".id"], "*99", "removes the entry whose address resolved from the lease, not the unrelated NO-PAY row");
  assert.equal(execCalls[3].attrs[".id"], "*4", "comment lands on Dina's lease");
  assert.match(execCalls[3].attrs.comment, /\[bill/);
  assert.equal(execCalls[5].attrs[".id"], "*D", "comment lands on the queue whose target matches the resolved IP");
  assert.match(execCalls[5].attrs.comment, /\[bill/);

  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].kind, "ipoe");
  assert.equal(recorded[0].customer_key, "AA:BB:CC:00:00:21");
  assert.equal(recorded[0].amount, 600);
});

test("an ipoe queue-backed (static IP) approve clears NO-PAY and writes the queue comment", async () => {
  const fay = { kind: "ipoe", key: "10.0.0.31", name: "Fay Ong", phone: "", plan: "Business 8 Mbps",
    price: 800, cycle: "monthly", due: "2026-08-17", paid: "", bal: 0 };
  const { payStore, bot, execCalls, recorded } = setup({
    resolveCustomersImpl: (routerId) => (routerId === "r1" ? [fay] : []),
    addressList: [{ ".id": "*77", list: "NO-PAY", address: "10.0.0.31" }],
  });
  const { id } = payStore.create({
    routerId: "r1", request: { account: "Fay Ong", ref: "IPOE2", amount: 800 },
    customerKey: "10.0.0.31", clientIp: "10.0.0.8", purpose: "bill",
  });
  const result = await bot.decideDirect(id, true);
  assert.equal(result.ok, true);
  const cmds = execCalls.map((c) => c.cmd);
  assert.ok(cmds.includes("/ip/firewall/address-list/remove"));
  assert.ok(cmds.includes("/queue/simple/set"));
  const qset = execCalls.find((c) => c.cmd === "/queue/simple/set");
  assert.equal(qset.attrs[".id"], "*F");
  assert.match(qset.attrs.comment, /\[bill/);
  assert.equal(recorded[0].kind, "ipoe");
});

test("an ipoe advance below the price writes the wallet and does not clear NO-PAY", async () => {
  const dina = { kind: "ipoe", key: "AA:BB:CC:00:00:21", name: "Dina Lim", phone: "", plan: "Home 10 Mbps",
    price: 600, cycle: "monthly", due: "2026-09-05", paid: "", bal: 0 };
  const { payStore, bot, execCalls } = setup({
    resolveCustomersImpl: (routerId) => (routerId === "r1" ? [dina] : []),
    addressList: [{ ".id": "*99", list: "NO-PAY", address: "10.0.0.21" }],
  });
  const { id } = payStore.create({
    routerId: "r1", request: { account: "Dina Lim", ref: "IPOE3", amount: 100 },
    customerKey: "AA:BB:CC:00:00:21", clientIp: "10.0.0.8", purpose: "bill",
  });
  const result = await bot.decideDirect(id, true);
  assert.equal(result.ok, true);
  assert.equal(execCalls.some((c) => c.cmd === "/ip/firewall/address-list/remove"), false);
  const leaseSet = execCalls.find((c) => c.cmd === "/ip/dhcp-server/lease/set");
  assert.match(leaseSet.attrs.comment, /w=100/);
});

test("start/stop smoke: the poll loop starts, advances offset past a handled update, and stops cleanly", async () => {
  const db = openStore(":memory:");
  let seq = 0;
  const token = () => "tok" + (++seq);
  const payStore = makePayStore({ db, clock, token });
  const cfg = { chatId: "42", token: "T" };

  let getUpdatesCalls = 0;
  const seenOffsets = [];
  const tg = {
    esc, approvalButtons, parseCallback,
    async getUpdates(cfgArg, offsetArg) {
      seenOffsets.push(offsetArg);
      getUpdatesCalls++;
      // Resolve via a macrotask (not an already-settled promise) so a tight poll loop cannot
      // starve the test's own setTimeout — a real long-poll would likewise never resolve instantly.
      await new Promise((r) => setTimeout(r, 1));
      if (getUpdatesCalls === 1) {
        // A bad/unparseable update; handleUpdate should just answer it and offset should advance.
        return [{ update_id: 7, callback_query: { id: "x", from: { id: "42" }, data: "nope", message: { chat: { id: "42" }, message_id: 1 } } }];
      }
      return [];
    },
    async sendMessage() { return { message_id: 1 }; },
    async editMessage() { return {}; },
    async answerCallback() { return {}; },
  };

  const bot = makePayBot({
    tg, cfg, payStore,
    resolveCustomers: () => [],
    getRouter: () => ({ host: "10.0.0.1", port: 8728, user: "admin", pass: "x" }),
    exec: async () => [],
    recordPayment: async () => {},
    clock,
    logger: { error() {} },
  });

  await bot.start();
  // Give the loop a couple of turns to process the first batch and advance the offset.
  await new Promise((r) => setTimeout(r, 20));
  await bot.stop();

  assert.ok(getUpdatesCalls >= 1);
  assert.ok(seenOffsets.length >= 1);
});

// ---------------------------------------------------------------------------
// decideDirect: the in-app decide path (Task 9). Shares applyDecision with handleUpdate, so these
// mirror the handleUpdate tests above rather than exercising anything new about the reconnect or
// idempotency logic — the point is that the two entry points cannot diverge.
// ---------------------------------------------------------------------------

test("decideDirect approve: reconnects on the router, records the payment, and decides — matching handleUpdate", async () => {
  const ana = { kind: "ppp", key: "ana", name: "Ana Cruz", phone: "", plan: "Fibre 20 Mbps",
    price: 750, cycle: "monthly", due: "2026-08-17", paid: "", bal: 0 };
  const { payStore, bot, execCalls, recorded, tgCalls } = setup({
    resolveCustomersImpl: (routerId) => (routerId === "r1" ? [ana] : []),
  });
  const { id } = payStore.create({
    routerId: "r1", request: { account: "Ana Cruz", ref: "DIRA", amount: 750 }, customerKey: "ana", clientIp: "10.0.0.5",
  });

  const result = await bot.decideDirect(id, true);

  assert.deepEqual(result, { ok: true, status: "approved" });
  assert.equal(payStore.byId(id).status, "approved");
  assert.equal(execCalls.length, 4, "secret lookup + profile lookup + secret set + active print, same as an approve via handleUpdate");
  assert.equal(execCalls[0].cmd, "/ppp/secret/print");
  assert.equal(execCalls[1].cmd, "/ppp/profile/print");
  assert.equal(execCalls[2].cmd, "/ppp/secret/set");
  assert.equal(execCalls[3].cmd, "/ppp/active/print");
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].ref, "DIRA");
  assert.equal(recorded[0].amount, 750);
  // No notify() was ever called for this row, so there is no stored tg_message_id to edit.
  assert.equal(tgCalls.editMessage.length, 0);
});

test("decideDirect approve edits the Telegram message when notify() already posted one", async () => {
  const ana = { kind: "ppp", key: "ana", name: "Ana Cruz", phone: "", plan: "Fibre 20 Mbps",
    price: 750, cycle: "monthly", due: "2026-08-17", paid: "", bal: 0 };
  const { payStore, bot, tgCalls } = setup({
    resolveCustomersImpl: (routerId) => (routerId === "r1" ? [ana] : []),
  });
  const { id } = payStore.create({
    routerId: "r1", request: { account: "Ana Cruz", ref: "DIRF", amount: 750 }, customerKey: "ana", clientIp: "10.0.0.5",
  });
  await bot.notify(payStore.byId(id));
  const postedMessageId = String(tgCalls.sendMessage[0].message_id);

  await bot.decideDirect(id, true);

  assert.equal(tgCalls.editMessage.length, 1);
  assert.equal(tgCalls.editMessage[0].messageId, postedMessageId);
  assert.match(tgCalls.editMessage[0].text, /Approved/);
});

test("decideDirect decline: decides without any router write", async () => {
  const { payStore, bot, execCalls, recorded } = setup();
  const { id } = payStore.create({
    routerId: "r1", request: { account: "Ben Reyes", ref: "DIRB", amount: 200 }, customerKey: "ben", clientIp: "10.0.0.6",
  });

  const result = await bot.decideDirect(id, false);

  assert.deepEqual(result, { ok: true, status: "declined" });
  assert.equal(payStore.byId(id).status, "declined");
  assert.equal(execCalls.length, 0);
  assert.equal(recorded.length, 0);
});

test("decideDirect approve on an unmatched request is answered but left pending", async () => {
  const { payStore, bot, execCalls } = setup();
  const { id } = payStore.create({
    routerId: "r1", request: { account: "Unknown Guy", ref: "DIRU", amount: 300 }, customerKey: null, clientIp: "10.0.0.7",
  });

  const result = await bot.decideDirect(id, true);

  assert.deepEqual(result, { ok: false, reason: "no matching client" });
  assert.equal(payStore.byId(id).status, "pending");
  assert.equal(execCalls.length, 0);
});

test("decideDirect does not set an ambiguous plan name", async () => {
  const ana = { kind: "ppp", key: "ana", name: "Ana Cruz", phone: "", plan: "Fibre",
    price: 750, cycle: "monthly", due: "2026-08-17", paid: "", bal: 0 };
  const { payStore, bot, execCalls, recorded } = setup({
    resolveCustomersImpl: (routerId) => (routerId === "r1" ? [ana] : []),
    profiles: [{ name: "Fibre 10" }, { name: "Fibre 20" }, { name: "expired" }],
  });
  const { id } = payStore.create({
    routerId: "r1", request: { account: "Ana Cruz", ref: "AMBI", amount: 750 }, customerKey: "ana", clientIp: "10.0.0.5",
  });
  const result = await bot.decideDirect(id, true);
  assert.equal(result.ok, false);
  assert.match(String(result.reason || ""), /more than one PPP profile/);
  assert.equal(payStore.byId(id).status, "pending");
  assert.equal(recorded.length, 0);
  assert.equal(execCalls.some((c) => c.cmd === "/ppp/secret/set"), false);
});

test("a second decideDirect on an already-decided row is a no-op — no second reconnect, no second ledger row", async () => {
  const ben = { kind: "ppp", key: "ben", name: "Ben Reyes", phone: "", plan: "Home 10 Mbps",
    price: 200, cycle: "monthly", due: "2026-08-17", paid: "", bal: 0 };
  const { payStore, bot, execCalls, recorded } = setup({
    resolveCustomersImpl: (routerId) => (routerId === "r1" ? [ben] : []),
  });
  const { id } = payStore.create({
    routerId: "r1", request: { account: "Ben Reyes", ref: "DIRC", amount: 200 }, customerKey: "ben", clientIp: "10.0.0.6",
  });

  const first = await bot.decideDirect(id, true);
  assert.equal(first.ok, true);
  assert.equal(execCalls.length, 4);
  assert.equal(recorded.length, 1);

  const second = await bot.decideDirect(id, true);
  assert.deepEqual(second, { ok: false, reason: "not pending" });
  assert.equal(execCalls.length, 4, "a second decideDirect reconnected again");
  assert.equal(recorded.length, 1, "a second decideDirect recorded a second ledger row");

  // A decline after an approve is decided is the same no-op, from the other direction.
  const third = await bot.decideDirect(id, false);
  assert.deepEqual(third, { ok: false, reason: "not pending" });
});

test("decideDirect on an unknown request id reports not pending, same as an unknown handleUpdate code", async () => {
  const { bot } = setup();
  const result = await bot.decideDirect(999999, true);
  assert.deepEqual(result, { ok: false, reason: "not pending" });
});

// A Telegram tap and an in-app decide racing the same row: whichever lands first wins, and the
// second — via either path — is a no-op. This is what makes the two entry points safe to expose
// side by side in the pane.
test("handleUpdate and decideDirect share one idempotency guard: whichever decides first wins", async () => {
  const ana = { kind: "ppp", key: "ana", name: "Ana Cruz", phone: "", plan: "Fibre 20 Mbps",
    price: 750, cycle: "monthly", due: "2026-08-17", paid: "", bal: 0 };
  const { payStore, bot, execCalls, recorded } = setup({
    resolveCustomersImpl: (routerId) => (routerId === "r1" ? [ana] : []),
  });
  const { id } = payStore.create({
    routerId: "r1", request: { account: "Ana Cruz", ref: "DIRG", amount: 750 }, customerKey: "ana", clientIp: "10.0.0.5",
  });
  const code = encodeCode(id);

  // The in-app decide lands first...
  const direct = await bot.decideDirect(id, true);
  assert.equal(direct.ok, true);
  assert.equal(execCalls.length, 4);
  assert.equal(recorded.length, 1);

  // ...so the Telegram tap that follows must be a no-op, exactly like a real double-tap.
  await bot.handleUpdate(callbackUpdate({ id: "cb-race", data: "ok:" + code }));
  assert.equal(execCalls.length, 4, "handleUpdate reconnected again after decideDirect already decided");
  assert.equal(recorded.length, 1, "handleUpdate recorded a second ledger row after decideDirect already decided");
});

test("approve calls onApproved once with due and wallet for the receipt", async () => {
  const ana = { kind: "ppp", key: "ana", name: "Ana Cruz", phone: "", plan: "Fibre 20 Mbps",
    price: 750, cycle: "monthly", due: "2026-08-17", paid: "", bal: 0, wallet: 0 };
  const seen = [];
  const { payStore, bot } = setup({
    resolveCustomersImpl: (routerId) => (routerId === "r1" ? [ana] : []),
    onApproved: async (p) => { seen.push(p); },
  });
  const { id } = payStore.create({
    routerId: "r1", request: { account: "Ana Cruz", ref: "RCPT1", amount: 750 }, customerKey: "ana", clientIp: "10.0.0.5",
  });
  await bot.decideDirect(id, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].customer.key, "ana");
  assert.equal(seen[0].outcome.due, "2026-09-17");
  assert.equal(seen[0].outcome.ledger.amount, 750);
});
