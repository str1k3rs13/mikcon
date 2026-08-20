// Device-bound machine id for licensing.
// Windows: MachineGuid. Linux: /etc/machine-id. Both stay put across app reinstalls
// and change on a reimage. index.html hashes it to "juanfi:hw:<id>".
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const GUID = /MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]{32,40})/;

export function parseMachineGuid(out) {
  const m = GUID.exec(String(out || ""));
  return m ? m[1] : "";
}

export function parseLinuxMachineId(text) {
  const s = String(text || "").trim().split(/\s/)[0].toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(s)) return "";
  if (/^0+$/.test(s)) return "";
  return s;
}

export function linuxMachineIdFrom(files) {
  for (const f of files || []) {
    try {
      if (!existsSync(f)) continue;
      const id = parseLinuxMachineId(readFileSync(f, "utf8"));
      if (id) return id;
    } catch {}
  }
  return "";
}

export function machineIdFromEnv(raw) {
  const hex = String(raw == null ? "" : raw).trim().toLowerCase().replace(/-/g, "");
  if (/^[0-9a-f]{32,}$/.test(hex) && !/^0+$/.test(hex.slice(0, 32))) return hex.slice(0, 32);
  return parseLinuxMachineId(raw);
}

const LINUX_ID_FILES = ["/etc/machine-id", "/var/lib/dbus/machine-id"];

export function machineId() {
  return new Promise((resolve) => {
    const envId = machineIdFromEnv(process.env.MIKCON_MACHINE_ID || process.env.BALENA_DEVICE_UUID || "");
    if (envId) return resolve({ id: envId });
    if (process.platform === "linux") return resolve({ id: linuxMachineIdFrom(LINUX_ID_FILES) });
    if (process.platform !== "win32") return resolve({ id: "" });
    // Fixed argv — no user input interpolated into the command.
    execFile("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"],
      { windowsHide: true }, (err, stdout) => resolve({ id: err ? "" : parseMachineGuid(stdout) }));
  });
}
