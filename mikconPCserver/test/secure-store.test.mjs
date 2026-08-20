import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { makeSecureStore } from "../main/secure-store.js";

// Fake encryptor: reversible, records availability. Simulates Electron safeStorage.
function fakeEncryptor(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s) => Buffer.from("enc:" + s, "utf8"),
    decryptString: (b) => b.toString("utf8").replace(/^enc:/, ""),
  };
}

// Encryptor whose decryptString ALWAYS throws — simulates a stale/undecryptable
// stored blob (e.g. safeStorage key rotated between app runs).
function undecryptableEncryptor(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s) => Buffer.from("enc:" + s, "utf8"),
    decryptString: () => { throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptString."); },
  };
}

// Drop a stored blob directly on disk at the path get() reads, so get() must decrypt it.
function seedBlob(dir, key, bytes = "v10-stale") {
  mkdirSync(path.join(dir, "secure"), { recursive: true });
  const f = path.join(dir, "secure", "v1." + key + ".bin");
  writeFileSync(f, Buffer.from(bytes));
  return f;
}

test("set then get round-trips an encrypted value", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ss-"));
  const store = makeSecureStore({ encryptor: fakeEncryptor(true), dir });
  await store.set("routers", '{"a":1}');
  const r = await store.get("routers");
  assert.equal(r.found, true);
  assert.equal(r.value, '{"a":1}');
});

test("get on a missing key returns found:false", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ss-"));
  const store = makeSecureStore({ encryptor: fakeEncryptor(true), dir });
  assert.deepEqual(await store.get("nope"), { found: false, value: "" });
});

test("set FAILS CLOSED when encryption is unavailable", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ss-"));
  const store = makeSecureStore({ encryptor: fakeEncryptor(false), dir });
  await assert.rejects(() => store.set("routers", "x"), /encryption is unavailable/i);
});

test("invalid keys are rejected", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ss-"));
  const store = makeSecureStore({ encryptor: fakeEncryptor(true), dir });
  await assert.rejects(() => store.set("bad key!", "x"), /invalid secure-storage key/i);
});

test("values over 1 MiB are rejected", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ss-"));
  const store = makeSecureStore({ encryptor: fakeEncryptor(true), dir });
  await assert.rejects(() => store.set("big", "x".repeat(1024 * 1024 + 1)), /too large/i);
});

// A stored blob that can't be decrypted (stale key, wrong encryptor, corruption) must
// not brick the app and must not delete the file. Deleting would wipe router passwords
// if the headless server and Electron app share a data dir with different key backends.
test("get() recovers from an undecryptable blob when encryption is available (no lock)", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ss-"));
  const f = seedBlob(dir, "routers");
  const store = makeSecureStore({ encryptor: undecryptableEncryptor(true), dir });
  const r = await store.get("routers");
  assert.deepEqual(r, { found: false, value: "" }); // recovered, did not throw
  assert.equal(existsSync(f), true);                // keep the blob for the correct backend
});

// But if the backend is genuinely unavailable, a decrypt failure must still surface so the
// app can lock (fail-closed) rather than silently discarding protected data.
test("get() rethrows a decrypt failure when encryption is unavailable (stays locked)", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ss-"));
  const f = seedBlob(dir, "routers");
  const store = makeSecureStore({ encryptor: undecryptableEncryptor(false), dir });
  await assert.rejects(() => store.get("routers"), /decrypting/i);
  assert.equal(existsSync(f), true); // must NOT delete data when backend is down
});
