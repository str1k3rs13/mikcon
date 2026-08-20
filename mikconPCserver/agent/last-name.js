// How a typed last name is matched to a cached customer display name.
//
// Operators write names as "Cruz, Ana" or "Ana Cruz" / "Juan Dela Cruz". The customer
// only types the last name. Matching is case-insensitive and ignores extra spaces.
// Two-word last names ("Dela Cruz") are accepted as well as the final word ("Cruz").

export function normalizeLastName(raw) {
  const s = String(raw == null ? "" : raw).trim().replace(/\s+/g, " ");
  if (s.length < 2 || s.length > 40) return "";
  if (!/^[A-Za-zÑñ][A-Za-zÑñ .'-]*$/.test(s)) return "";
  return s;
}

export function lastNameKeys(name) {
  const n = String(name == null ? "" : name).trim().replace(/\s+/g, " ");
  if (!n) return [];
  const keys = new Set();
  const comma = n.indexOf(",");
  if (comma > 0) {
    keys.add(n.slice(0, comma).trim().toLowerCase());
  } else {
    const parts = n.split(" ").filter(Boolean);
    if (parts.length) keys.add(parts[parts.length - 1].toLowerCase());
    if (parts.length >= 2) keys.add(parts.slice(-2).join(" ").toLowerCase());
  }
  return [...keys];
}

export function matchesLastName(name, lastName) {
  const want = normalizeLastName(lastName).toLowerCase();
  if (!want) return false;
  return lastNameKeys(name).includes(want);
}

export function normalizeFirstName(raw) {
  return normalizeLastName(raw);
}

export function firstNameKeys(name) {
  const n = String(name == null ? "" : name).trim().replace(/\s+/g, " ");
  if (!n) return [];
  const comma = n.indexOf(",");
  if (comma >= 0) {
    const first = n.slice(comma + 1).trim().toLowerCase();
    if (!first) return [];
    const parts = first.split(" ").filter(Boolean);
    return parts.length ? [first, parts[0]] : [];
  }
  const parts = n.split(" ").filter(Boolean);
  return parts.length ? [parts[0].toLowerCase()] : [];
}

export function matchesFirstName(name, firstName) {
  const want = normalizeFirstName(firstName).toLowerCase();
  if (!want) return false;
  return firstNameKeys(name).includes(want);
}

export function last4Phone(phone) {
  const d = String(phone == null ? "" : phone).replace(/\D/g, "");
  return d.length >= 4 ? d.slice(-4) : "";
}

export function normalizePhoneTail(raw) {
  const d = String(raw == null ? "" : raw).replace(/\D/g, "");
  return d.length === 4 ? d : "";
}

// Last name + first name always. If the bill has a cellphone, last 4 digits too.
// Same false for every miss so lookup cannot tell which field was wrong.
export function matchesAccount(customer, { lastName, firstName, phoneTail } = {}) {
  const name = customer && customer.name;
  if (!matchesLastName(name, lastName)) return false;
  if (!matchesFirstName(name, firstName)) return false;
  const have = last4Phone(customer && customer.phone);
  if (have) return have === normalizePhoneTail(phoneTail);
  return true;
}

export function amountDue(customer) {
  const price = Math.max(0, Number(customer && customer.price) || 0);
  const bal = Math.max(0, Number(customer && customer.bal) || 0);
  return Math.max(0, Math.round((price - bal) * 100) / 100);
}

export function ymdDiffDays(from, to) {
  const a = Date.parse(String(from || "").slice(0, 10) + "T00:00:00");
  const b = Date.parse(String(to || "").slice(0, 10) + "T00:00:00");
  if (!isFinite(a) || !isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

// What a customer should read: Active / Due today / Expired, plus the date their
// current cycle ends. today is YYYY-MM-DD from the PC clock, never the phone.
export function serviceStatus({ due, today } = {}) {
  const d = String(due || "").slice(0, 10);
  const t = String(today || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    return { kind: "unknown", label: "No expiry date", until: "", days: null };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) {
    return { kind: "unknown", label: "Valid until " + d, until: d, days: null };
  }
  const days = ymdDiffDays(t, d);
  if (days == null) return { kind: "unknown", label: "Valid until " + d, until: d, days: null };
  if (days > 0) return { kind: "ok", label: "Active", until: d, days };
  if (days === 0) return { kind: "due", label: "Due today", until: d, days: 0 };
  return { kind: "over", label: "Expired", until: d, days };
}

export function publicCustomerCard(customer, routerName) {
  const name = String((customer && customer.name) || "").trim() || "Customer";
  return {
    name,
    site: String(routerName || ""),
    due: String((customer && customer.due) || ""),
    amountDue: amountDue(customer),
    wallet: Math.max(0, Number(customer && customer.wallet) || 0),
    plan: String((customer && customer.plan) || "").trim(),
    priced: Number(customer && customer.price) > 0,
  };
}
