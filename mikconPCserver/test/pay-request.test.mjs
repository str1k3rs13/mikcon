import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSubmission, resolveCustomer, dedupeKey } from "../agent/pay-request.js";

test("valid submission normalizes", () => {
  const r = normalizeSubmission({ account: "  Juan Dela Cruz ", ref: "GC-12AB34", amount: "1299.5" });
  assert.deepEqual(r, { ok: true, request: { account: "Juan Dela Cruz", ref: "GC-12AB34", amount: 1299.5 } });
});
test("bad ref, amount, empty account are refused with a message", () => {
  assert.equal(normalizeSubmission({ account: "J", ref: "!!", amount: "10" }).ok, false);
  assert.equal(normalizeSubmission({ account: "", ref: "ABCD", amount: "10" }).ok, false);
  assert.equal(normalizeSubmission({ account: "J", ref: "ABCD", amount: "0" }).ok, false);
  assert.equal(normalizeSubmission({ account: "J", ref: "ABCD", amount: "200000" }).ok, false);
});
test("resolveCustomer matches on name or key, case-insensitively", () => {
  const customers = [{ key: "juan01", name: "Juan Dela Cruz" }, { key: "ana", name: "Ana" }];
  assert.equal(resolveCustomer({ account: "juan dela cruz" }, customers).customer.key, "juan01");
  assert.equal(resolveCustomer({ account: "JUAN01" }, customers).customer.key, "juan01");
  assert.equal(resolveCustomer({ account: "nobody" }, customers).matched, false);
});
test("dedupeKey combines router and ref", () => {
  assert.equal(dedupeKey("r1", "ABCD"), "r1|ABCD");
});
