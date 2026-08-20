// Identifies the key that safeStorage is encrypting with, so the cross-version fixture check
// can tell "this blob is unreadable" (a real regression) from "this blob was never mine to
// read" (a different machine, which proves nothing either way).
//
// safeStorage on Windows is NOT bare DPAPI, which is what the name dpapi-prev.bin suggests.
// Chromium's OSCrypt generates a random AES key, stores it DPAPI-wrapped in this app profile's
// `Local State` under os_crypt.encrypted_key, and encrypts each value as
// "v10" + 12-byte nonce + AES-GCM ciphertext + 16-byte tag. The byte counts confirm it: the
// 54-byte fixture is 3 + 12 + 23 + 16 for its 23-character plaintext.
//
// The consequence is that a committed ciphertext is readable ONLY by a process running under
// the same app profile on the same OS user. It cannot be portable across machines, and no
// amount of committing it makes it so.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// A short, non-secret fingerprint. The input is already DPAPI-wrapped ciphertext and this
// hashes it again, so the recorded value discloses nothing usable — it only answers
// "same key or not".
function profileKeyFingerprint(userDataDir) {
  const f = path.join(userDataDir, "Local State");
  // On a profile that has never been written, Chromium has not flushed Local State yet, so
  // there is nothing to fingerprint. Callers treat null as "cannot apply", not as failure.
  if (!fs.existsSync(f)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(f, "utf8"));
    // Absent on macOS/Linux, where OSCrypt uses Keychain/libsecret rather than a key file.
    // A fixture is equally non-portable there; null again means "cannot apply".
    const key = parsed && parsed.os_crypt && parsed.os_crypt.encrypted_key;
    if (!key) return null;
    return crypto.createHash("sha256").update(String(key)).digest("hex").slice(0, 16);
  } catch {
    return null;
  }
}

module.exports = { profileKeyFingerprint };
