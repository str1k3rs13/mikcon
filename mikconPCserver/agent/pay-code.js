// A 4-char code from parseCallback's alphabet [2-9A-HJ-NP-Z] (32 chars, excludes 0/1/I/O because
// those are easy to mis-tap on a phone screen), bijective with the payment_request row id.
// callback_data must fit /^(ok|no):([2-9A-HJ-NP-Z]{4})$/ in agent/telegram.js — DO NOT widen that
// regex to fit a code produced here; this module fits itself to the regex, not the other way round.
//
// 4 chars = 32^4 = 1,048,576 distinct ids — ample for a WISP's lifetime of payment requests. Ids
// beyond that wrap (encodeCode takes id mod 1,048,576); this is a documented ceiling, not a bug.
// Pure: no I/O, no clock, so it is asserted against plain integers.
const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const SPACE = ALPHABET.length; // 32

export function encodeCode(id) {
  let n = Number(id);
  if (!Number.isFinite(n) || n < 0) n = 0;
  n = Math.floor(n) % (SPACE * SPACE * SPACE * SPACE);
  let s = "";
  for (let i = 0; i < 4; i++) {
    s = ALPHABET[n % SPACE] + s;
    n = Math.floor(n / SPACE);
  }
  return s;
}

export function decodeCode(code) {
  const c = String(code || "");
  if (c.length !== 4) return null;
  let n = 0;
  for (const ch of c) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) return null;
    n = n * SPACE + v;
  }
  return n;
}
