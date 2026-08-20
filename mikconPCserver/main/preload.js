// Injects the Capacitor bridge the web UI expects. Only ipcRenderer.invoke crosses
// the boundary — no Node primitives are exposed to the page.
const { contextBridge, ipcRenderer } = require("electron");

const RouterApi = {
  exec: (o) => ipcRenderer.invoke("routerapi:exec", o),
  discover: (o) => ipcRenderer.invoke("routerapi:discover", o),
};
const AppTools = {
  secureGet: (o) => ipcRenderer.invoke("apptools:secureGet", o),
  secureSet: (o) => ipcRenderer.invoke("apptools:secureSet", o),
  secureRemove: (o) => ipcRenderer.invoke("apptools:secureRemove", o),
  machineId: () => ipcRenderer.invoke("apptools:machineId"),
  setMenuPanels: (o) => ipcRenderer.invoke("apptools:setMenuPanels", o),
  openHtml: (o) => ipcRenderer.invoke("apptools:openHtml", o),
  openUrl: (o) => ipcRenderer.invoke("apptools:openUrl", o),
  dial: (o) => ipcRenderer.invoke("apptools:dial", o),
  share: (o) => ipcRenderer.invoke("apptools:share", o),
  installUpdate: (o) => ipcRenderer.invoke("apptools:installUpdate", o),
  onUpdateProgress: (fn) => { ipcRenderer.on("apptools:updateProgress", (_e, p) => fn(p)); },
};
const CapacitorHttp = { request: (o) => ipcRenderer.invoke("caphttp:request", o) };
// The GCash payment-reminder pane. getConfig() never returns the raw Telegram token — only
// telegram.hasToken — the token stays server-side in DPAPI and crosses the bridge only as a write
// (setConfig's telegram.token), never as a read.
const PayReminder = {
  getConfig: () => ipcRenderer.invoke("payreminder:getConfig"),
  setConfig: (o) => ipcRenderer.invoke("payreminder:setConfig", o),
  listPending: () => ipcRenderer.invoke("payreminder:listPending"),
  decide: (o) => ipcRenderer.invoke("payreminder:decide", o),
};

contextBridge.exposeInMainWorld("Capacitor", {
  isNativePlatform: () => true,
  getPlatform: () => "electron",
  Plugins: { RouterApi, AppTools, CapacitorHttp, PayReminder },
});
