import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const AGENT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "agent");

function jsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...jsFiles(p));
    else if (/\.(js|mjs|cjs)$/.test(name)) out.push(p);
  }
  return out;
}

// The whole money loop must run under `node --test` with no Electron launch. The moment one
// file in agent/ imports electron, the entire module can only be tested by booting a desktop
// app — so this is asserted rather than left to discipline.
test("no file under agent/ imports electron", () => {
  const files = jsFiles(AGENT);
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    assert.ok(!/require\(\s*["']electron["']\s*\)/.test(src), `${f} requires electron`);
    assert.ok(!/from\s*["']electron["']/.test(src), `${f} imports electron`);
    assert.ok(!/import\(\s*["']electron["']\s*\)/.test(src), `${f} dynamically imports electron`);
  }
  // A scanner that scanned nothing passes every assertion above it. Fail loudly instead.
  assert.ok(files.length > 0, "scanned no files — the agent/ path is wrong");
});

// Guards the guard: if agent/ is ever moved or renamed, jsFiles() throws here rather than
// silently returning [] and leaving a green test that checks nothing.
test("the agent directory exists where the scanner looks", () => {
  assert.ok(statSync(AGENT).isDirectory());
});
