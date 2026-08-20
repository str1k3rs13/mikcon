import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeLength, encodeSentence, readLen, parseSentence } from "../main/routeros-framing.js";

test("encodeLength covers all five width boundaries", () => {
  assert.deepEqual([...encodeLength(0x00)], [0x00]);
  assert.deepEqual([...encodeLength(0x7f)], [0x7f]);
  assert.deepEqual([...encodeLength(0x80)], [0x80, 0x80]);
  assert.deepEqual([...encodeLength(0x3fff)], [0xbf, 0xff]);
  assert.deepEqual([...encodeLength(0x4000)], [0xc0, 0x40, 0x00]);
  assert.equal(encodeLength(0x200000)[0] & 0xf0, 0xe0);
  assert.equal(encodeLength(0x10000000)[0], 0xf0);
});

test("a sentence round-trips through encode + readLen", () => {
  const buf = encodeSentence(["/login", "=name=admin"]);
  const words = [];
  let pos = 0;
  while (true) {
    const L = readLen(buf, pos);
    assert.ok(L);
    if (L.len === 0) { pos = L.next; break; }
    words.push(buf.subarray(L.next, L.next + L.len).toString("utf8"));
    pos = L.next + L.len;
  }
  assert.deepEqual(words, ["/login", "=name=admin"]);
});

test("parseSentence extracts type, attrs, and tag", () => {
  const p = parseSentence(["!re", "=name=v-01", "=profile=1hr", ".tag=7"]);
  assert.equal(p.type, "!re");
  assert.equal(p.attrs.name, "v-01");
  assert.equal(p.attrs.profile, "1hr");
  assert.equal(p.tag, "7");
});
