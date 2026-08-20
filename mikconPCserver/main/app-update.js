// Download a trusted Windows installer and launch it silently, then quit so NSIS can replace files.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import https from "node:https";
import path from "node:path";
import { isAllowedExternal } from "./allowlist.js";

export function windowsInstallerUrl(raw) {
  const fallback = "https://mikcon.jeff-network.com/mikcon-pc-setup.exe";
  let u;
  try { u = new URL(String(raw || fallback)); } catch { return fallback; }
  if (/\.apk$/i.test(u.pathname) || !/\.exe$/i.test(u.pathname)) {
    u.pathname = "/mikcon-pc-setup.exe";
    u.search = "";
  }
  return u.origin + u.pathname + u.search;
}

export function validateUpdateExeUrl(raw) {
  const href = windowsInstallerUrl(raw);
  if (!isAllowedExternal(href)) throw new Error("Only approved HTTPS update links can be opened");
  let u;
  try { u = new URL(href); } catch { throw new Error("Only approved HTTPS update links can be opened"); }
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (host !== "mikcon.jeff-network.com" && host !== "miklic.jeff-network.com") {
    throw new Error("Only approved HTTPS update links can be opened");
  }
  if (!/\.exe$/i.test(u.pathname)) throw new Error("Update file must be a Windows installer");
  return u.href;
}

export function installerArgs() {
  // electron-builder NSIS understands /S. --updated tells the next launch this was an in-app update.
  return ["/S", "--updated"];
}

export function downloadHttps(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "MikconPC-updater" } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error("update download failed (" + res.statusCode + ")"));
        return;
      }
      const total = Number(res.headers["content-length"] || 0);
      let got = 0;
      const out = createWriteStream(dest);
      res.on("data", (chunk) => {
        got += chunk.length;
        if (onProgress) onProgress({ received: got, total, percent: total ? Math.floor(got * 100 / total) : 0 });
      });
      res.pipe(out);
      out.on("finish", () => out.close((err) => err ? reject(err) : resolve({ bytes: got })));
      out.on("error", reject);
    });
    req.setTimeout(120000, () => { req.destroy(); reject(new Error("update download timed out")); });
    req.on("error", reject);
  });
}

export async function installWindowsUpdate({ url, destDir, spawnFn = spawn, quit, onProgress }) {
  const href = validateUpdateExeUrl(url);
  const dest = path.join(destDir, "MikconPC-Setup.exe");
  try { await unlink(dest); } catch {}
  await downloadHttps(href, dest, onProgress);
  const child = spawnFn(dest, installerArgs(), { detached: true, stdio: "ignore" });
  if (child && child.unref) child.unref();
  if (typeof quit === "function") setTimeout(() => quit(), 400);
  return { started: true, dest };
}
