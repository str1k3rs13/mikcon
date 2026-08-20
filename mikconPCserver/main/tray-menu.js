// The tray menu, as a plain template array. Tray and Menu.buildFromTemplate stay in main.js, so
// this file — like menu.js beside it — is asserted under `node --test` with no Electron runtime.
//
// Deliberately small: there is no queue and no kill switch to expose until Stage 5.

// Local time, to match the clock on the taskbar right beside the icon.
function hhmm(date) {
  return String(date.getHours()).padStart(2, "0") + ":" + String(date.getMinutes()).padStart(2, "0");
}

// The one line distinguishing "running quietly" from "silently broken" — which in this codebase is
// not a hypothetical failure. There is no "paused" state: the only thing that suspends work in this
// stage is the licence gate, and that is Locked.
export function trayStatusLine({ locked, lastSyncAt, unreachable } = {}) {
  if (locked) return "Locked — open to sign in";
  if (!lastSyncAt) return "starting…";
  const line = "mirroring · last sync " + hhmm(lastSyncAt);
  return unreachable > 0 ? line + " · " + unreachable + " unreachable" : line;
}

// What each verdict is called when exactly one router has it. Naming the router is worth the
// branch: most installs have one to three, and "House" tells the operator where to go while
// "1 router" makes them look it up.
const CUTOFF_PHRASE = {
  missing: "cut-off not installed",
  stale: "cut-off is out of date",
  unscheduled: "cut-off never runs",
  dry: "cut-off is log-only",
};

export function cutoffWarningLine({ affected = [], worst = null } = {}) {
  if (!worst || !affected.length) return "";
  if (affected.length === 1) {
    const r = affected[0];
    return "⚠ " + (r.name || r.id) + ": " + (CUTOFF_PHRASE[worst] || CUTOFF_PHRASE.missing);
  }
  // Past one, a count is the honest summary and the wording comes from the worst among them.
  const tail = worst === "dry" ? "cut-off is log-only" : "cut-off needs attention";
  return "⚠ " + affected.length + " routers: " + tail;
}

export const AUTOSTART_LABEL = "Start with Windows";
// In development process.execPath is node_modules/electron/dist/electron.exe: registering that
// writes a Run key that breaks the moment the checkout moves, and points at a binary that would
// launch Electron's default app rather than MikconPC.
export const AUTOSTART_DEV_LABEL = AUTOSTART_LABEL + " (packaged builds only)";

export function buildTrayMenu({ state = {}, actions = {} }) {
  const autostart = state.autostart || {};
  const supported = !!autostart.supported;
  const enabled = supported && !!autostart.enabled;
  const cutoff = cutoffWarningLine(state.cutoff);
  return [
    { id: "tray-title", label: "MikconPC Server", enabled: false },
    { type: "separator" },
    { id: "tray-open", label: "Open", click: () => actions.open && actions.open() },
    { id: "tray-status", label: trayStatusLine(state), enabled: false },
    // Only when something is wrong: a permanent "cut-off OK" line is one more thing to stop
    // reading, and this one has to be noticed the day it appears.
    ...(cutoff ? [{ id: "tray-cutoff", label: cutoff, enabled: false }] : []),
    { type: "separator" },
    {
      id: "tray-autostart",
      type: "checkbox",
      label: supported ? AUTOSTART_LABEL : AUTOSTART_DEV_LABEL,
      checked: enabled,
      enabled: supported,
      click: () => actions.toggleAutostart && actions.toggleAutostart(!enabled),
    },
    { type: "separator" },
    // Last, and present in every state including Locked: redefining the close button makes this the
    // operator's only guaranteed way out.
    { id: "tray-quit", label: "Quit", click: () => actions.quit && actions.quit() },
  ];
}
