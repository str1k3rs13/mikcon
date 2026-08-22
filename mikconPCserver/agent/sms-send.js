// PC SMS gateway: Semaphore (https://api.semaphore.co) or a USB GSM dongle (AT on a COM port).
// Zero extra packages. Secrets stay out of the public view the browser reads.
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const SEMAPHORE_URL = "https://api.semaphore.co/api/v4/messages";
const MSG_MAX = 1600;

export const DEFAULT_SMS = {
  via: "none",
  semaphore: { apikey: "", sendername: "" },
  dongle: { port: "", baud: 115200, pin: "" },
};

export function normalizeVia(v) {
  const s = String(v || "").trim().toLowerCase();
  if (s === "semaphore" || s === "dongle") return s;
  return "none";
}

export function toLocal09(raw) {
  const d = String(raw == null ? "" : raw).replace(/[^0-9+]/g, "");
  if (/^\+639\d{9}$/.test(d)) return "0" + d.slice(3);
  if (/^639\d{9}$/.test(d)) return "0" + d.slice(2);
  if (/^09\d{9}$/.test(d)) return d;
  return "";
}

export function toE164(raw) {
  const n = toLocal09(raw);
  return n ? "+63" + n.slice(1) : "";
}

function pickSecret(incoming, existing) {
  if (incoming == null || String(incoming) === "") return existing || "";
  return String(incoming);
}

export function mergeSmsConfig(prev, patch) {
  const p = prev && typeof prev === "object" ? prev : DEFAULT_SMS;
  const n = patch && typeof patch === "object" ? patch : {};
  const baudRaw = n.dongle && n.dongle.baud != null ? n.dongle.baud : (p.dongle && p.dongle.baud);
  let baud = Number(baudRaw);
  if (!Number.isFinite(baud) || baud < 1200 || baud > 230400) baud = 115200;
  baud = Math.round(baud);
  const sender = String(
    n.semaphore && n.semaphore.sendername != null
      ? n.semaphore.sendername
      : (p.semaphore && p.semaphore.sendername) || ""
  ).trim().slice(0, 11);
  const pinIn = n.dongle && n.dongle.pin;
  const pin = pickSecret(pinIn, p.dongle && p.dongle.pin).replace(/\D/g, "").slice(0, 8);
  return {
    via: normalizeVia(n.via != null ? n.via : p.via),
    semaphore: {
      apikey: pickSecret(n.semaphore && n.semaphore.apikey, p.semaphore && p.semaphore.apikey).trim().slice(0, 128),
      sendername: sender,
    },
    dongle: {
      port: String(
        n.dongle && n.dongle.port != null ? n.dongle.port : (p.dongle && p.dongle.port) || ""
      ).trim().slice(0, 32),
      baud,
      pin,
    },
  };
}

export function canSendSms(cfg) {
  const c = cfg || DEFAULT_SMS;
  if (c.via === "semaphore") return !!(c.semaphore && c.semaphore.apikey);
  if (c.via === "dongle") return !!(c.dongle && c.dongle.port);
  return false;
}

export function publicSmsConfig(cfg) {
  const c = mergeSmsConfig(DEFAULT_SMS, cfg || {});
  const ready = canSendSms(c);
  const sims = [];
  if (c.via === "semaphore" && ready) sims.push({ id: "semaphore", label: "Semaphore" });
  if (c.via === "dongle" && ready) {
    sims.push({ id: c.dongle.port, label: "USB dongle " + c.dongle.port });
  }
  return {
    via: c.via,
    canSend: ready,
    hasPermission: ready,
    sims,
    semaphore: {
      hasKey: !!(c.semaphore && c.semaphore.apikey),
      sendername: (c.semaphore && c.semaphore.sendername) || "",
    },
    dongle: {
      port: (c.dongle && c.dongle.port) || "",
      baud: (c.dongle && c.dongle.baud) || 115200,
      hasPin: !!(c.dongle && c.dongle.pin),
    },
    carrier: c.via === "semaphore" ? "Semaphore" : (c.via === "dongle" ? ("USB dongle " + ((c.dongle && c.dongle.port) || "")) : ""),
    signal: ready ? 4 : 0,
    inService: ready,
  };
}

export function assertPort(port, platform = process.platform) {
  const p = String(port || "").trim();
  if (platform === "win32") {
    if (!/^COM\d{1,3}$/i.test(p)) throw new Error("USB dongle port must look like COM3");
    return p.toUpperCase();
  }
  if (!/^\/dev\/tty(USB|ACM|S)\d+$/.test(p)) {
    throw new Error("USB dongle port must be /dev/ttyUSB0, /dev/ttyACM0 or /dev/ttyS0");
  }
  return p;
}

export function listSerialPorts({ execFileFn = execFile, platform = process.platform } = {}) {
  return new Promise((resolve) => {
    if (platform === "win32") {
      execFileFn(
        "powershell.exe",
        ["-NoProfile", "-Command", "[System.IO.Ports.SerialPort]::GetPortNames() | ForEach-Object { $_ }"],
        { timeout: 8000, windowsHide: true },
        (err, stdout) => {
          if (err) return resolve([]);
          const ports = String(stdout || "")
            .split(/\r?\n/)
            .map((s) => s.trim().toUpperCase())
            .filter((s) => /^COM\d+$/.test(s));
          const uniq = [...new Set(ports)].sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)));
          resolve(uniq.map((id) => ({ id, label: id })));
        }
      );
      return;
    }
    execFileFn("sh", ["-c", "ls -1 /dev/ttyUSB* /dev/ttyACM* /dev/ttyS* 2>/dev/null"], { timeout: 4000 }, (err, stdout) => {
      if (err && !stdout) return resolve([]);
      const ports = String(stdout || "")
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => /^\/dev\/tty(USB|ACM|S)\d+$/.test(s));
      resolve([...new Set(ports)].map((id) => ({ id, label: id })));
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function wrapSerialHandle(fh) {
  let acc = "";
  return {
    async write(s) {
      await fh.write(Buffer.from(String(s), "utf8"));
    },
    async readUntil(pred, ms) {
      const t0 = Date.now();
      const cap = Number(ms) || 5000;
      while (Date.now() - t0 < cap) {
        const buf = Buffer.alloc(512);
        try {
          const { bytesRead } = await Promise.race([
            fh.read(buf, 0, 512, null),
            sleep(180).then(() => ({ bytesRead: 0 })),
          ]);
          if (bytesRead) acc += buf.slice(0, bytesRead).toString("utf8");
        } catch {
          await sleep(40);
        }
        if (pred(acc)) {
          const out = acc;
          acc = "";
          return out;
        }
      }
      throw new Error("USB dongle timed out");
    },
    async close() {
      await fh.close();
    },
  };
}

export async function openNodeSerial({
  port,
  baud,
  platform = process.platform,
  fsMod = fs,
  execFileFn = execFileP,
} = {}) {
  const p = assertPort(port, platform);
  const rate = Number(baud) || 115200;
  if (platform === "win32") {
    try {
      await execFileFn("mode.com", [p + ":", "BAUD=" + rate, "PARITY=N", "DATA=8", "STOP=1"], { windowsHide: true });
    } catch {
      try {
        await execFileFn("mode", [p + ":", "BAUD=" + rate, "PARITY=N", "DATA=8", "STOP=1"], { windowsHide: true });
      } catch {
        throw new Error("Could not open " + p + ". Plug in the USB GSM dongle and pick its AT port.");
      }
    }
    const fh = await fsMod.open("\\\\.\\" + p, "r+");
    return wrapSerialHandle(fh);
  }
  try {
    await execFileFn("stty", ["-F", p, String(rate), "cs8", "-cstopb", "-parenb", "raw", "-echo"]);
  } catch {
    /* stty is best-effort; the open still has to work */
  }
  const fh = await fsMod.open(p, "r+");
  return wrapSerialHandle(fh);
}

async function atOk(serial, cmd, ms) {
  await serial.write(cmd + "\r");
  const out = await serial.readUntil((s) => /OK|ERROR|\+CME ERROR/i.test(s), ms || 4000);
  if (/ERROR/i.test(out)) throw new Error("USB dongle: " + cmd + " failed");
  return out;
}

export async function sendSemaphore({
  apikey,
  sendername,
  number,
  message,
  fetchFn = fetch,
  endpoint = SEMAPHORE_URL,
} = {}) {
  if (!apikey) throw new Error("Semaphore API key is not set");
  const n = toLocal09(number);
  if (!n) throw new Error("Not a Philippine mobile number");
  const text = String(message == null ? "" : message);
  if (!text.trim()) throw new Error("Message is empty");
  if (text.length > MSG_MAX) throw new Error("Message is too long");
  const payload = { apikey, number: n, message: text };
  const sender = String(sendername || "").trim();
  if (sender) payload.sendername = sender.slice(0, 11);
  const res = await fetchFn(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const raw = await res.text();
  let json = null;
  try { json = JSON.parse(raw); } catch { /* Semaphore sometimes returns a string */ }
  if (!res.ok) {
    const msg = (json && (json.message || json.app || json.error)) || ("Semaphore HTTP " + res.status);
    throw new Error(String(msg));
  }
  if (json && json.message && !Array.isArray(json) && /invalid|error|fail/i.test(String(json.message))) {
    throw new Error(String(json.message));
  }
  if (Array.isArray(json) && json[0] && /fail|error|rejected/i.test(String(json[0].status || ""))) {
    throw new Error(String(json[0].network || json[0].status || "Semaphore rejected the message"));
  }
  return { ok: true, result: json };
}

export async function sendDongle({
  port,
  baud,
  pin,
  number,
  message,
  openSerial = openNodeSerial,
} = {}) {
  const e164 = toE164(number);
  if (!e164) throw new Error("Not a Philippine mobile number");
  const text = String(message == null ? "" : message);
  if (!text.trim()) throw new Error("Message is empty");
  if (text.length > MSG_MAX) throw new Error("Message is too long");
  if (/[\x00-\x09\x0b\x0c\x0e-\x1f]/.test(text)) throw new Error("Message has binary characters the dongle cannot send");
  const serial = await openSerial({ port, baud });
  try {
    await atOk(serial, "AT");
    const p = String(pin || "").replace(/\D/g, "");
    if (p) await atOk(serial, 'AT+CPIN="' + p + '"', 8000);
    await atOk(serial, "AT+CMGF=1");
    await serial.write('AT+CMGS="' + e164 + '"\r');
    const prompt = await serial.readUntil((s) => s.includes(">") || /ERROR/i.test(s), 12000);
    if (/ERROR/i.test(prompt) || !prompt.includes(">")) {
      throw new Error("USB dongle did not accept the number");
    }
    await serial.write(text + "\x1A");
    const done = await serial.readUntil((s) => /OK|ERROR|\+CMGS:|\+CMS ERROR/i.test(s), 45000);
    if (/ERROR/i.test(done)) throw new Error("USB dongle rejected the message");
    return { ok: true };
  } finally {
    try { await serial.close(); } catch { /* already closed */ }
  }
}

export async function sendSms(cfg, { number, body, fetchFn, openSerial } = {}) {
  const c = cfg || DEFAULT_SMS;
  if (!canSendSms(c)) throw new Error("Set Semaphore or a USB GSM dongle in Settings → SMS.");
  if (c.via === "semaphore") {
    return sendSemaphore({
      apikey: c.semaphore.apikey,
      sendername: c.semaphore.sendername,
      number,
      message: body,
      fetchFn,
    });
  }
  return sendDongle({
    port: c.dongle.port,
    baud: c.dongle.baud,
    pin: c.dongle.pin,
    number,
    message: body,
    openSerial,
  });
}
