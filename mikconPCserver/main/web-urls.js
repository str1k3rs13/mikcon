// Collects the URLs an operator can paste into a browser after `npm start`.
import os from "node:os";

export function isTailscaleIPv4(addr) {
  const p = String(addr || "").split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return p[0] === 100 && p[1] >= 64 && p[1] <= 127;
}

export function lanIPv4s(ifaces = os.networkInterfaces()) {
  const out = [];
  const seen = new Set();
  for (const list of Object.values(ifaces || {})) {
    for (const a of list || []) {
      const family = a.family === 4 || a.family === "IPv4";
      if (!family || a.internal) continue;
      const addr = String(a.address || "");
      if (!addr || seen.has(addr)) continue;
      seen.add(addr);
      out.push(addr);
    }
  }
  return out;
}

export function listenUrls({ port, extra = [] } = {}, ifaces) {
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error("invalid port");
  const urls = ["http://127.0.0.1:" + p];
  const lan = [];
  const tailscale = [];
  for (const addr of lanIPv4s(ifaces)) {
    const url = "http://" + addr + ":" + p;
    if (isTailscaleIPv4(addr)) tailscale.push(url);
    else lan.push(url);
  }
  urls.push(...lan, ...tailscale);
  for (const u of extra) {
    const s = String(u || "").trim();
    if (s && !urls.includes(s)) urls.push(s);
  }
  return { port: p, local: "http://127.0.0.1:" + p, lan, tailscale, all: urls };
}

export function formatListenBanner(info, { password, firstLogin, tunnelNote } = {}) {
  const lines = [
    "",
    "  MikconPC Server is running. Open a browser:",
    "",
    "    Local      " + info.local,
  ];
  if (info.lan.length) {
    for (const u of info.lan) lines.push("    LAN        " + u);
  } else {
    lines.push("    LAN        (no other IPv4 yet)");
  }
  if (info.tailscale.length) {
    for (const u of info.tailscale) lines.push("    Tailscale  " + u);
  }
  const extras = (info.all || []).filter((u) => u !== info.local && !info.lan.includes(u) && !info.tailscale.includes(u));
  for (const u of extras) lines.push("    Tunnel     " + u);
  lines.push("");
  lines.push("    Port       " + info.port);
  lines.push("    Client pay " + info.local + "/payment");
  if (info.lan.length) lines.push("               " + info.lan[0] + "/payment");
  if (firstLogin) {
    lines.push("");
    lines.push("    First login  1234");
    lines.push("    Then set a new password in the browser (confirm and save).");
  } else if (password) {
    lines.push("");
    lines.push("    Login password (save this, shown once):  " + password);
  }
  if (tunnelNote) {
    lines.push("");
    lines.push("    " + tunnelNote);
  }
  lines.push("");
  return lines.join("\n");
}
