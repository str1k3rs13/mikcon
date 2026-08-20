// Close means hide, not quit.
//
// The agent's only data source is the renderer — agent-host.js reads the ledger through
// win.webContents.executeJavaScript, because localStorage belongs to Chromium. So a BrowserWindow
// must exist for any background work to happen at all, which is why this hides the window rather
// than destroying it and rebuilding it on demand. See the always-on shell design.
//
// Pure: takes the window and three callbacks, imports no Electron, and is asserted under
// `node --test` against a plain object.
export function attachCloseToTray(win, { isQuitting, onHide, saveGeometry }) {
  // 'close', not 'closed': by 'closed' the native window is gone and getNormalBounds() has
  // nothing to report.
  win.on("close", (e) => {
    // Always, on both paths — hiding should remember the size too.
    try { saveGeometry(); } catch { /* geometry is a convenience; never block a close */ }
    // A GETTER, not a value: the flag is false at wire-up time and flipped later by before-quit.
    if (isQuitting()) return;
    e.preventDefault();
    win.hide();
    try { onHide(); } catch { /* a failed balloon must never leave the window on screen */ }
  });
}
