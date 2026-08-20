// Everything main/ imports must actually be inside the installer.
//
// electron-builder.yml lists `files` explicitly, which means a new top-level directory is
// packaged only if someone remembers to add it. agent/ was not, and the packaged app died on
// startup with ERR_MODULE_NOT_FOUND before it drew a window. `npm run dev` and the Electron
// smoke harness both run from the source tree, where every path resolves, so neither could
// ever have caught it - only the built artifact differs.
//
// This walks main/main.js's static import graph and asserts every file it reaches is matched
// by a `files` glob. It is a static check, so it costs milliseconds instead of a full build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(ROOT, "main", "main.js");

// The globs in use are all of the form "dir/**/*" or a bare filename. Rather than pull in a
// glob engine for two shapes, translate exactly those two and fail loudly on anything else -
// a silently-unmatched pattern here would make this test pass while packaging the wrong set.
function globToRegExp(glob) {
  if (glob.endsWith("/**/*")) return new RegExp("^" + escape(glob.slice(0, -5)) + "/");
  if (!glob.includes("*")) return new RegExp("^" + escape(glob) + "$");
  throw new Error(`packaging test cannot interpret the glob ${glob} - teach it this shape`);
}
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function packagedPatterns() {
  const yml = readFileSync(path.join(ROOT, "electron-builder.yml"), "utf8");
  const lines = yml.split(/\r?\n/);
  const start = lines.findIndex((l) => /^files:\s*$/.test(l));
  assert.ok(start >= 0, "electron-builder.yml has no files: block");
  const out = [];
  for (const line of lines.slice(start + 1)) {
    const m = /^\s+-\s+(.+?)\s*$/.exec(line);
    if (!m) break;              // first non-list line ends the block
    out.push(m[1]);
  }
  assert.ok(out.length > 0, "the files: block is empty");
  return out.map(globToRegExp);
}

// Resolves a relative specifier the way Node's ESM loader does for the extensions used here:
// the path as written, which must already carry its extension, or an index.js in a directory.
function resolveImport(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  if (existsSync(base) && statSync(base).isFile()) return base;
  const asIndex = path.join(base, "index.js");
  if (existsSync(asIndex)) return asIndex;
  return null;
}

function importGraph(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    // Static `import ... from "x"`, side-effect `import "x"`, and `export ... from "x"`.
    //
    // The `from` keyword is REQUIRED here, not optional. Without it this matched the first quoted
    // string on any line beginning with import or export - so `export const QUEUE_FIELDS = [".id",
    // ...]` was read as an import of ".id", which starts with a dot, resolves to nothing, and
    // failed the walk. Any exported constant whose first string looks relative would have done it.
    for (const m of src.matchAll(
      /(?:^|\n)\s*(?:import\s*["']([^"']+)["']|(?:import|export)[^;\n]*?\sfrom\s*["']([^"']+)["'])/g)) {
      const spec = m[1] || m[2];
      if (!spec.startsWith(".")) continue;    // node: builtins and bare specifiers
      const resolved = resolveImport(file, spec);
      assert.ok(resolved, `${path.relative(ROOT, file)} imports ${spec}, which does not exist`);
      queue.push(resolved);
    }
  }
  return seen;
}

test("every file main.js imports is inside the packaged file list", () => {
  const patterns = packagedPatterns();
  const files = importGraph(ENTRY);

  // A graph that walked nothing would pass every assertion below it. This repo has already
  // shipped a check that passed because it matched nothing.
  assert.ok(files.size > 5, `import graph found only ${files.size} files - the walk is broken`);

  const missing = [];
  for (const file of files) {
    const rel = path.relative(ROOT, file).split(path.sep).join("/");
    if (!patterns.some((re) => re.test(rel))) missing.push(rel);
  }
  assert.deepEqual(missing, [],
    `these are imported by main/ but would not be in the installer: ${missing.join(", ")}`);
});

// The regression that prompted this test, pinned by name: main.js reaches agent/ through
// agent-host.js, so agent/ must be packaged.
test("the agent module is reachable from main and packaged", () => {
  const files = importGraph(ENTRY);
  const rels = [...files].map((f) => path.relative(ROOT, f).split(path.sep).join("/"));
  assert.ok(rels.includes("agent/store.js"), "main no longer reaches agent/store.js");
  assert.ok(packagedPatterns().some((re) => re.test("agent/store.js")),
    "agent/ is missing from electron-builder.yml files:");
});

// The import-graph walk above cannot see this one: an icon loaded by file path is not an import.
// Same class of bug as the missing agent/ glob - a file the packaged app needs at runtime that
// nothing statically references - and that one shipped an installer which died before drawing a
// window while every source-tree test stayed green.
test("the tray icon exists, is the right size, and is packaged", () => {
  const rel = "main/assets/tray.png";
  const file = path.join(ROOT, ...rel.split("/"));
  assert.ok(existsSync(file), rel + " is missing - regenerate it with `npm run make:tray-icon`");
  assert.ok(statSync(file).size > 0, rel + " is empty");

  // PNG IHDR: width and height are big-endian uint32s at byte offsets 16 and 20. 32x32 is the
  // Windows notification-area size at 200% scaling; Windows downscales it far better than it
  // upscales a 16x16.
  const png = readFileSync(file);
  assert.equal(png.readUInt32BE(16), 32, "tray icon is not 32px wide");
  assert.equal(png.readUInt32BE(20), 32, "tray icon is not 32px tall");

  assert.ok(packagedPatterns().some((re) => re.test(rel)),
    rel + " is not matched by any files: pattern in electron-builder.yml");
});
