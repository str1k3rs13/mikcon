// Login-item policy.
//
// The OS is the source of truth: app.getLoginItemSettings().openAtLogin is false until something
// sets it, so "off by default" needs no settings file of its own and no migration.
//
// Pure and Electron-free. main.js reads the current setting, calls this, and applies the result.
export const HIDDEN_FLAG = "--hidden";

export function startsHidden(argv) {
  return Array.isArray(argv) && argv.includes(HIDDEN_FLAG);
}

// Returns the argument for app.setLoginItemSettings(), or null when there is nothing safe to
// register — in which case main.js makes no call and the tray item is shown disabled.
export function autostartPolicy({ packaged, enabled, execPath }) {
  if (!packaged) return null;
  if (!execPath) return null;
  // openAtLogin:false is a real, necessary call — it is how the Run key gets cleared when the
  // operator unticks the box.
  return { openAtLogin: !!enabled, path: execPath, args: [HIDDEN_FLAG] };
}
