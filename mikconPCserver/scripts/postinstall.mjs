// Electron is only for `npm run electron` on Windows. Linux servers run `node server.mjs`
// and must not download a Chromium binary on npm install.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") process.exit(0);
const here = path.dirname(fileURLToPath(import.meta.url));
const installer = path.resolve(here, "..", "node_modules", "electron", "install.js");
if (!existsSync(installer)) process.exit(0);
const r = spawnSync(process.execPath, [installer], { stdio: "inherit" });
process.exit(r.status == null ? 1 : r.status);
