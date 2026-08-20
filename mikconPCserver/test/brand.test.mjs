import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeBrand, mergeBrand, mergeGcash } from "../main/brand.js";

test("sanitizeBrand trims and caps fields", () => {
  const b = sanitizeBrand({
    name: "  JeffNet  WISP  ",
    phone: " 0917 123 4567 ",
    address: " Purok 1 ",
    message: "Hi",
  });
  assert.equal(b.name, "JeffNet WISP");
  assert.equal(b.phone, "0917 123 4567");
  assert.equal(b.address, "Purok 1");
  assert.equal(b.logoDataUrl, "");
});

test("sanitizeBrand drops a non-image logo", () => {
  const b = sanitizeBrand({ logoDataUrl: "javascript:alert(1)" });
  assert.equal(b.logoDataUrl, "");
});

test("sanitizeBrand keeps a small png data URL", () => {
  const logo = "data:image/png;base64,aaa";
  assert.equal(sanitizeBrand({ logoDataUrl: logo }).logoDataUrl, logo);
});

test("mergeBrand keeps previous logo when next omits it", () => {
  const prev = sanitizeBrand({ name: "Old", logoDataUrl: "data:image/png;base64,aaa" });
  const next = mergeBrand(prev, { name: "New" });
  assert.equal(next.name, "New");
  assert.equal(next.logoDataUrl, "data:image/png;base64,aaa");
});

test("mergeBrand without a next object keeps previous", () => {
  const prev = { name: "JeffNet", phone: "0917", address: "Town" };
  const out = mergeBrand(prev, null);
  assert.equal(out.name, "JeffNet");
  assert.equal(out.phone, "0917");
});

test("mergeGcash keeps the QR when the save omits it", () => {
  const prev = { name: "Jeff", number: "0917", qrDataUrl: "data:image/png;base64,abc" };
  const next = mergeGcash(prev, { name: "Jeff", number: "0917", qrDataUrl: "" });
  assert.equal(next.qrDataUrl, "data:image/png;base64,abc");
  assert.equal(next.number, "0917");
});

test("mergeGcash without a next object keeps previous", () => {
  const prev = { name: "Jeff", number: "0917", qrDataUrl: "data:image/png;base64,abc" };
  const out = mergeGcash(prev, null);
  assert.equal(out.name, "Jeff");
  assert.equal(out.qrDataUrl, "data:image/png;base64,abc");
});
