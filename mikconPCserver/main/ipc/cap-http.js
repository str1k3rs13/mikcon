// CapacitorHttp.request equivalent: talks to the license server from the trusted
// main process. HTTPS only (localhost http allowed for dev), host allowlisted.
import { isAllowedLicenseUrl } from "../allowlist.js";

export function registerCapHttp(ipcMain) {
  ipcMain.handle("caphttp:request", async (_e, req) => {
    const url = String(req?.url || "");
    if (!isAllowedLicenseUrl(url)) throw new Error("License server URL is not allowed");
    const method = String(req.method || "GET").toUpperCase();
    if (method !== "GET" && method !== "POST") throw new Error("License request method is not allowed");
    const res = await fetch(url, {
      method,
      redirect: "error",
      headers: { "Content-Type": "application/json" },
      body: req.data != null ? (typeof req.data === "string" ? req.data : JSON.stringify(req.data)) : undefined,
    });
    let data = await res.text();
    try { data = JSON.parse(data); } catch {}
    return { status: res.status, data };
  });
}
