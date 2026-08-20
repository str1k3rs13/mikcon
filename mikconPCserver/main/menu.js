// The application menu. autoHideMenuBar stays on, so this bar is hidden until Alt is pressed: the
// chrome-free look is unchanged, and Alt is the only thing that makes these shortcuts discoverable.
// A shortcut with no discovery surface is dead weight.

// In the order they appear in the shared UI's tab bar, so Ctrl+N matches what the operator sees.
// `view` is the argument index.html's go() takes; test/menu.test.mjs pins each one to a real tab.
export const DESTINATIONS = [
  { label: "Status",   view: "status" },
  { label: "Routers",  view: "routers" },
  { label: "Vouchers", view: "vouchers" },
  { label: "Users",    view: "users" },
  { label: "PPPoE",    view: "pppoe" },
  { label: "Vendos",   view: "vendos" },
  { label: "Sales",    view: "sales" },
  { label: "SMS",      view: "sms" },
];

// Pure: takes a dispatch callback and returns a plain template array, so it can be asserted on
// under `node --test` without an Electron runtime. main.js does Menu.buildFromTemplate.
// Every item carries an id so a driver script can click it by name.
// `allowed` is null when no staff are configured — every destination is enabled, exactly as before
// this existed. An ARRAY, including an empty one, is a signed-in session's panel set: what is not
// in it is disabled. Null and [] mean different things and must not be conflated.
export function buildMenuTemplate(dispatch, allowed) {
  const may = (view) => !Array.isArray(allowed) || allowed.indexOf(view) >= 0;
  return [
    { label: "File", submenu: [
      { id: "reload", label: "Reload", accelerator: "CommandOrControl+R",
        click: () => dispatch({ type: "reload" }) },
      { type: "separator" },
      { role: "quit" },
    ] },
    // Roles only. Clipboard already works without a menu — Chromium handles editing commands in
    // text inputs — so this menu is discoverability, not repair.
    { label: "Edit", submenu: [
      { role: "undo" }, { role: "redo" }, { type: "separator" },
      { role: "cut" }, { role: "copy" }, { role: "paste" }, { type: "separator" },
      { role: "selectAll" },
    ] },
    { label: "Go", submenu: [
      ...DESTINATIONS.map((d, i) => ({
        id: "go-" + d.view,
        label: d.label,
        accelerator: "CommandOrControl+" + (i + 1),
        ...(may(d.view) ? {} : { enabled: false }),
        click: () => dispatch({ type: "go", view: d.view }),
      })),
      { type: "separator" },
      { id: "find", label: "Find on this screen", accelerator: "CommandOrControl+F",
        click: () => dispatch({ type: "find" }) },
    ] },
    // Custom handlers rather than the built-in zoom roles: the roles adjust zoom LEVEL
    // (logarithmic) while the breakpoint clamp is expressed in zoom FACTOR (linear), and mixing the
    // two makes them disagree about where the ceiling is. See main/zoom.js.
    { label: "View", submenu: [
      { id: "zoom-in", label: "Zoom In", accelerator: "CommandOrControl+=",
        click: () => dispatch({ type: "zoom", dir: 1 }) },
      { id: "zoom-out", label: "Zoom Out", accelerator: "CommandOrControl+-",
        click: () => dispatch({ type: "zoom", dir: -1 }) },
      { id: "zoom-reset", label: "Actual Size", accelerator: "CommandOrControl+0",
        click: () => dispatch({ type: "zoom", dir: 0 }) },
    ] },
  ];
}
