import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseMachineGuid, parseLinuxMachineId, linuxMachineIdFrom, machineId } from "../main/machine-id.js";

test("parseMachineGuid extracts the GUID from reg output", () => {
  const out = [
    "",
    "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography",
    "    MachineGuid    REG_SZ    a8f5c2e1-1234-4abc-9def-0123456789ab",
    "",
  ].join("\r\n");
  assert.equal(parseMachineGuid(out), "a8f5c2e1-1234-4abc-9def-0123456789ab");
});

test("parseMachineGuid returns empty on garbage", () => {
  assert.equal(parseMachineGuid("no guid here"), "");
});

test("machineId resolves to a string id on this platform", async () => {
  const r = await machineId();
  assert.equal(typeof r.id, "string");            // Windows GUID, Linux 32-hex, else "" — never throws
  if (process.platform === "win32" || process.platform === "linux") {
    assert.ok(r.id.length > 0, "this OS must return a hardware id, got empty");
  }
});

test("parseLinuxMachineId accepts a 32-hex machine-id and rejects junk", () => {
  assert.equal(parseLinuxMachineId("a1b2c3d4e5f60718293a4b5c6d7e8f90\n"), "a1b2c3d4e5f60718293a4b5c6d7e8f90");
  assert.equal(parseLinuxMachineId("A1B2C3D4E5F60718293A4B5C6D7E8F90"), "a1b2c3d4e5f60718293a4b5c6d7e8f90");
  assert.equal(parseLinuxMachineId("not-a-machine-id"), "");
  assert.equal(parseLinuxMachineId(""), "");
  assert.equal(parseLinuxMachineId("00000000000000000000000000000000"), "");
});

test("linuxMachineIdFrom uses the first readable 32-hex file", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mikcon-mid-"));
  const good = path.join(dir, "machine-id");
  writeFileSync(good, "0123456789abcdef0123456789abcdef\n");
  assert.equal(linuxMachineIdFrom([path.join(dir, "missing"), good]), "0123456789abcdef0123456789abcdef");
  assert.equal(linuxMachineIdFrom([path.join(dir, "missing")]), "");
});
