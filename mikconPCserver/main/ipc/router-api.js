// RouterApi.* handlers + the single registerIpc() entry the main process calls.
import { exec } from "../routeros.js";
import { discover } from "../mndp.js";
import { registerAppTools } from "./app-tools.js";
import { registerCapHttp } from "./cap-http.js";

export function registerIpc({ ipcMain, app, shell, store, openPrintWindow }) {
  ipcMain.handle("routerapi:exec", async (_e, args) => {
    try { return { ok: true, data: await exec(args || {}) }; }
    catch (e) { return { ok: false, error: e.message || String(e) }; }
  });
  ipcMain.handle("routerapi:discover", (_e, args) => discover(args || {}));
  registerAppTools({ ipcMain, app, shell, store, openPrintWindow });
  registerCapHttp(ipcMain);
}
