// Telegram client: owner-only approval gate (parseCallback) plus a fake
// HTTP transport that lets sendMessage/getUpdates be asserted without any
// real network call. The fake models exactly how agent/telegram.js's
// internal api() consumes a node:http-style response (setEncoding, 'data',
// 'end') so it is a drop-in for cfg.http.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { parseCallback, approvalButtons, sendMessage, getUpdates } from "../agent/telegram.js";

// Returns a function matching node http's request(opts, cb) signature.
// Captures {path, body} for the call and invokes cb with a fake response
// that emits the canned JSON then 'end', with statusCode 200.
function fakeRequest(calls, cannedResponse) {
  return (opts, cb) => {
    const call = { path: opts.path, body: "" };
    calls.push(call);
    const req = new EventEmitter();
    req.write = (chunk) => { call.body += chunk; };
    req.end = (chunk) => {
      if (chunk) call.body += chunk;
      const res = new EventEmitter();
      res.statusCode = 200;
      res.setEncoding = () => {};
      cb(res);
      res.emit("data", JSON.stringify(cannedResponse));
      res.emit("end");
    };
    req.destroy = () => {};
    return req;
  };
}

// Ref uses AB23, not AB12 — the sibling's callback_data regex is
// [2-9A-HJ-NP-Z]{4} (Crockford-ish, excludes 0/1/I/O to avoid confusion on a
// phone screen), so a literal "1" would never match. Adjusting the test ref
// to fit the real regex rather than widening parseCallback's authorization
// gate to fit a sample value.
test("only the configured chat may approve", () => {
  const mk = (from, chat, data) => ({ callback_query: { id: "c", from: { id: from }, data, message: { chat: { id: chat }, message_id: 1 } } });
  assert.equal(parseCallback(mk("42", "42", "ok:AB23"), "42").approve, true);
  assert.equal(parseCallback(mk("99", "99", "ok:AB23"), "42").unauthorized, true);
  assert.equal(parseCallback(mk("42", "42", "drop:AB23"), "42").bad, true);
});

test("approvalButtons encodes ok/no under 64 bytes", () => {
  const kb = approvalButtons("AB23").reply_markup.inline_keyboard[0];
  assert.equal(kb[0].callback_data, "ok:AB23");
  assert.equal(kb[1].callback_data, "no:AB23");
});

test("sendMessage posts to the bot with the chat id", async () => {
  const calls = [];
  const http = { request: fakeRequest(calls, { ok: true, result: { message_id: 7 } }) };
  const res = await sendMessage({ token: "T", chatId: "42", http }, "hi");
  assert.equal(res.message_id, 7);
  assert.match(calls[0].path, /\/botT\/sendMessage$/);
  assert.equal(JSON.parse(calls[0].body).chat_id, "42");
});

test("getUpdates long-polls with offset and allowed_updates", async () => {
  const calls = [];
  const http = { request: fakeRequest(calls, { ok: true, result: [] }) };
  const res = await getUpdates({ token: "T", chatId: "42", http }, 100, 25);
  assert.deepEqual(res, []);
  assert.match(calls[0].path, /\/botT\/getUpdates$/);
  const body = JSON.parse(calls[0].body);
  assert.equal(body.offset, 100);
  assert.equal(body.timeout, 25);
  assert.deepEqual(body.allowed_updates, ["callback_query"]);
});
