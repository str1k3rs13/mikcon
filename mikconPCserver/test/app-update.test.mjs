import { test } from "node:test";
import assert from "node:assert/strict";
import { installerArgs, validateUpdateExeUrl, windowsInstallerUrl } from "../main/app-update.js";

test("Windows update URL must be a JeffNet https exe", () => {
  assert.equal(
    validateUpdateExeUrl("https://mikcon.jeff-network.com/mikcon-pc-setup.exe?v=3.16.6"),
    "https://mikcon.jeff-network.com/mikcon-pc-setup.exe?v=3.16.6"
  );
});

test("an APK link on JeffNet is rewritten to the Windows installer", () => {
  assert.equal(
    windowsInstallerUrl("https://mikcon.jeff-network.com/mikcon.apk?v=11.22.15"),
    "https://mikcon.jeff-network.com/mikcon-pc-setup.exe"
  );
  assert.equal(
    validateUpdateExeUrl("https://mikcon.jeff-network.com/mikcon.apk?v=11.22.15"),
    "https://mikcon.jeff-network.com/mikcon-pc-setup.exe"
  );
});

test("Windows update URL rejects http and unknown hosts", () => {
  assert.throws(() => validateUpdateExeUrl("http://mikcon.jeff-network.com/mikcon-pc-setup.exe"));
  assert.throws(() => validateUpdateExeUrl("https://evil.example/MikconPC-Setup.exe"));
});

test("silent installer args include /S", () => {
  assert.deepEqual(installerArgs(), ["/S", "--updated"]);
});
