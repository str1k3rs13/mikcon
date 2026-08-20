// The owner's Telegram approve/decline loop for a customer's submitted GCash payment (Task 8 of
// the payment-reminder feature). Phase 3 (main/pay-server.js) only ever CREATES a pending
// payment_request row; this is the only place a row leaves "pending" and the only place that ever
// touches the router on the reconnect path.
//
//   - notify(row): posts the pending request to the owner's chat with Approve/Decline buttons,
//     encoding the row id as a 4-char code that fits agent/telegram.js's callback_data regex.
//   - handleUpdate(update): the owner's tap. Approve loads the matched customer, computes the new
//     bill state with agent/pay-approve.js, reconnects on the router, records the ledger row, and
//     marks the request decided. Decline just marks it decided. Everything else (wrong chat,
//     unparseable callback, unknown/already-decided request, no matched customer) is answered but
//     never touches the router or the store beyond the read.
//   - decideDirect(id, approve): the SAME decision, taken from inside the app (Task 10's pane)
//     instead of a Telegram tap. It shares applyDecision() below with handleUpdate so the two entry
//     points can never diverge on what "approved" actually does — one reconnect path, one place
//     that calls recordPayment, one place that marks the row decided.
//   - start()/stop(): a thin long-poll loop over tg.getUpdates, processing updates ONE AT A TIME so
//     that offset only advances past updates that were actually handled, and so a Telegram retry
//     (or a real double-tap) always lands on the *2nd* handleUpdate call, which the
//     status !== "pending" guard turns into a no-op. That guard — not any lock — is what makes
//     approval idempotent. decideDirect gets the same guard from its own pending check.
//
// Reconnect exec calls are NOT hardware-verified. They are built from the RouterOS 7 command shapes
// documented in agent/routeros.js callers elsewhere in this app and pinned against the mock fixture
// in test/fixtures/routeros7.mjs, but (consistent with this repo's known IPoE state — see
// ipoe-decoupling-from-pppoe) nobody has run them against a real router yet.
import { encodeCode, decodeCode } from "../agent/pay-code.js";
import { applyPayment } from "../agent/pay-approve.js";
import { normalizeActor } from "../agent/pay-store.js";

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
const MAC_RE = /^[0-9a-f]{2}([:-][0-9a-f]{2}){5}$/i;

function looksIPv4(s) {
  return IPV4_RE.test(String(s == null ? "" : s));
}

function looksMac(s) {
  return MAC_RE.test(String(s == null ? "" : s).trim());
}

function normMac(s) {
  return String(s == null ? "" : s).toUpperCase().replace(/-/g, ":");
}

// Builds the router-side effect of an approval. Kept as a factory closing over `exec` so
// handleUpdate's call site stays exactly `reconnectOnRouter(getRouter(routerId), outcome, customer)`
// per the task interface, with no exec parameter threaded through by hand.
//
// Exported so scripts/reconnect-shakedown.mjs can drive THIS reconnect path against a real router
// (with a dry-run exec wrapper) — the point being to verify the actual production commands, not a
// copy that could drift from them.
// RouterOS treats a profile= value as a PREFIX. "Fibre" with both "Fibre 10" and "Fibre 20"
// on the box is exactly: "more than one possible value matches input".
export function pickUniqueProfileName(profiles, want) {
  const name = String(want == null ? "" : want).trim();
  if (!name) return { name: "", reason: "empty" };
  const rows = profiles || [];
  const exact = rows.filter((p) => String(p.name) === name);
  if (exact.length === 1) return { name: String(exact[0].name), reason: "exact" };
  const folded = name.toLowerCase();
  const ci = rows.filter((p) => String(p.name).toLowerCase() === folded);
  if (ci.length === 1) return { name: String(ci[0].name), reason: "exact" };
  const prefix = rows.filter((p) => {
    const n = String(p.name);
    return n === name || n.startsWith(name) || name.startsWith(n);
  });
  if (prefix.length > 1) {
    return {
      name: "",
      reason: "ambiguous",
      error: 'Plan "' + name + '" matches more than one PPP profile (' +
        prefix.map((p) => String(p.name)).join(", ") +
        "). Rename profiles so the plan name matches exactly one, then approve again.",
    };
  }
  if (prefix.length === 1) return { name: String(prefix[0].name), reason: "unique-prefix" };
  return {
    name: "",
    reason: "missing",
    error: 'No PPP profile named "' + name + '". Create that profile or fix the plan on the bill, then approve again.',
  };
}

export function makeReconnector(exec) {
  return async function reconnectOnRouter(router, outcome) {
    const { kind, key, address, profile } = outcome.reconnect;
    const comment = outcome.comment;

    if (kind === "ppp") {
      const secs = await exec({ ...router, cmd: "/ppp/secret/print", queries: { name: key } });
      // The router filters server-side, but that is not trusted — pick the row whose name is
      // an EXACT match, the same defensive posture as agent/billing.js's own readers.
      const matches = (secs || []).filter((r) => String(r.name) === String(key));
      if (matches.length > 1) {
        throw new Error("More than one PPPoE secret is named " + key + ". Rename the extras on the router, then approve again.");
      }
      const s = matches[0];
      if (!s) throw new Error("PPP secret not found: " + key);
      if (!s[".id"]) throw new Error("PPP secret has no id: " + key);
      const enable = outcome.shouldReconnect !== false;
      const attrs = { ".id": s[".id"], comment };
      if (enable) {
        attrs.disabled = "no";
        const want = String(profile || "").trim();
        if (want) {
          const profs = await exec({ ...router, cmd: "/ppp/profile/print", queries: {} });
          const picked = pickUniqueProfileName(profs, want);
          if (picked.error) throw new Error(picked.error);
          if (picked.name) attrs.profile = picked.name;
        }
      }
      await exec({
        ...router,
        cmd: "/ppp/secret/set",
        attrs,
      });
      return;
    }

    if (kind === "ipoe") {
      // IPoE identity is a DHCP MAC or a static/queue IP. Resolve to an IP, then
      // write the bill tag on the lease and the queue, and clear NO-PAY to reconnect.
      const hint = String(address || key || "");
      let ip = looksIPv4(hint) ? hint : (looksIPv4(key) ? String(key) : "");
      const macHint = looksMac(hint) ? hint : (looksMac(key) ? String(key) : "");
      const leases = await exec({
        ...router,
        cmd: "/ip/dhcp-server/lease/print",
        queries: {},
      });
      let lease = null;
      if (macHint) {
        const want = normMac(macHint);
        lease = (leases || []).find((l) => normMac(l["mac-address"]) === want) || null;
      }
      if (!lease && ip) {
        lease = (leases || []).find((l) => String(l.address) === String(ip)) || null;
      }
      if (lease && lease.address) ip = String(lease.address);
      if (!ip) throw new Error("cannot resolve IP for " + (key || address));

      const enable = outcome.shouldReconnect !== false;
      // Removing the IP from NO-PAY is the essential act of reconnecting an IPoE customer — this
      // is allowed to throw if it fails, so the owner sees a failure rather than a silent no-op.
      if (enable) {
        const listed = await exec({
          ...router,
          cmd: "/ip/firewall/address-list/print",
          queries: { list: "NO-PAY", address: ip },
        });
        for (const e of (listed || []).filter(
          (e) => String(e.address) === String(ip) && String(e.list) === "NO-PAY"
        )) {
          await exec({ ...router, cmd: "/ip/firewall/address-list/remove", attrs: { ".id": e[".id"] } });
        }
      }

      // The [bill] comment writes are best-effort: a missing lease or queue row must not undo the
      // reconnect above, so each is guarded on its own.
      if (lease) {
        try {
          await exec({
            ...router,
            cmd: "/ip/dhcp-server/lease/set",
            attrs: { ".id": lease[".id"], comment },
          });
        } catch {}
      }
      try {
        const queues = await exec({ ...router, cmd: "/queue/simple/print", queries: {} });
        const q = (queues || []).find(
          (x) => String(x.target || "").split(",")[0].split("/")[0] === String(ip)
        );
        if (q) {
          await exec({ ...router, cmd: "/queue/simple/set", attrs: { ".id": q[".id"], comment } });
        }
      } catch {}
      return;
    }
  };
}

export function makePayBot({
  tg,
  cfg,
  payStore,
  resolveCustomers,
  getRouter,
  exec,
  recordPayment,
  clock,
  onApproved,
  logger = console,
}) {
  const reconnectOnRouter = makeReconnector(exec);
  let running = false;
  let offset = 0;
  let loopPromise = null;

  async function notify(row) {
    const code = encodeCode(row.id);
    const name = row.customer_key ? "(matched)" : "(UNMATCHED — verify)";
    const purpose = String(row.purpose || "bill") === "topup" ? "Add credit" : "Pay bill";
    const text =
      "💸 <b>Payment submitted</b> — " + tg.esc(purpose) + "\n" +
      "Account: " + tg.esc(row.account) + " " + name + "\n" +
      "GCash ref: " + tg.esc(row.ref) + "\n" +
      "Amount: ₱" + tg.esc(String(row.amount)) + "\n\nApprove to apply it.";
    const res = await tg.sendMessage(cfg, text, tg.approvalButtons(code));
    if (res && res.message_id != null) payStore.setMessageId(row.id, String(res.message_id));
    return res;
  }

  // Shared core: everything that happens once a decision (approve/decline) is known for a PENDING
  // row. Both handleUpdate (a Telegram tap) and decideDirect (the in-app pane) call this and
  // nothing else does the reconnect/recordPayment/decide sequence — so the two entry points cannot
  // drift apart on what "approved" or "declined" actually does.
  //
  // messageId is the Telegram message to edit, if any. handleUpdate always has one — the tap came
  // from that exact message. decideDirect passes the row's stored tg_message_id, which is null when
  // the owner decided before notify() ever reached Telegram (or Telegram was unreachable); in that
  // case no edit is attempted, but the decision still stands.
  //
  // Returns { status } normally, or { status: "pending", unmatched: true } for an approve with no
  // matched customer, where the row is deliberately left pending rather than decided — the owner
  // can still reconnect manually and approve later once the account is matched.
  async function applyDecision({ row, approve, messageId, actor }) {
    const mid = messageId || row.tg_message_id;
    const who = normalizeActor(actor);

    if (!approve) {
      const updated = payStore.decide(row.id, "declined", { messageId, by: who.name, role: who.role });
      if (cfg.chatId && mid) {
        try {
          await tg.editMessage(
            cfg, cfg.chatId, mid,
            "❌ Declined — " + tg.esc(row.account) + " (ref " + tg.esc(row.ref) + ")"
          );
        } catch (e) {
          logger.error && logger.error("pay-bot: editMessage failed", e);
        }
      }
      return { status: updated.status };
    }

    const customers = (await resolveCustomers(row.router_id)) || [];
    const customer = customers.find((c) => String(c.key) === String(row.customer_key));
    if (!row.customer_key || !customer) {
      return { status: "pending", unmatched: true };
    }

    const outcome = applyPayment({
      request: { ...row, purpose: row.purpose },
      customer: { ...customer, router_id: row.router_id },
      today: clock.today(),
    });
    // getRouter is async in production (agent-host.js reads the DPAPI router blob) — it MUST be
    // awaited before the router reaches reconnectOnRouter. Spreading an un-awaited Promise as
    // { ...router } yields {}, which would strip host/port/credentials off every reconnect exec.
    await reconnectOnRouter(await getRouter(row.router_id), outcome, customer);
    await recordPayment({ ...outcome.ledger, collected_by: who.name });
    const updated = payStore.decide(row.id, "approved", { messageId, by: who.name, role: who.role });
    if (typeof onApproved === "function") {
      try {
        await onApproved({ row: updated || row, customer, outcome, actor: who });
      } catch (e) {
        logger.error && logger.error("pay-bot: receipt failed", e);
      }
    }
    if (cfg.chatId && mid) {
      try {
        await tg.editMessage(
          cfg, cfg.chatId, mid,
          "✅ Approved — " + tg.esc(row.account) + " ₱" + tg.esc(String(outcome.ledger.amount)) +
            (outcome.fullyPaid ? " (paid in full)" : outcome.enoughWallet ? " (wallet, auto-renew)" : " (partial)")
        );
      } catch (e) {
        logger.error && logger.error("pay-bot: editMessage failed", e);
      }
    }
    return { status: updated.status, fullyPaid: outcome.fullyPaid, amount: outcome.ledger.amount };
  }

  async function handleUpdate(update) {
    const cb = tg.parseCallback(update, cfg.chatId);
    if (!cb) return;
    if (cb.unauthorized) {
      await tg.answerCallback(cfg, cb.id, "Not authorised.");
      return;
    }
    if (cb.bad) {
      await tg.answerCallback(cfg, cb.id, "Unrecognised action.");
      return;
    }
    const id = decodeCode(cb.ref);
    const row = id == null ? null : payStore.byId(id);
    if (!row) {
      await tg.answerCallback(cfg, cb.id, "That request was not found.");
      return;
    }
    // Idempotency: a Telegram retry (or a real double-tap) replays the same callback_data. The
    // first handleUpdate already flipped status away from "pending", so the second call stops here.
    if (row.status !== "pending") {
      await tg.answerCallback(cfg, cb.id, "Already " + row.status + ".");
      return;
    }

    const result = await applyDecision({
      row, approve: cb.approve, messageId: cb.messageId,
      actor: { name: "Telegram", role: "admin" },
    });
    if (result.unmatched) {
      // Leave the row pending — see applyDecision's header comment.
      await tg.answerCallback(cfg, cb.id, "No matching client — reconnect manually.");
      return;
    }
    await tg.answerCallback(cfg, cb.id, cb.approve ? "Approved and reconnected." : "Declined.");
  }

  // The in-app decide path (Task 10's pane Approve/Decline buttons). Same idempotency guard as
  // handleUpdate — status !== "pending" — so a second decideDirect on an already-decided row (or one
  // raced against a Telegram tap that got there first) is a no-op rather than a double reconnect.
  async function decideDirect(id, approve, actor) {
    const row = payStore.byId(Number(id));
    if (!row || row.status !== "pending") {
      return { ok: false, reason: "not pending" };
    }
    let result;
    try {
      result = await applyDecision({
        row, approve: !!approve, messageId: row.tg_message_id, actor,
      });
    } catch (e) {
      return { ok: false, reason: (e && e.message) || "reconnect failed" };
    }
    if (result.unmatched) {
      return { ok: false, reason: "no matching client" };
    }
    return { ok: true, status: result.status };
  }

  async function start() {
    if (running) return;
    running = true;
    loopPromise = (async () => {
      while (running) {
        let updates;
        try {
          updates = (await tg.getUpdates(cfg, offset, 25)) || [];
        } catch (e) {
          logger.error && logger.error("pay-bot: getUpdates failed", e);
          continue;
        }
        // Sequential, one at a time — see the module header on why this is what makes approval
        // idempotent under a Telegram retry.
        for (const u of updates) {
          if (!running) break;
          try {
            await handleUpdate(u);
          } catch (e) {
            logger.error && logger.error("pay-bot: handleUpdate failed", e);
          }
          if (u && u.update_id != null) offset = u.update_id + 1;
        }
      }
    })();
  }

  function stop() {
    running = false;
    return loopPromise || Promise.resolve();
  }

  return { notify, handleUpdate, decideDirect, start, stop };
}
