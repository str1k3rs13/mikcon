// Window geometry, remembered between runs.
//
// Deliberately a plain JSON file rather than makeSecureStore: the secure store fails closed when
// encryption is unavailable, which is right for router credentials and wrong here — it would turn
// "cannot encrypt" into "cannot remember your window".
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const STATE_FILE = "window-state.json";
export const DEFAULT_BOUNDS = { width: 1280, height: 860 };
export const MIN_WIDTH = 900;    // the window's own minWidth, and the app's CSS breakpoint
export const MIN_HEIGHT = 480;   // BrowserWindow sets no minHeight; this is the validator's floor

function intersects(r, d) {
  return r.x < d.x + d.width && d.x < r.x + r.width &&
         r.y < d.y + d.height && d.y < r.y + r.height;
}

// displays: [{ bounds: {x,y,width,height} }] — Electron's screen.getAllDisplays() shape, passed in
// rather than imported so this module stays testable without an Electron runtime.
// Numbers only — no coercion. This state is on disk, so it can be corrupted, hand-edited, or
// written by an older build. Number(null) is 0 and Number("1200") is 1200, so a coercing check
// would quietly accept a null height as 0 and clamp it to a real window size instead of falling
// back to the default.
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function validateBounds(saved, displays) {
  if (!saved || typeof saved !== "object") return null;
  const w = num(saved.width), h = num(saved.height);
  if (w === null || h === null) return null;
  const out = {
    width: Math.max(Math.round(w), MIN_WIDTH),
    height: Math.max(Math.round(h), MIN_HEIGHT),
    maximized: saved.maximized === true,
  };
  const x = num(saved.x), y = num(saved.y);
  if (x === null || y === null) return out;
  // A window restored onto a monitor that is no longer connected opens off-screen, where it cannot
  // be dragged back. Keep the size, drop the position, let Electron centre it.
  const rect = { x: Math.round(x), y: Math.round(y), width: out.width, height: out.height };
  const list = Array.isArray(displays) ? displays : [];
  if (!list.some((d) => d && d.bounds && intersects(rect, d.bounds))) return out;
  out.x = rect.x; out.y = rect.y;
  return out;
}

export function readState(dir) {
  try { return JSON.parse(readFileSync(path.join(dir, STATE_FILE), "utf8")); }
  catch { return null; }
}

export function writeState(dir, state) {
  // Geometry is a convenience; a failure here must never break shutdown.
  try { writeFileSync(path.join(dir, STATE_FILE), JSON.stringify(state), "utf8"); }
  catch { /* ignored on purpose */ }
}
