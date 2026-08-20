import { spawn } from "node:child_process";

const CF_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

export function parseCloudflareUrl(text) {
  const m = String(text || "").match(CF_URL);
  return m ? m[0] : "";
}

export function parseTailscaleIPs(text) {
  const out = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const ip = line.trim();
    if (/^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(ip)) out.push(ip);
  }
  return out;
}

function runText(cmd, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(cmd, args, { windowsHide: true }); }
    catch { return resolve(""); }
    let buf = "";
    const t = setTimeout(() => { try { child.kill(); } catch {} resolve(buf); }, timeoutMs);
    child.stdout.on("data", (d) => { buf += d.toString(); });
    child.stderr.on("data", (d) => { buf += d.toString(); });
    child.on("error", () => { clearTimeout(t); resolve(""); });
    child.on("close", () => { clearTimeout(t); resolve(buf); });
  });
}

export async function tailscaleIPv4s() {
  const text = await runText("tailscale", ["ip", "-4"]);
  return parseTailscaleIPs(text);
}

export function startCloudflareTunnel({ port, onUrl, bin = "cloudflared" }) {
  const child = spawn(bin, ["tunnel", "--url", "http://127.0.0.1:" + Number(port)], {
    windowsHide: true,
  });
  let found = "";
  const onData = (chunk) => {
    const url = parseCloudflareUrl(String(chunk));
    if (url && !found) {
      found = url;
      if (onUrl) onUrl(url);
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("error", () => {
    if (!found && onUrl) onUrl("");
  });
  return child;
}

export async function startTailscaleServe({ port }) {
  const bg = await runText("tailscale", ["serve", "--bg", String(Number(port))], 12000);
  const status = await runText("tailscale", ["serve", "status"], 8000);
  const https = String(status || bg || "").match(/https:\/\/[^\s]+/);
  return { ok: /https:\/\//i.test(status + bg) || /Success/i.test(bg), url: https ? https[0] : "", raw: (bg + "\n" + status).trim() };
}
