import { app, BrowserWindow, ipcMain, shell, safeStorage, session, screen, Menu, Tray, nativeImage } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeSecureStore } from "./secure-store.js";
import { registerIpc } from "./ipc/router-api.js";
import { readState, writeState, validateBounds, DEFAULT_BOUNDS } from "./window-state.js";
import { buildMenuTemplate } from "./menu.js";
import { nextZoomFactor, clampZoomFactor } from "./zoom.js";
import { startAgentHost, registerPayReminderIpc } from "./agent-host.js";
import { exec } from "./routeros.js";
import { attachCloseToTray } from "./lifecycle.js";
import { buildTrayMenu, trayStatusLine } from "./tray-menu.js";
import { autostartPolicy, startsHidden } from "./autostart.js";
import { shouldShowHideBalloon, markHideBalloonShown } from "./shell-state.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.join(here, "..", "app", "www", "index.html");
// A packaged runtime asset. build/icon.png is buildResources and does NOT exist at runtime.
const TRAY_ICON = path.join(here, "assets", "tray.png");

let agentHost = null;
let mainWindow = null;
let tray = null;
// Flipped by before-quit. A GETTER of this is what lifecycle.js consults, never the value.
let isQuitting = false;
// Applied on the first show() instead of at construction: win.maximize() also SHOWS a hidden
// window, which would defeat --hidden for anyone whose last session was maximized.
let pendingMaximize = false;
let agentState = { locked: false, lastSyncAt: null, unreachable: 0 };

// Render voucher HTML in a hidden window; its own window.print() (in the page) opens
// the Windows print dialog. Written to the app temp dir, deleted when the window closes.
async function openPrintWindow(html, filename) {
  const { writeFile, rm, mkdir } = await import("node:fs/promises");
  const safeName = /^[A-Za-z0-9._-]+$/.test(filename) ? filename : "print.html";
  const dir = path.join(app.getPath("temp"), "mikcon");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, safeName);
  await writeFile(file, html, "utf8");
  const win = new BrowserWindow({ width: 720, height: 900, show: true, webPreferences: { sandbox: true, contextIsolation: true } });
  win.removeMenu();
  win.on("closed", () => { rm(file, { force: true }).catch(() => {}); });
  await win.loadFile(file);
  return {};
}

// An accelerator reaches the app even when the licence gate is covering it — unlike the on-screen
// tabs, which the overlay makes unclickable. So navigation asks the page first. gateLocked() shows
// the gate by REMOVING .hide, so the gate still carrying .hide means unlocked; test/menu.test.mjs
// pins that contract against the shared UI.
async function isUnlocked(win) {
  try {
    return await win.webContents.executeJavaScript('!!document.querySelector("#license-gate.hide")');
  } catch { return false; }
}

// Finds the visible search box without hardcoding any view's internals: all six search inputs end
// in -search, and offsetParent is null for a hidden one — which is what distinguishes pp-search
// from ip-search when one of the two Clients panes is hidden.
const FOCUS_SEARCH = `(function(){
  var el = Array.prototype.slice.call(document.querySelectorAll('input[id$="-search"]'))
    .filter(function(e){ return e.offsetParent !== null; })[0];
  if (el) { el.focus(); el.select(); }
  return !!el;
})()`;

function makeDispatch(win) {
  return async (action) => {
    if (win.isDestroyed()) return;
    const wc = win.webContents;
    if (action.type === "reload") { wc.reload(); return; }
    if (action.type === "zoom") {
      wc.setZoomFactor(nextZoomFactor(wc.getZoomFactor(), action.dir, win.getContentSize()[0]));
      return;
    }
    if (!(await isUnlocked(win))) return;
    if (action.type === "go") {
      // No permission check here on purpose. go() refuses a panel the session may not open, and
      // every route in — tab, accelerator, menu item — ends up calling it. A guard here would ask
      // the page the same question go() asks itself, one round trip earlier, and was verified to
      // change nothing when removed. The greying below is what the operator actually sees.
      await wc.executeJavaScript("go(" + JSON.stringify(action.view) + ")").catch(() => {});
    } else if (action.type === "find") {
      await wc.executeJavaScript(FOCUS_SEARCH).catch(() => {});
    }
  };
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (pendingMaximize) { pendingMaximize = false; mainWindow.maximize(); }
  // show(), not just focus(): after this stage the window is usually hidden, and double-clicking
  // the desktop icon is the operator's main way back.
  mainWindow.show();
  mainWindow.focus();
}

function setAutostart(enabled) {
  const policy = autostartPolicy({ packaged: app.isPackaged, enabled, execPath: process.execPath });
  if (policy) app.setLoginItemSettings(policy);
  refreshTray();
}

function refreshTray() {
  if (!tray) return;
  const packaged = app.isPackaged;
  const state = {
    ...agentState,
    autostart: { supported: packaged, enabled: packaged && app.getLoginItemSettings().openAtLogin },
  };
  tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenu({
    state,
    actions: {
      open: showWindow,
      quit: () => { isQuitting = true; app.quit(); },
      toggleAutostart: setAutostart,
    },
  })));
  // The tooltip repeats the status line, so hovering answers the question without a right-click.
  tray.setToolTip("MikconPC Server — " + trayStatusLine(state));
}

// The first close is the one that could be mistaken for a crash. Once only, per install.
function onWindowHidden() {
  if (!tray) return;
  const dir = app.getPath("userData");
  if (!shouldShowHideBalloon(dir)) return;
  markHideBalloonShown(dir);
  try {
    tray.displayBalloon({
      title: "MikconPC Server is still running",
      content: "It keeps working in the background. Use this icon to open it again, or to quit.",
    });
  } catch { /* balloons are unavailable on some Windows configurations */ }
}

function createWindow() {
  const dir = app.getPath("userData");
  const saved = validateBounds(readState(dir), screen.getAllDisplays());
  const win = new BrowserWindow({
    // Autostart launches with --hidden. loadFile() still boots the renderer on a window that never
    // paints, and localStorage populates there — which is the whole reason a hidden start is viable
    // rather than a special case, because the renderer is the agent's only data source.
    show: !startsHidden(process.argv),
    // Opens above the app's own 900px breakpoint so it can never land in an untested middle state.
    width: saved ? saved.width : DEFAULT_BOUNDS.width,
    height: saved ? saved.height : DEFAULT_BOUNDS.height,
    ...(saved && saved.x !== undefined ? { x: saved.x, y: saved.y } : {}),
    minWidth: 900,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(here, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      nodeIntegrationInWorker: false,
      spellcheck: false,
    },
  });
  // maximize() also SHOWS a hidden window, so a --hidden start whose last session was maximized
  // would pop open on login. Defer it to the first show() instead.
  if (saved && saved.maximized) {
    if (startsHidden(process.argv)) pendingMaximize = true;
    else win.maximize();
  }
  // getNormalBounds rather than getBounds, because a maximized window's getBounds is its maximized
  // size — saving that would leave no sensible size to restore to when it is un-maximized.
  const saveGeometry = () => {
    if (win.isDestroyed()) return;
    const b = win.getNormalBounds();
    writeState(dir, { x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() });
  };
  // `|| !tray` is the reversion rule: if the tray could not be created, close goes back to meaning
  // quit. An app with no way back is worse than an app that does not stay resident. Read at close
  // time, so it covers a tray that fails to appear after this line runs.
  attachCloseToTray(win, {
    isQuitting: () => isQuitting || !tray,
    onHide: onWindowHidden,
    saveGeometry,
  });
  // Replaces removeMenu(): autoHideMenuBar keeps the bar hidden until Alt, so the chrome-free look
  // is unchanged while the accelerators become live and, via Alt, discoverable.
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate(makeDispatch(win))));
  // The renderer pushes the signed-in session's panel set so the Go menu greys what it cannot open.
  // null (or a missing panels array) means no staff configured — everything enabled, as before.
  ipcMain.handle("apptools:setMenuPanels", (_e, o) => {
    const panels = o && Array.isArray(o.panels) ? o.panels : null;
    Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate(makeDispatch(win), panels)));
    return { ok: true };
  });
  // Clamping only when zooming is not enough: narrowing the window crosses the breakpoint without
  // touching the zoom keys.
  win.on("resize", () => {
    if (win.isDestroyed()) return;
    const wc = win.webContents;
    const want = clampZoomFactor(wc.getZoomFactor(), win.getContentSize()[0]);
    if (Math.abs(want - wc.getZoomFactor()) > 1e-6) wc.setZoomFactor(want);
  });

  // Deny all in-app navigation and popups; route real external links via the allowlist.
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  win.loadFile(INDEX);
  return win;
}

// Two processes would share one userData directory: both polling the active router (status every
// 2s, throughput every 4s) and both writing the same collections ledger, where a concurrent write
// can clobber a recorded payment. Must be requested before whenReady.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Raise the running app rather than appearing to do nothing when the icon is double-clicked.
  // Now that the window is usually HIDDEN rather than merely unfocused, restore()+focus() is not
  // enough — showWindow() is the only thing that brings it back.
  app.on("second-instance", showWindow);

  app.whenReady().then(() => {
    // Defense-in-depth CSP header for the file:// page. It MUST mirror index.html's own
    // meta CSP: Electron enforces both and the stricter one wins per directive, so a header
    // narrower than the page's policy silently breaks features (e.g. dropping the license
    // host from img-src blocks the GCash "scan to pay" QR served from miklic.jeff-network.com).
    // Keep img-src/connect-src in sync with the license hosts the app legitimately loads.
    session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
      cb({ responseHeaders: { ...details.responseHeaders,
        "Content-Security-Policy": ["default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' https://miklic.jeff-network.com https://mikcon.jeff-network.com data: blob:; connect-src 'self' https://miklic.jeff-network.com http://localhost http://127.0.0.1 http://[::1]; form-action 'self'"] } });
    });

    const store = makeSecureStore({ encryptor: safeStorage, dir: app.getPath("userData") });
    registerIpc({ ipcMain, app, shell, store, openPrintWindow });
    // agentHost does not exist yet (startAgentHost below is what creates it), so the
    // handlers resolve it per call.
    registerPayReminderIpc({ ipcMain, getHost: () => agentHost });
    mainWindow = createWindow();
    // `store` is passed because the router list lives in DPAPI, not localStorage — the app
    // removes jf_routers as soon as it writes the encrypted blob. isUnlocked is INJECTED rather
    // than imported, so agent-host.js keeps no reach back into main.js and the gate stays trivially
    // fakeable in tests.
    agentHost = startAgentHost({
      app, win: mainWindow, exec, store,
      isUnlocked: () => isUnlocked(mainWindow),
      onState: (s) => { agentState = s; refreshTray(); },
    });

    // If the tray cannot be created, close reverts to meaning quit (see attachCloseToTray above,
    // and window-all-closed below — both read this same variable). An app with no way back is worse
    // than an app that does not stay resident.
    //
    // Windows only. This stage deliberately changes no macOS lifecycle, and leaving `tray` null on
    // darwin is exactly what preserves it: close proceeds, the window is destroyed,
    // window-all-closed declines to quit there as before, and `activate` rebuilds a window.
    if (process.platform !== "darwin") {
      try {
        const icon = nativeImage.createFromPath(TRAY_ICON);
        // createFromPath returns an EMPTY image rather than throwing when the file is missing —
        // which is exactly what a packaging mistake looks like at runtime.
        if (icon.isEmpty()) throw new Error("tray icon missing or unreadable at " + TRAY_ICON);
        tray = new Tray(icon);
        tray.on("double-click", showWindow);
        refreshTray();
      } catch (e) {
        tray = null;
        console.error("tray unavailable — close will quit the app:", (e && e.message) || e);
      }
    }

    // Self-healing: an in-place upgrade can move the binary and leave a Run key pointing at a path
    // that no longer exists. Re-assert on every launch with the current execPath.
    if (app.isPackaged && app.getLoginItemSettings().openAtLogin) {
      app.setLoginItemSettings(
        autostartPolicy({ packaged: true, enabled: true, execPath: process.execPath }));
    }

    // `activate` is a macOS concept and cannot fire on Windows, where the window is now hidden
    // rather than destroyed and getAllWindows() is therefore never empty — so a re-created window
    // needing its own agent host is not reachable here.
    app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
}

// The window is hidden, not closed, so on Windows this now fires only when there is no tray to go
// back to — the reversion path. Stage 1's plan explicitly forbade touching this line; lifting that
// constraint is the entire purpose of this stage.
app.on("window-all-closed", () => { if (process.platform !== "darwin" && !tray) app.quit(); });
// Must set the flag: File > Quit uses role:"quit", which calls app.quit() without going through the
// tray's Quit item, and without this the close handler would prevent it forever.
app.on("before-quit", () => {
  isQuitting = true;
  if (agentHost) { agentHost.stop(); agentHost = null; }
});
