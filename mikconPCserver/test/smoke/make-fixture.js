// Writes a safeStorage blob under the CURRENT Electron so a later Electron can prove it still
// reads. Run on the OLD Electron, before upgrading.
//
// The blob is committed, but committing does NOT make the check survive a clean checkout: the
// key is per-machine and per-OS-user (see profile-key.js). On any other machine this ciphertext
// is simply unreadable, which says nothing about Electron. So the fingerprint of the key that
// wrote it is recorded alongside, and the harness asserts only where that key still exists and
// skips elsewhere — rather than reporting a failure it cannot substantiate.
const { app, safeStorage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { profileKeyFingerprint } = require("./profile-key.js");

const PLAINTEXT = "mikcon-dpapi-fixture-v1";

// safeStorage's key lives in Local State inside app.getPath("userData"), which is derived from
// the resolved app name — so the fixture is only readable by a process running under the SAME
// name. run.mjs launches the harness as the `test/smoke` directory, which resolves to
// "mikcon-smoke" from its package.json; this file is launched as a bare path and would otherwise
// resolve to "Electron" and write a blob nothing can read. Read the name rather than repeating
// it, so the two entry points cannot drift. Must precede whenReady() — userData is resolved once,
// at startup.
app.setName(require("./package.json").name);

app.whenReady().then(() => {
  if (!safeStorage.isEncryptionAvailable()) {
    console.error("safeStorage unavailable - cannot write fixture");
    app.exit(1);
    return;
  }
  const dir = path.join(__dirname, "fixtures");
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, "dpapi-prev.bin");
  fs.writeFileSync(out, safeStorage.encryptString(PLAINTEXT));

  // Written after the blob, so the recorded fingerprint is always the key that encrypted it.
  const fingerprint = profileKeyFingerprint(app.getPath("userData"));
  if (!fingerprint) {
    console.error("could not fingerprint the profile key - refusing to write a fixture the "
      + "harness cannot judge");
    app.exit(1);
    return;
  }
  fs.writeFileSync(path.join(dir, "dpapi-prev.json"), JSON.stringify({
    plaintext: PLAINTEXT,
    electron: process.versions.electron,
    keyFingerprint: fingerprint,
  }, null, 2) + "\n");

  console.log("wrote " + out + " under electron " + process.versions.electron
    + " (profile key " + fingerprint + ")");
  app.exit(0);
});
