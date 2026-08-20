// Pure validation of a customer's payment submission. No I/O. The reference is unverified text —
// this only shapes it; the owner's approval is what makes it mean anything.
const REF_RE = /^[A-Za-z0-9-]{4,40}$/;
const AMOUNT_CAP = 100000;

export function normalizeSubmission({ account, ref, amount } = {}) {
  const a = String(account == null ? "" : account).trim();
  const r = String(ref == null ? "" : ref).trim();
  const n = Math.round(Number(amount) * 100) / 100;
  if (!a) return { ok: false, error: "Enter your account name or number." };
  if (a.length > 120) return { ok: false, error: "Account is too long." };
  if (!REF_RE.test(r)) return { ok: false, error: "Enter your GCash reference number (letters, digits, dashes)." };
  if (!(n > 0)) return { ok: false, error: "Enter the amount you paid." };
  if (n > AMOUNT_CAP) return { ok: false, error: "That amount looks too large." };
  return { ok: true, request: { account: a, ref: r, amount: n } };
}

export function resolveCustomer(request, customers) {
  const want = String(request && request.account || "").trim().toLowerCase();
  const hit = (customers || []).find((c) =>
    String(c && c.name || "").trim().toLowerCase() === want ||
    String(c && c.key || "").trim().toLowerCase() === want);
  return { matched: !!hit, customer: hit || null };
}

export function dedupeKey(routerId, ref) { return String(routerId) + "|" + String(ref); }
