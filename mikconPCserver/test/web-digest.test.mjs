import { test } from "node:test";
import assert from "node:assert/strict";
import { sha256, sha512, hex, installSubtleDigestPolyfill, pbkdf2Sha256 } from "../main/web-digest.js";

test("sha256 matches FIPS vectors", () => {
  assert.equal(hex(sha256(new TextEncoder().encode(""))),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(hex(sha256(new TextEncoder().encode("abc"))),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("sha512 matches FIPS vectors", () => {
  assert.equal(hex(sha512(new TextEncoder().encode("abc"))),
    "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f");
});

test("installSubtleDigestPolyfill supplies digest when subtle is missing", async () => {
  const fake = {};
  assert.equal(installSubtleDigestPolyfill(fake), true);
  const buf = await fake.subtle.digest("SHA-256", new TextEncoder().encode("abc"));
  assert.equal(hex(buf), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("pbkdf2-sha256 matches RFC 6070-style vector", () => {
  const enc = new TextEncoder();
  const out = pbkdf2Sha256(enc.encode("password"), enc.encode("salt"), 1, 32);
  assert.equal(hex(out), "120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b");
});

test("polyfill importKey+deriveBits hashes a PIN the same way as staff", async () => {
  const fake = {};
  installSubtleDigestPolyfill(fake);
  const enc = new TextEncoder();
  const key = await fake.subtle.importKey("raw", enc.encode("1234"), { name: "PBKDF2" }, false, ["deriveBits"]);
  const bits = await fake.subtle.deriveBits(
    { name: "PBKDF2", salt: enc.encode("aabbccdd"), iterations: 2, hash: "SHA-256" },
    key, 256);
  assert.equal(hex(bits).length, 64);
  assert.equal(hex(bits), hex(pbkdf2Sha256(enc.encode("1234"), enc.encode("aabbccdd"), 2, 32)));
});
