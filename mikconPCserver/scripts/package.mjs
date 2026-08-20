// Runs electron-builder, working around NSIS's refusal to build out of a path containing "$".
//
// electron-builder generates the installer icon into <output>/.icon-ico/icon.ico and hands
// makensis the absolute path as a compile-time define (/DMUI_ICON=...). "$" is NSIS's variable
// sigil, so on a box whose user profile contains one - this project's author is literally
// "C:\Users\Noob$" - the path arrives at makensis as "C:\Users\Noob$$\..." and the compile dies:
//
//   Error while loading icon from "C:\Users\Noob$$\...\dist\.icon-ico\icon.ico": can't open file
//   Error in macro MUI_INTERFACE on macroline 87
//   makensis.exe process failed ERR_ELECTRON_BUILDER_CANNOT_EXECUTE
//
// The .ico is present, valid and readable - it is the path that cannot survive the round trip.
// So when the output directory is "$"-free we invoke electron-builder completely untouched, and
// only otherwise do we build into a "$"-free directory and copy the results back into dist/.
// Nothing about the produced artifacts differs; only where they are assembled.
import { spawnSync } from "node:child_process";
import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const out = path.join(root, "dist");

function build(extraArgs) {
  const r = spawnSync("npx", ["electron-builder", ...extraArgs], { cwd: root, stdio: "inherit", shell: true });
  if (r.error) { console.error("package: could not start electron-builder: " + r.error.message); return 1; }
  // A null status means killed by a signal; treat anything but a clean 0 as failure. Never let a
  // packaging failure reach the caller as success - that is how 3.14.0 came to be "released"
  // without an installer ever being written.
  return r.status === 0 ? 0 : (r.status ?? 1);
}

if (!out.includes("$")) process.exit(build([]));

// A "$"-free staging directory. Public is chosen over os.tmpdir() because on Windows tmpdir sits
// under the user profile, which is exactly the path we are escaping.
const safe = path.join(process.env.PUBLIC || "C:\\Users\\Public", "mikcon-server-build");
console.log("package: dist path contains \"$\", which NSIS cannot read an icon out of.");
console.log("package: staging the build in " + safe + " and copying the artifacts back.");

try {
  await rm(safe, { recursive: true, force: true });
  await mkdir(safe, { recursive: true });
  await writeFile(path.join(safe, ".writable"), "");
} catch (e) {
  console.error("package: cannot use " + safe + " (" + e.message + ")");
  console.error("package: pass your own with: npx electron-builder -c.directories.output=<a $-free path>");
  process.exit(1);
}

const status = build(["-c.directories.output=" + safe.replace(/\\/g, "/")]);
if (status !== 0) {
  console.error("package: electron-builder failed (exit " + status + "); artifacts left in " + safe);
  process.exit(status);
}

await mkdir(out, { recursive: true });
const produced = (await readdir(safe, { withFileTypes: true })).filter((e) => e.name !== ".writable");
for (const e of produced) {
  await cp(path.join(safe, e.name), path.join(out, e.name), { recursive: true, force: true });
}
await rm(safe, { recursive: true, force: true });

const shipped = produced.filter((e) => e.isFile() && e.name.endsWith(".exe")).map((e) => e.name);
if (shipped.length === 0) {
  // electron-builder exited 0 but wrote no installer. Fail rather than report a build that shipped
  // nothing; this is the same failure mode the old "npm audit || true &&" chain hid.
  console.error("package: electron-builder exited 0 but produced no .exe in " + safe);
  process.exit(1);
}
console.log("package: copied into dist/ -> " + shipped.join(", "));
