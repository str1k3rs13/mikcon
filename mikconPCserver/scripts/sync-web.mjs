// Copies the JuanFi web UI verbatim into app/www so the packaged app and the Android
// build share one index.html. No transformation — the Capacitor shim is injected by
// preload.js at runtime, never by editing the page.
import { cp, rm, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, "..", "..", "juanfi-app", "www");
const dst = path.resolve(here, "..", "app", "www");

const srcIndex = path.join(src, "index.html");
const dstIndex = path.join(dst, "index.html");
try { await access(srcIndex); }
catch {
  try { await access(dstIndex); }
  catch {
    console.error("sync-web: source not found: " + srcIndex);
    process.exit(1);
  }
  console.log("sync-web: source missing, keeping existing " + dst);
  process.exit(0);
}

await rm(dst, { recursive: true, force: true });
await cp(src, dst, { recursive: true });
console.log("sync-web: copied " + src + " -> " + dst);
