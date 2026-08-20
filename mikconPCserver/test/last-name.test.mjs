import test from "node:test";
import assert from "node:assert/strict";
import { lastNameKeys, matchesLastName, normalizeLastName, matchesFirstName, last4Phone, matchesAccount, amountDue, publicCustomerCard, serviceStatus } from "../agent/last-name.js";

test("normalizeLastName trims and rejects junk", () => {
  assert.equal(normalizeLastName("  Cruz  "), "Cruz");
  assert.equal(normalizeLastName("Dela Cruz"), "Dela Cruz");
  assert.equal(normalizeLastName("C"), "");
  assert.equal(normalizeLastName("Cruz!"), "");
  assert.equal(normalizeLastName(""), "");
});

test("lastNameKeys handles comma and Western order", () => {
  assert.deepEqual(lastNameKeys("Cruz, Ana"), ["cruz"]);
  assert.ok(lastNameKeys("Juan Dela Cruz").includes("cruz"));
  assert.ok(lastNameKeys("Juan Dela Cruz").includes("dela cruz"));
  assert.deepEqual(lastNameKeys("Ana"), ["ana"]);
});

test("matchesLastName is case-insensitive", () => {
  assert.equal(matchesLastName("Cruz, Ana", "cruz"), true);
  assert.equal(matchesLastName("Juan Dela Cruz", "CRUZ"), true);
  assert.equal(matchesLastName("Juan Dela Cruz", "dela cruz"), true);
  assert.equal(matchesLastName("Juan Dela Cruz", "Juan"), false);
  assert.equal(matchesLastName("Ben Reyes", "Cruz"), false);
});

test("first name comes from comma form or the first word", () => {
  assert.equal(matchesFirstName("Cruz, Ana", "Ana"), true);
  assert.equal(matchesFirstName("Juan Dela Cruz", "Juan"), true);
  assert.equal(matchesFirstName("Cruz, Ana", "Juan"), false);
});

test("matchesAccount needs last + first, and last 4 when a phone is on file", () => {
  const ana = { name: "Cruz, Ana", phone: "09171234567" };
  const juan = { name: "Juan Dela Cruz", phone: "" };
  assert.equal(matchesAccount(ana, { lastName: "Cruz", firstName: "Ana", phoneTail: "4567" }), true);
  assert.equal(matchesAccount(ana, { lastName: "Cruz", firstName: "Ana", phoneTail: "0000" }), false);
  assert.equal(matchesAccount(ana, { lastName: "Cruz", firstName: "Ana" }), false);
  assert.equal(matchesAccount(juan, { lastName: "Cruz", firstName: "Juan" }), true);
  assert.equal(matchesAccount(juan, { lastName: "Cruz", firstName: "Ana" }), false);
  assert.equal(last4Phone("09171234567"), "4567");
});

test("amountDue is price minus already-paid bal", () => {
  assert.equal(amountDue({ price: 750, bal: 250 }), 500);
  assert.equal(amountDue({ price: 750, bal: 0 }), 750);
  assert.equal(amountDue({ price: 750, bal: 900 }), 0);
});

test("serviceStatus reports active, due today, and expired from the due date", () => {
  assert.equal(serviceStatus({ due: "2026-09-01", today: "2026-08-19" }).kind, "ok");
  assert.equal(serviceStatus({ due: "2026-09-01", today: "2026-08-19" }).days, 13);
  assert.equal(serviceStatus({ due: "2026-08-19", today: "2026-08-19" }).kind, "due");
  assert.equal(serviceStatus({ due: "2026-08-01", today: "2026-08-19" }).kind, "over");
  assert.equal(serviceStatus({ due: "", today: "2026-08-19" }).kind, "unknown");
});

test("publicCustomerCard does not leak the router key", () => {
  const card = publicCustomerCard({
    name: "Cruz, Ana", key: "AA:BB:CC", price: 750, bal: 0, wallet: 100, due: "2026-09-01", plan: "Fibre 20",
  }, "Main site");
  assert.equal(card.name, "Cruz, Ana");
  assert.equal(card.site, "Main site");
  assert.equal(card.amountDue, 750);
  assert.equal(card.wallet, 100);
  assert.equal(card.plan, "Fibre 20");
  assert.equal(card.key, undefined);
});
