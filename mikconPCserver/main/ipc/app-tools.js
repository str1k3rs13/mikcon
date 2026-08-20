// AppTools.* handlers: secure storage, machine id, print (openHtml), external links, dial, share.
import { canOpenExternally, isAllowedExternal } from "../allowlist.js";
import { installWindowsUpdate } from "../app-update.js";
import { machineId } from "../machine-id.js";

export function registerAppTools({ ipcMain, app, shell, store, openPrintWindow }) {
  ipcMain.handle("apptools:secureGet", (_e, { key }) => store.get(key));
  ipcMain.handle("apptools:secureSet", (_e, { key, value }) => store.set(key, value).then(() => ({})));
  ipcMain.handle("apptools:secureRemove", (_e, { key }) => store.remove(key).then(() => ({})));
  ipcMain.handle("apptools:machineId", () => machineId());

  // Print: render the voucher HTML in a hidden window; its own window.print() opens
  // the Windows print dialog (printer or Microsoft Print to PDF). No browser hop.
  ipcMain.handle("apptools:openHtml", (_e, { html, filename }) => openPrintWindow(String(html || ""), String(filename || "print.html")));

  ipcMain.handle("apptools:openUrl", async (_e, { url }) => {
    if (!isAllowedExternal(url)) throw new Error("Only approved HTTPS checkout/update links can be opened");
    await shell.openExternal(String(url));
    return {};
  });
  ipcMain.handle("apptools:dial", async (_e, { number }) => {
    const n = String(number || "").replace(/[^0-9+]/g, "");
    const tel = "tel:" + n;
    if (!canOpenExternally(tel)) throw new Error("invalid phone number");
    await shell.openExternal(tel);
    return {};
  });
  // No Windows share sheet: reject so index.html's clipboard fallback runs.
  ipcMain.handle("apptools:share", () => { throw new Error("share unavailable on desktop"); });

  ipcMain.handle("apptools:installUpdate", async (e, { url }) => {
    const wc = e.sender;
    return installWindowsUpdate({
      url,
      destDir: app.getPath("temp"),
      quit: () => app.quit(),
      onProgress: (p) => { if (!wc.isDestroyed()) wc.send("apptools:updateProgress", p); },
    });
  });
}
