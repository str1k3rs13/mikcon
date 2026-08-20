// Telegram bot: order notifications, and approving manual payments from the
// phone. Zero dependencies, same as the rest of the service.
//
// Manual approval exists because PayMongo can be unavailable, decline a card,
// or simply not be worth its fee on a small sale. The buyer pays by GCash
// transfer and submits their reference number; the operator approves from
// Telegram. The reference number is UNVERIFIED text — only the operator's
// approval turns it into a fulfilment, which is exactly why a human is in the
// loop.
//
// Ported from `mikrotik config list/lib/telegram.js`. That sibling runs a
// webhook (Telegram pushes updates to a public URL); this desktop app has no
// public URL, so it long-polls instead via getUpdates. setWebhook,
// verifyWebhook, and newWebhookSecret are dropped — nothing here registers
// or authenticates a webhook. The transport is also made injectable so tests
// can assert exact request payloads without a real network call.
import https from "node:https";
import http from "node:http";

function api(cfg, method, payload, timeout = 10000) {
  return new Promise((resolve, reject) => {
    if (!cfg?.token) return reject(new Error("Telegram bot token not set"));
    const base = cfg.baseUrl || "https://api.telegram.org";
    let u;
    try { u = new URL(`${base}/bot${cfg.token}/${method}`); } catch { return reject(new Error("bad Telegram URL")); }
    const data = Buffer.from(JSON.stringify(payload ?? {}));
    const lib = cfg.http || (u.protocol === "http:" ? http : https);
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === "http:" ? 80 : 443),
      path: u.pathname,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": data.length },
      timeout,
    }, (res) => {
      let d = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        let j = null;
        try { j = JSON.parse(d); } catch {}
        if (res.statusCode >= 200 && res.statusCode < 300 && j?.ok) return resolve(j.result);
        reject(new Error(j?.description || `Telegram HTTP ${res.statusCode}`));
      });
    });
    req.on("timeout", () => req.destroy(new Error("Telegram timeout")));
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// Telegram renders a limited HTML subset. Anything interpolated into a message
// is operator or buyer supplied, so it is escaped rather than trusted.
export function esc(s) {
  return String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

export function sendMessage(cfg, text, extra = {}) {
  return api(cfg, "sendMessage", {
    chat_id: cfg.chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  });
}

// Two buttons under a manual payment request. callback_data is capped at 64
// bytes by Telegram, which an order ref comfortably fits.
export function approvalButtons(ref) {
  return {
    reply_markup: {
      inline_keyboard: [[
        { text: "Approve", callback_data: `ok:${ref}` },
        { text: "Reject", callback_data: `no:${ref}` },
      ]],
    },
  };
}

export function answerCallback(cfg, id, text) {
  return api(cfg, "answerCallbackQuery", { callback_query_id: id, text: text || "" });
}

// Removes the buttons once a decision is made, so the same message cannot be
// tapped twice and the outcome is visible in the chat history.
export function editMessage(cfg, chatId, messageId, text) {
  return api(cfg, "editMessageText", {
    chat_id: chatId, message_id: messageId, text, parse_mode: "HTML", disable_web_page_preview: true,
  });
}

// Long-polls Telegram for updates instead of receiving a webhook push, so
// the desktop app needs no public URL. The HTTP timeout is padded past
// Telegram's long-poll timeout so the request itself does not get cut off
// while Telegram is still holding it open waiting for an update.
export function getUpdates(cfg, offset, timeout = 25) {
  return api(cfg, "getUpdates", { offset, timeout, allowed_updates: ["callback_query"] }, (timeout + 10) * 1000);
}

// Only the configured operator may approve.
//
// Which field identifies them depends on where the bot posts:
//
//  - Private chat: the chat id IS the user's id, and Telegram reports the same
//    value in from.id when they tap.
//  - Group: from.id is the individual member who tapped — never the group —
//    and the group's id appears on message.chat.id. Comparing only from.id
//    therefore rejected every tap in a group, which is how a correctly
//    configured operator got "Not authorised".
//
// Accepting the group id means any member of that group can approve. That is
// inherent to posting approvals into a shared group; use a private chat if the
// decision should be yours alone.
export function parseCallback(update, allowedChatId) {
  const cq = update?.callback_query;
  if (!cq) return null;
  const from = String(cq.from?.id ?? "");
  const inChat = String(cq.message?.chat?.id ?? "");
  const want = String(allowedChatId ?? "");
  if (!want || (from !== want && inChat !== want)) {
    return { unauthorized: true, id: cq.id, from };
  }
  const m = String(cq.data ?? "").match(/^(ok|no):([2-9A-HJ-NP-Z]{4})$/);
  if (!m) return { id: cq.id, from, bad: true };
  return {
    id: cq.id,
    from,
    approve: m[1] === "ok",
    ref: m[2],
    chatId: cq.message?.chat?.id,
    messageId: cq.message?.message_id,
  };
}
