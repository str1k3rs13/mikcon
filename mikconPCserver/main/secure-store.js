// Encrypted key/value store for MikconPC. Uses Electron safeStorage (Windows DPAPI,
// per-user) via an injected encryptor so the logic unit-tests without Electron.
// NOTE (accepted risk, see audit F3/spec): DPAPI is per-USER, weaker than Android
// Keystore's per-APP isolation. Documented in README. set() fails closed.
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import path from "node:path";

const MAX = 1024 * 1024;
function validateKey(key) {
  if (!key || !/^[A-Za-z0-9._-]{1,64}$/.test(key)) throw new Error("invalid secure-storage key");
}

export function makeSecureStore({ encryptor, dir }) {
  const file = (key) => path.join(dir, "secure", "v1." + key + ".bin");
  return {
    async get(key) {
      validateKey(key);
      const f = file(key);
      if (!existsSync(f)) return { found: false, value: "" };
      try {
        return { found: true, value: encryptor.decryptString(readFileSync(f)) };
      } catch (e) {
        // If the backend is genuinely unavailable, surface it so the caller can fail
        // closed (lock to protect credentials) — never silently drop protected data.
        if (!encryptor.isEncryptionAvailable()) throw e;
        // Backend IS available but this blob will not decrypt. Do not delete it — a
        // wrong encryptor (file key vs DPAPI) or a one-off read error would wipe
        // router passwords and the license. Report not-found and leave the file.
        return { found: false, value: "" };
      }
    },
    async set(key, value) {
      validateKey(key);
      const v = value == null ? "" : String(value);
      if (v.length > MAX) throw new Error("secure value is too large");
      if (!encryptor.isEncryptionAvailable()) throw new Error("secure storage encryption is unavailable");
      mkdirSync(path.join(dir, "secure"), { recursive: true });
      writeFileSync(file(key), encryptor.encryptString(v));
    },
    async remove(key) {
      validateKey(key);
      try { rmSync(file(key), { force: true }); } catch {}
    },
  };
}
