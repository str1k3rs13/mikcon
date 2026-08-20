import test from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../agent/store.js";
import { addHours, canClose, makeJobStore, nextStatus, planMatches, slaHoursFor } from "../agent/job-ticket.js";

const clock = { today: () => "2026-08-20", now: () => new Date("2026-08-20T08:00:00") };

test("install walks open → survey → assigned → closed; repair skips survey", () => {
  assert.equal(nextStatus("install", "open", "survey"), "survey");
  assert.equal(nextStatus("install", "survey", "assign"), "assigned");
  assert.equal(nextStatus("repair", "open", "survey"), "open");
  assert.equal(nextStatus("repair", "open", "assign"), "assigned");
  assert.equal(nextStatus("install", "assigned", "cancel"), "cancelled");
  assert.equal(slaHoursFor("repair"), 24);
  assert.equal(slaHoursFor("install"), 48);
});

test("close requires the client on the router and matching plan", () => {
  const ticket = { status: "assigned", plan: "Fibre 20", name: "Juan" };
  assert.equal(canClose({ ticket, customer: null }).ok, false);
  assert.equal(canClose({ ticket, customer: { plan: "Home 10" } }).ok, false);
  assert.equal(canClose({ ticket, customer: { plan: "Fibre 20" } }).ok, true);
  assert.equal(planMatches("", "anything"), true);
});

test("store opens, assigns, and refuses close until the secret exists", () => {
  const db = openStore(":memory:");
  const jobs = makeJobStore({ db, clock, nowStamp: () => "2026-08-20 08:00" });
  const row = jobs.create({
    router_id: "r1", kind: "install", name: "Juan", plan: "Fibre 20",
  });
  assert.equal(row.status, "open");
  assert.match(row.due_by, /2026-08-22/);
  jobs.advance(row.id, "assign", { assigned_to: "Bong" });
  const fail = jobs.close(row.id, { customer: null });
  assert.equal(fail.ok, false);
  const ok = jobs.close(row.id, { customer: { key: "juan01", plan: "Fibre 20" }, customer_key: "juan01" });
  assert.equal(ok.ok, true);
  assert.equal(ok.row.status, "closed");
  assert.equal(ok.row.customer_key, "juan01");
  db.close();
});

test("addHours keeps local calendar", () => {
  assert.equal(addHours("2026-08-20 08:00", 24).slice(0, 10), "2026-08-21");
});
