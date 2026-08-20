// Spawns the smoke app under Electron and reports each assertion.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const electron = require(path.join(here, "..", "..", "node_modules", "electron"));

// Extra args are forwarded to Electron. The one that matters is --user-data-dir=<empty dir>,
// which is how you reproduce a clean machine locally: the fixture's profile key is absent
// there, so the cross-version check must SKIP rather than fail.
const child = spawn(electron, [here, ...process.argv.slice(2)], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" },
});

let out = "";
child.stdout.on("data", (d) => { out += d; process.stdout.write(d); });
child.stderr.on("data", (d) => process.stderr.write(d));

child.on("close", (code) => {
  const line = out.split("\n").find((l) => l.startsWith("SMOKE_RESULTS "));
  if (!line) {
    console.error("\nNo SMOKE_RESULTS line — the app died before reporting. Exit code " + code);
    process.exit(1);
  }
  const results = JSON.parse(line.slice("SMOKE_RESULTS ".length));
  console.log("");
  let failed = 0;
  let skipped = 0;
  for (const r of results) {
    // A skip is printed WITH its reason, always. A silent skip is how a check stops running
    // without anyone noticing.
    const tag = r.skip ? "  SKIP  " : r.pass ? "  PASS  " : "  FAIL  ";
    console.log(tag + r.name + (r.pass || !r.detail ? "" : "  -> " + r.detail));
    if (r.skip) skipped++;
    else if (!r.pass) failed++;
  }
  const passed = results.length - failed - skipped;
  console.log(`\n===== ${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""} =====`);
  process.exit(failed ? 1 : 0);
});
