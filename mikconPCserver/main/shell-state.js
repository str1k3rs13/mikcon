// Shell state that is not window geometry. Today that is one boolean: has the operator been told,
// once, that closing the window does not quit the app?
//
// Its own file rather than a field in window-state.json, because validateBounds() has a tested
// contract over a fixed {x,y,width,height,maximized} shape and its whole job is rejecting fields it
// does not recognise. Plain JSON either way, for the same reason window-state.js is: makeSecureStore
// fails closed when encryption is unavailable, which is right for router credentials and would turn
// "cannot encrypt" into "cannot remember" here.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const SHELL_STATE_FILE = "shell-state.json";

export function readShellState(dir) {
  try {
    const parsed = JSON.parse(readFileSync(path.join(dir, SHELL_STATE_FILE), "utf8"));
    // An array is JSON and is an object; it is not a state file.
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

export function writeShellState(dir, state) {
  try { writeFileSync(path.join(dir, SHELL_STATE_FILE), JSON.stringify(state), "utf8"); }
  catch { /* ignored on purpose: a lost flag must never break a hide or a shutdown */ }
}

// Fails toward telling the operator. An extra balloon is a nuisance; a missing one is an app the
// operator believes has crashed.
export function shouldShowHideBalloon(dir) {
  return readShellState(dir).hideBalloonShown !== true;
}

// Spreads the existing state so this file can carry a second flag later without this function
// silently deleting the first one.
export function markHideBalloonShown(dir) {
  writeShellState(dir, { ...readShellState(dir), hideBalloonShown: true });
}
