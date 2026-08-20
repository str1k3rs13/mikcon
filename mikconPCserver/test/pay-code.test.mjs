// Pure round-trip tests for the encodeCode/decodeCode bijection between a payment_request row id
// and the 4-char Telegram callback_data code. No I/O.
import test from "node:test";
import assert from "node:assert/strict";
import { encodeCode, decodeCode } from "../agent/pay-code.js";

test("encodeCode/decodeCode round-trip for representative ids", () => {
  for (const id of [1, 31, 32, 1000, 1048575]) {
    const code = encodeCode(id);
    assert.match(code, /^[2-9A-HJ-NP-Z]{4}$/);
    assert.equal(decodeCode(code), id);
  }
});

test("decodeCode rejects the wrong length", () => {
  assert.equal(decodeCode("ABC"), null);
  assert.equal(decodeCode("ABCDE"), null);
  assert.equal(decodeCode(""), null);
  assert.equal(decodeCode(null), null);
  assert.equal(decodeCode(undefined), null);
});

test("decodeCode rejects characters outside the alphabet", () => {
  assert.equal(decodeCode("0000"), null); // 0 excluded
  assert.equal(decodeCode("AAA1"), null); // 1 excluded
  assert.equal(decodeCode("AAAI"), null); // I excluded
  assert.equal(decodeCode("AAAO"), null); // O excluded
});

test("every encodeCode output matches parseCallback's callback_data alphabet", () => {
  for (const id of [0, 1, 5, 100, 999999, 1048575]) {
    assert.match(encodeCode(id), /^[2-9A-HJ-NP-Z]{4}$/);
  }
});

test("ids beyond the 32^4 ceiling wrap rather than throw or produce an invalid code", () => {
  assert.equal(encodeCode(1048576), encodeCode(0));
  assert.match(encodeCode(1048576), /^[2-9A-HJ-NP-Z]{4}$/);
});
