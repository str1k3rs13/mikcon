// Pure: an approved request + the customer's current bill → the new bill tag, the reconnect intent,
// and the ledger row. No client, no clock, no I/O — asserted against plain objects.
import { billComment, addCycle, parseBill } from "./billing.js";
import { computeRenewal } from "./wallet-renew.js";

export function isNotDue({ due, today }) {
  const d = String(due == null ? "" : due);
  const t = String(today == null ? "" : today);
  return !!(d && t && d > t);
}

// Same reconnect identity for PPPoE (secret name) and IPoE (MAC or IP).
export function reconnectSpec(customer) {
  const kind = String((customer && customer.kind) || "") === "ipoe" ? "ipoe" : "ppp";
  const key = customer && customer.key;
  return {
    kind,
    key,
    address: (customer && customer.address) || (kind === "ipoe" ? key : ""),
    profile: (customer && customer.plan) || "",
  };
}

export function applyApproval({ request, customer, today }) {
  const parsed = parseBill(customer.raw_comment);
  const price = Number(customer.price) || parsed.price || 0;
  const bal0 = Number(customer.bal != null ? customer.bal : parsed.bal) || 0;
  const pay = Number(request.amount) || 0;
  const newBal = bal0 + pay;
  const fullyPaid = price > 0 && newBal >= price;
  const wallet = Math.max(0, Number(customer.wallet != null ? customer.wallet : parsed.wallet) || 0);

  const b = {
    price,
    cycle: customer.cycle || parsed.cycle || "monthly",
    due: fullyPaid ? addCycle(customer.due || parsed.due || today, customer.cycle || parsed.cycle || "monthly") : (customer.due || parsed.due || ""),
    paid: fullyPaid ? today : (customer.paid || parsed.paid || ""),
    phone: customer.phone || parsed.phone || "",
    bal: fullyPaid ? 0 : newBal,
    wallet,
    plan: customer.plan || parsed.plan || "",
  };
  // Keep whatever human note preceded the tag.
  const note = String(customer.raw_comment || "").replace(/\s*\[bill[^\]]*\]/, "").trim();
  const comment = billComment(note, b);

  const reconnect = reconnectSpec({ ...customer, plan: customer.plan || parsed.plan || "" });

  const ledger = {
    router_id: customer.router_id || "",
    customer_key: customer.key,
    kind: reconnect.kind,
    amount: pay,
    at: today,
    method: request.method || methodFromPurpose(request) || "gcash-manual",
    source: request.source || (isGatewayRef(request.ref) ? "gateway" : "reminder"),
    ref: request.ref,
  };

  return { comment, reconnect, ledger, fullyPaid, shouldReconnect: true, due: b.due, wallet };
}

// Customer chose "Add credit" on /payment. The pesos go into w=, not this cycle's bal=.
// Auto-renew (wallet-renew.js) spends it later. Still reconnects: they paid something.
export function applyTopup({ request, customer, today }) {
  const add = Math.max(0, Number(request.amount) || 0);
  const parsed = parseBill(customer.raw_comment);
  const price = Number(customer.price) || parsed.price || 0;
  const wallet = Math.max(0, Number(parsed.wallet) || Number(customer.wallet) || 0) + add;
  const b = {
    price,
    cycle: customer.cycle || parsed.cycle || "monthly",
    due: customer.due || parsed.due || "",
    paid: customer.paid || parsed.paid || "",
    phone: customer.phone || parsed.phone || "",
    bal: Number(customer.bal != null ? customer.bal : parsed.bal) || 0,
    wallet,
    plan: customer.plan || parsed.plan || "",
  };
  const note = String(customer.raw_comment || "").replace(/\s*\[bill[^\]]*\]/, "").trim() || parsed.note;
  const comment = billComment(note, b);
  const reconnect = reconnectSpec({ ...customer, plan: customer.plan || parsed.plan || "" });
  const ledger = {
    router_id: customer.router_id || "",
    customer_key: customer.key,
    kind: reconnect.kind,
    amount: add,
    at: today,
    method: request.method || methodFromPurpose(request) || "topup",
    source: request.source || (isGatewayRef(request.ref) ? "gateway" : "self-pay"),
    ref: request.ref,
  };
  return { comment, reconnect, ledger, fullyPaid: false, wallet, due: b.due, shouldReconnect: false };
}

// One entry for approve/webhook. A payment before the due date is advance credit (wallet).
// If the wallet then covers a cycle, spend it when the bill is due and reconnect.
export function applyPayment({ request, customer, today }) {
  const parsed = parseBill(customer.raw_comment);
  const due = customer.due || parsed.due || "";
  const purpose = String((request && request.purpose) || "").toLowerCase();
  const advance = purpose === "topup" || isNotDue({ due, today });
  if (!advance) return applyApproval({ request, customer, today });

  const top = applyTopup({ request, customer, today });
  const price = Number(customer.price) || parsed.price || 0;
  const cycle = customer.cycle || parsed.cycle || "monthly";
  const wallet = top.wallet;
  const renewal = computeRenewal({ due, wallet, price, cycle, today });
  if (renewal.rounds > 0) {
    const note = String(customer.raw_comment || "").replace(/\s*\[bill[^\]]*\]/, "").trim() || parsed.note;
    const comment = billComment(note, {
      price,
      cycle,
      due: renewal.newDue,
      paid: today,
      bal: 0,
      phone: customer.phone || parsed.phone || "",
      wallet: renewal.newWallet,
      plan: customer.plan || parsed.plan || "",
    });
    return {
      ...top,
      comment,
      wallet: renewal.newWallet,
      due: renewal.newDue,
      fullyPaid: true,
      shouldReconnect: true,
      enoughWallet: true,
      renewed: renewal.rounds,
    };
  }
  const enough = price > 0 && wallet >= price;
  return {
    ...top,
    fullyPaid: false,
    shouldReconnect: enough,
    enoughWallet: enough,
    renewed: 0,
  };
}

function isGatewayRef(ref) {
  const r = String(ref == null ? "" : ref);
  return r.startsWith("PM") || r.startsWith("XN");
}

function methodFromPurpose(request) {
  const r = String((request && request.ref) || "");
  if (r.startsWith("PM")) return "paymongo";
  if (r.startsWith("XN")) return "xendit";
  return "";
}
