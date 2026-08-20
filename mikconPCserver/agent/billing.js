// The [bill ...] tag, parsed.
//
// This is a PORT of parseBill() from juanfi-app/www/index.html, not a reimplementation. That file
// is shared with the Android app and is never edited by this series, and agent/ is plain Node that
// cannot import from it - so the choice was to copy it and keep the copy honest with a test.
// test/billing-parity.test.mjs extracts the real function and compares both over a corpus; if you
// change anything here, that test is what tells you whether you changed the meaning.
//
// The tag looks like: [bill p=750 c=monthly due=2026-08-30 paid=2026-07-30 ph=0917... bal=0 plan=X]
export const BILL_RE = /\s*\[bill([^\]]*)\]/;

export function parseBill(comment) {
  const c = String(comment || "");
  const m = c.match(BILL_RE);
  // note is the human text with the tag removed, so a comment keeps its meaning either side of it.
  const out = { price: 0, cycle: "monthly", due: "", paid: "", bal: 0, wallet: 0, note: c.replace(BILL_RE, "").trim() };
  if (!m) return out;
  const b = m[1] || "";
  let x;
  if ((x = /\bp=([0-9]+(?:\.[0-9]+)?)/.exec(b))) out.price = Number(x[1]);
  if ((x = /\bc=(monthly|15d|weekly)\b/.exec(b))) out.cycle = x[1];
  if ((x = /\bdue=(\d{4}-\d{2}-\d{2})/.exec(b))) out.due = x[1];
  if ((x = /\bpaid=(\d{4}-\d{2}-\d{2})/.exec(b))) out.paid = x[1];
  // ph= is read BEFORE plan=, which is greedy to the end of the tag.
  if ((x = /\bph=(\+?[0-9]{7,15})/.exec(b))) out.phone = x[1];
  // Money paid toward the CURRENT cycle; outstanding is price - bal. Clamped at 0 because this tag
  // is hand-editable on the router, and a negative balance would invent money nobody ever paid.
  // Read BEFORE plan=, for the same reason ph= is.
  if ((x = /\bbal=([0-9]+(?:\.[0-9]+)?)/.exec(b))) out.bal = Math.max(0, Number(x[1]) || 0);
  // Prepaid wallet balance (pesos). Same clamp reasoning as bal=: hand-editable on the router.
  // Read BEFORE plan=, for the same reason ph= and bal= are.
  if ((x = /\bw=([0-9]+(?:\.[0-9]+)?)/.exec(b))) out.wallet = Math.max(0, Number(x[1]) || 0);
  // plan= holds the client's REAL plan while they sit on the expired profile. Written last and
  // captured to the end of the tag, because profile names may contain spaces and would otherwise
  // split on the delimiter.
  if ((x = /\bplan=(.+)$/.exec(b.trim()))) out.plan = x[1].trim();
  return out;
}

// A queue is a billable customer only if it carries a tag AND is not dynamic.
//
// This filter is the single most important line in the stage. RouterOS builds a DYNAMIC simple
// queue for every rate-limited lease - the app's own note says so: "Both technologies get their
// speed from a rate-limit, so RouterOS builds a dynamic simple queue for each." Without the
// dynamic check, every DHCP customer is found a second time here and every figure derived from
// this table is doubled, silently.
//
// String((q&&q.dynamic)||"") !== "true" rather than !q.dynamic, because RouterOS omits a false
// flag entirely on some versions and an absent property must mean static.
function isBilledQueue(q) {
  return BILL_RE.test(String((q && q.comment) || "")) && String((q && q.dynamic) || "") !== "true";
}

// "Disabled" is the router's way of saying this service is over: the customer moved out, returned
// the hardware, was written off. The tag usually stays on the row, so anything that reads the tag
// without reading this keeps billing someone who is no longer connected - inflating expected
// revenue, filling To-collect with people to chase, and putting them on the SMS list to be texted
// about money for a service they do not have. The app hit exactly that and fixed it; this is the
// same rule, so the agent does not have to learn it a second time.
//
// ABSENT means enabled. RouterOS omits a false flag entirely on some versions, and reading that as
// "gone" would hide a real paying customer - the worse of the two errors.
function isDisabled(row) {
  return String((row && row.disabled) || "") === "true";
}

// Projects one router's three reads into customer rows. Pure: takes already-fetched arrays rather
// than a client, so the rules above are asserted against plain objects with no router in sight.
export function billableFrom({ secrets = [], leases = [], queues = [] } = {}) {
  const out = [];
  const add = (kind, src, rawKey, row, fallbackName) => {
    const key = String(rawKey == null ? "" : rawKey).trim();
    if (!key) return;              // no identity, no row
    const b = parseBill(row.comment);
    out.push({
      kind, src, key,
      raw_comment: String(row.comment || ""),
      name: b.note || fallbackName || key,
      phone: b.phone || "",
      plan: b.plan || "",
      price: b.price,
      cycle: b.cycle,
      due: b.due,
      paid: b.paid,
      bal: b.bal,
      wallet: b.wallet,
    });
  };

  for (const r of secrets || []) {
    if (!r) continue;
    // A secret IS a subscriber, tagged or not - an untagged one is simply a customer nobody has
    // priced yet. But a DISABLED one has left, and pppBills() in the app has always dropped those.
    if (isDisabled(r)) continue;
    add("ppp", "secret", r.name, r, String(r.name || ""));
  }
  for (const r of leases || []) {
    if (!r) continue;
    // Unlike a secret, a lease is not evidence of a subscriber: every phone, TV and guest laptop
    // on the network has one. The app requires the tag here for that reason, and the agent counting
    // untagged leases made it report eleven customers on a router where the app showed five.
    if (!BILL_RE.test(String(r.comment || ""))) continue;
    if (isDisabled(r)) continue;
    add("ipoe", "lease", r["mac-address"], r, String(r["host-name"] || ""));
  }
  for (const q of queues || []) {
    if (!isBilledQueue(q)) continue;
    // target is "10.0.0.7/32" or a comma list; the address is the billing identity here.
    const addr = String(q.target || "").split(",")[0].split("/")[0].trim();
    add("ipoe", "queue", addr, q, String(q.name || ""));
  }
  return out;
}

// Ported verbatim from juanfi-app/www/index.html (normPhone ~line 2091, billComment ~line 2141);
// pinned by test/bill-comment-parity.test.mjs. Philippine mobiles reach the same subscriber as
// 09xx, +639xx or 639xx - store one shape so a number typed three different ways is still
// recognisably the same client, and so the tag stays short. Landlines and short codes are
// rejected: this feature only texts mobiles.
function normPhone(s) {
  var d = String(s == null ? "" : s).replace(/[^0-9+]/g, "");
  if (/^\+639\d{9}$/.test(d)) return "0" + d.slice(3);
  if (/^639\d{9}$/.test(d)) return "0" + d.slice(2);
  if (/^09\d{9}$/.test(d)) return d;
  return ""; // not a PH mobile -> caller decides what to say
}

// ph= and bal= must sit BEFORE plan=: plan is parsed with /plan=(.+)$/ so that profile names may
// contain spaces, which means anything written after it is swallowed into the plan name.
//
// bal= is omitted when zero, so a customer who has never part-paid keeps exactly the tag they
// have today and nothing that reads these comments sees a new field it did not expect.
export function billComment(note, b) {
  var n = String(note || "").trim();
  if (!(Number(b && b.price) > 0)) return n; // no price means no tag, so comments stay clean
  var t = "[bill p=" + b.price + " c=" + (b.cycle || "monthly") + (b.due ? " due=" + b.due : "") + (b.paid ? " paid=" + b.paid : "")
    + (b.phone ? " ph=" + normPhone(b.phone) : "")
    + (Number(b.bal) > 0 ? " bal=" + Number(b.bal) : "")
    + (Number(b.wallet) > 0 ? " w=" + Number(b.wallet) : "")
    + (b.plan ? " plan=" + String(b.plan).replace(/[\]\[]/g, "").trim() : "") + "]";
  return n ? (n + " " + t) : t;
}

// due advances by one billing cycle. monthly = same day next month, clamped to the month's end;
// 15d = +15 days; weekly = +7 days. Pure UTC arithmetic on a YYYY-MM-DD string.
export function addCycle(dateStr, cycle) {
  const [y, m, d] = String(dateStr || "").split("-").map(Number);
  if (!y || !m || !d) return dateStr || "";
  if (cycle === "weekly" || cycle === "15d") {
    const t = Date.UTC(y, m - 1, d) + (cycle === "weekly" ? 7 : 15) * 86400000;
    const dt = new Date(t);
    return dt.toISOString().slice(0, 10);
  }
  // monthly
  const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
  const lastDay = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  const nd = Math.min(d, lastDay);
  return `${ny}-${String(nm).padStart(2, "0")}-${String(nd).padStart(2, "0")}`;
}
