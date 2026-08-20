// RouterOS binary-API framing: length-prefixed "words", an empty word ends a
// "sentence". Pure — no sockets — so it unit-tests without a router. Ported from
// mikrotik-panel/lib/routeros-api.js (identical wire behavior).

export function encodeLength(len) {
  if (len < 0x80) return Buffer.from([len]);
  if (len < 0x4000) return Buffer.from([0x80 | (len >> 8), len & 0xff]);
  if (len < 0x200000) return Buffer.from([0xc0 | (len >> 16), (len >> 8) & 0xff, len & 0xff]);
  if (len < 0x10000000) return Buffer.from([0xe0 | (len >> 24), (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff]);
  return Buffer.from([0xf0, (len >>> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff]);
}

export function encodeSentence(words) {
  const parts = [];
  for (const w of words) {
    const b = Buffer.from(w, "utf8");
    parts.push(encodeLength(b.length), b);
  }
  parts.push(Buffer.from([0])); // empty word terminates the sentence
  return Buffer.concat(parts);
}

export function readLen(buf, pos) {
  if (pos >= buf.length) return null;
  const c = buf[pos];
  if ((c & 0x80) === 0x00) return { len: c, next: pos + 1 };
  if ((c & 0xc0) === 0x80) { if (pos + 1 >= buf.length) return null; return { len: ((c & 0x3f) << 8) | buf[pos + 1], next: pos + 2 }; }
  if ((c & 0xe0) === 0xc0) { if (pos + 2 >= buf.length) return null; return { len: ((c & 0x1f) << 16) | (buf[pos + 1] << 8) | buf[pos + 2], next: pos + 3 }; }
  if ((c & 0xf0) === 0xe0) { if (pos + 3 >= buf.length) return null; return { len: ((c & 0x0f) << 24) | (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3], next: pos + 4 }; }
  if (pos + 4 >= buf.length) return null;
  return { len: (buf[pos + 1] * 0x1000000) + (buf[pos + 2] << 16) + (buf[pos + 3] << 8) + buf[pos + 4], next: pos + 5 };
}

export function parseSentence(words) {
  const type = words[0] || "";
  const attrs = {};
  let tag = null;
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (w.startsWith(".tag=")) { tag = w.slice(5); continue; }
    if (w[0] === "=") {
      const eq = w.indexOf("=", 1);
      if (eq === -1) attrs[w.slice(1)] = "";
      else attrs[w.slice(1, eq)] = w.slice(eq + 1);
    }
  }
  return { type, attrs, tag };
}
