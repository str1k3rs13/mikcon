import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

test("sync-web copies index.html into app/www", async () => {
  execFileSync(process.execPath, [path.resolve(here, "..", "scripts", "sync-web.mjs")]);
  await access(path.resolve(here, "..", "app", "www", "index.html")); // throws if missing
  assert.ok(true);
});
