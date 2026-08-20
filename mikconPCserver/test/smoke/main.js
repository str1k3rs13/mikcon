// Boots real Electron and asserts the things an upgrade can silently break.
// Run via: npm run test:smoke   (see run.mjs for the spawn + exit-code contract)
const { app, BrowserWindow, safeStorage, session, ipcMain, shell } = require("electron");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const { profileKeyFingerprint } = require("./profile-key.js");

const here = __dirname;
const ROOT = path.join(here, "..", "..");
const results = [];
const ok = (name, cond, detail = "") => results.push({ name, pass: !!cond, detail: String(detail) });
// Reserved for checks that cannot apply on this machine — NOT for checks that are merely
// inconvenient. A skip must state why the evidence is unavailable, never why a failure is
// tolerable. Skips do not fail the run.
const skip = (name, detail = "") => results.push({ name, pass: false, skip: true, detail: String(detail) });

// Mirrors main.js:146-149. Asserted live rather than by reading main.js as text, which is all
// csp.test.mjs can do.
const CSP = "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; "
  + "script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; "
  + "img-src 'self' https://miklic.jeff-network.com https://mikcon.jeff-network.com data: blob:; "
  + "connect-src 'self' https://miklic.jeff-network.com http://localhost http://127.0.0.1 http://[::1]; "
  + "form-action 'self'";

function finish() {
  console.log("SMOKE_RESULTS " + JSON.stringify(results));
  app.exit(results.every((r) => r.pass || r.skip) ? 0 : 1);
}

// registerIpc() needs an openPrintWindow to satisfy its dependency shape, but nothing this
// harness does prints anything — no test here clicks a print button or opens the print window.
// A no-op stub keeps registerIpc's real wiring (main.js:151-152) intact without pulling the
// print flow, its temp-file writes, and its own BrowserWindow into a boot smoke test.
async function openPrintWindowStub() { return {}; }

app.whenReady().then(async () => {
  try {
    const want = process.env.EXPECT_ELECTRON_MAJOR;
    const major = process.versions.electron.split(".")[0];
    ok("electron major is " + want, !want || major === want, "got " + process.versions.electron);

    const nodeMajor = Number(process.versions.node.split(".")[0]);
    const nodeMinor = Number(process.versions.node.split(".")[1]);
    ok("bundled node >= 22.5 (node:sqlite floor)",
       nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 5), process.versions.node);

    let sqliteOk = false;
    try { require("node:sqlite"); sqliteOk = true; } catch (e) { sqliteOk = false; }
    ok("node:sqlite is importable", sqliteOk, sqliteOk ? "" : "ERR_UNKNOWN_BUILTIN_MODULE");

    ok("safeStorage backend available", safeStorage.isEncryptionAvailable());
    const blob = safeStorage.encryptString("hello");
    ok("safeStorage roundtrip", safeStorage.decryptString(blob) === "hello");

    // The real store, with the real encryptor — secure-store.test.mjs only ever sees a fake one.
    // A fresh mkdtemp dir, never app.getPath("userData"), so a smoke run can never read or clobber
    // a real customer's saved router credentials.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mikcon-smoke-"));
    const mod = await import(pathToFileURL(path.join(ROOT, "main", "secure-store.js")).href);
    const store = mod.makeSecureStore({ encryptor: safeStorage, dir });
    await store.set("password", "s3cret");
    const got = await store.get("password");
    ok("secure-store roundtrip through DPAPI", got.found && got.value === "s3cret", JSON.stringify(got));

    // Wire IPC the same way main.js:151-152 does. Without this, the real UI's boot-time
    // AppTools.secureGet() call (app/www's hydrateSecureData()) has no handler on the main side,
    // throws, and the renderer logs its own console.error — a failure that has nothing to do with
    // the Electron version and would never clear, making "no console errors during load"
    // permanently red regardless of upgrade. Booting the way the real app boots is what lets this
    // assertion mean something.
    const ipcMod = await import(pathToFileURL(path.join(ROOT, "main", "ipc", "router-api.js")).href);
    ipcMod.registerIpc({ ipcMain, app, shell, store, openPrintWindow: openPrintWindowStub });

    // main.js registers 'apptools:setMenuPanels' directly inside createWindow (main.js:104-108),
    // not inside registerIpc(), so the wiring above does not cover it. Without a handler here, the
    // renderer's boot-time call to it rejects with "No handler registered", logged as an unhandled
    // main-process error that the renderer-only "no console errors during load" assertion below can
    // never see. This is a stub: it returns the same { ok: true } shape main.js's real handler
    // returns, but does not rebuild the application menu (main.js does that; there is nothing to
    // rebuild here). It exists only so the harness's IPC surface matches the real app's.
    ipcMain.handle("apptools:setMenuPanels", () => ({ ok: true }));

    // A blob written by the PREVIOUS Electron must still decrypt. secure-store.js:30 DELETES
    // anything it cannot read, so a regression here silently destroys saved router credentials
    // on customer machines with no error shown. Fixture is written by Task 2.
    //
    // This check is only meaningful where the key that encrypted the fixture still exists —
    // it is per-machine and per-OS-user, not a property of the Electron version (see
    // profile-key.js). Asserting it unconditionally would paint every other machine red for a
    // reason that has nothing to do with the upgrade, and an assertion that cries wolf gets
    // deleted by the next person who trips over it. So: assert where the evidence exists,
    // state plainly where it does not.
    const fixture = path.join(here, "fixtures", "dpapi-prev.bin");
    const fixtureMeta = path.join(here, "fixtures", "dpapi-prev.json");
    if (!fs.existsSync(fixture) || !fs.existsSync(fixtureMeta)) {
      skip("blob from the previous Electron still decrypts",
        "no fixture on this machine — generate one on the OLD runtime with `npm run test:smoke:fixture` before upgrading");
    } else {
      const meta = JSON.parse(fs.readFileSync(fixtureMeta, "utf8"));
      const current = profileKeyFingerprint(app.getPath("userData"));
      if (!current || current !== meta.keyFingerprint) {
        skip("blob from the previous Electron still decrypts",
          "fixture was written under a different profile key (" + meta.keyFingerprint + " vs "
          + (current || "none") + ") — unreadable here for reasons unrelated to Electron");
      } else {
        // Same key that wrote it, so a failure here is a genuine safeStorage regression.
        let prev = null;
        try { prev = safeStorage.decryptString(fs.readFileSync(fixture)); } catch (e) { prev = "THREW: " + e.message; }
        ok("blob from the previous Electron still decrypts (written under " + meta.electron + ")",
          prev === meta.plaintext, String(prev));
      }
    }

    session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
      cb({ responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [CSP] } });
    });

    // Two console errors show up on every real boot of this app, on every Electron version,
    // independent of anything this harness does — they are genuine, pre-existing bugs in the
    // app's own CSP configuration, not noise introduced by the smoke harness and not caused by
    // the Electron 31->43 upgrade:
    //   - 'http://[::1]' in connect-src: Chromium rejects this literal source form outright, so
    //     this entry has never actually allowed anything through connect-src. Dead weight in the
    //     policy, not a working allowance.
    //   - frame-ancestors delivered via a <meta> element: this directive can only be enforced via
    //     an HTTP response header, never via <meta>, so the copy of it in the page's meta CSP has
    //     never done anything. The working copy is the one main.js sets via onHeadersReceived.
    // Both are allowlisted here, by exact substring, ONLY so this assertion can still detect any
    // OTHER console error. Documented rather than fixed here, and documented rather than silenced
    // silently: fixing the CSP itself is out of scope for a behaviour-neutral harness task. Keep
    // this list narrow — widening the match would swallow the real regressions this assertion
    // exists to catch.
    const KNOWN_CSP_BUGS = [
      "contains an invalid source: 'http://[::1]'",
      "'frame-ancestors' is ignored when delivered via a <meta> element",
    ];
    const isKnownCspBug = (message) => KNOWN_CSP_BUGS.some((s) => message.includes(s));

    const errors = [];
    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 860,
      webPreferences: {
        preload: path.join(ROOT, "main", "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    // Any error while the real UI boots fails the run.
    //
    // The signature of this event CHANGED between 31 and 43: the old form is
    // (event, level:number, message, line, sourceId) with level 3 = error; the new form passes a
    // single details object carrying {level:"error", message}. Handling only the old shape would
    // leave `level` undefined on 43, make `level >= 3` false forever, and silently disable the
    // single most valuable assertion here — a green check that can no longer go red, which is the
    // exact failure Step 5 exists to catch. Accept both.
    win.webContents.on("console-message", (...args) => {
      const d = args[0];
      if (d && typeof d === "object" && "level" in d && typeof d.level === "string") {
        if (d.level === "error" && !isKnownCspBug(String(d.message))) errors.push(String(d.message));
        return;
      }
      const [, level, message] = args;
      if (typeof level === "number" && level >= 3 && !isKnownCspBug(String(message))) errors.push(String(message));
    });
    win.webContents.on("render-process-gone", (_e, d) => errors.push("renderer gone: " + d.reason));

    await win.loadFile(path.join(ROOT, "app", "www", "index.html"));

    const probe = await win.webContents.executeJavaScript(`(function(){
      return {
        gate: !!document.querySelector("#license-gate"),
        go: typeof go === "function",
        tabs: document.querySelectorAll("nav.tabs button").length,
        title: document.title
      };
    })()`);

    ok("license gate rendered", probe.gate, JSON.stringify(probe));
    ok("app script evaluated (go() defined)", probe.go, JSON.stringify(probe));
    // The count is what matters: a tab that fails to render is a screen an operator cannot reach.
    ok("all eight tabs present", probe.tabs === 8, "got " + probe.tabs);
    ok("no console errors during load", errors.length === 0, errors.join(" | "));

    const csp = await win.webContents.executeJavaScript(
      `document.querySelector('meta[http-equiv="Content-Security-Policy"]') ? "meta-present" : "no-meta"`);
    ok("page carries its meta CSP", csp === "meta-present", csp);

    // The load-bearing fact for the whole always-on shell: a window created with show:false still
    // boots its renderer, so localStorage — the agent's ONLY data source, because it belongs to
    // Chromium — is populated on a window that never paints. If this were false, hiding the window
    // on close could not work and the architecture would have to change.
    ok("a window that never painted still loaded its renderer",
       win.isVisible() === false && probe.go === true,
       "visible=" + win.isVisible() + " go=" + probe.go);

    // The agent must actually start inside real Electron, not just in unit tests. A database
    // that only ever appears under node --test would be a mirror that never runs in the
    // product. This harness's app name is mikcon-smoke, so userData here is its own profile —
    // never the real mikcon-pc one.
    //
    // This runs END TO END - real DPAPI blob, real renderer localStorage - because the halves
    // pass each other's unit tests while failing to meet. The first version of this host
    // looked for the router list in localStorage, where the app had already deleted it, so
    // every unit test passed and the shipped mirror imported no payments at all. Only an
    // assertion that a payment actually lands can catch that.
    const { startAgentHost } = await import(pathToFileURL(path.join(ROOT, "main", "agent-host.js")).href);

    // Start from an empty agent database, every run. userData here is the harness's own
    // mikcon-smoke profile and it PERSISTS between runs, so without this the rows below are
    // whatever the last run left: "nothing was imported while locked" would fail on a leftover
    // payment, and worse, "a real payment crosses into the database" would pass without importing
    // anything at all. WAL mode keeps two sidecar files; all three go.
    const agentDbFile = path.join(app.getPath("userData"), "agent.db");
    for (const f of [agentDbFile, agentDbFile + "-wal", agentDbFile + "-shm"]) {
      try { fs.rmSync(f, { force: true }); } catch { /* a locked file is reported by the assertions */ }
    }

    // Seed the router where the app really keeps it: the encrypted blob, not localStorage.
    await store.set("routers", JSON.stringify({
      routers: [{ id: "rsmoke", name: "Smoke", ip: "10.0.0.1", user: "admin", pass: "s3cret" }],
      activeId: "rsmoke",
    }));
    // And seed that router's ledger where the app really keeps THAT: the renderer.
    await win.webContents.executeJavaScript(
      `localStorage.setItem("jf_ledger_rsmoke", ${JSON.stringify(JSON.stringify(
        [{ n: "SmokeCustomer", a: 500, at: "2026-07-02", t: "ppp", k: "SmokeCustomer|2026-07-01" }]))}); true`);

    // Locked FIRST, against the same seeded router and ledger, and while the database is still
    // empty — so "nothing was imported" is evidence rather than an artefact of ordering. This is
    // the unlicensed-install case, end to end, through the real renderer and the real DPAPI blob.
    const { openStore: openStoreForCheck } =
      await import(pathToFileURL(path.join(ROOT, "agent", "store.js")).href);
    const locked = startAgentHost({
      app, win, exec: async () => [], store, isUnlocked: async () => false,
    });
    await locked.syncOnce();
    const lockedDb = openStoreForCheck(path.join(app.getPath("userData"), "agent.db"));
    const lockedRows = lockedDb.prepare("SELECT COUNT(*) c FROM payment").get().c;
    lockedDb.close();
    ok("nothing is imported while the licence gate is up", lockedRows === 0, "rows=" + lockedRows);
    locked.stop();

    const host = startAgentHost({ app, win, exec: async () => [], store });
    await host.syncOnce();
    const dbFile = path.join(app.getPath("userData"), "agent.db");
    ok("agent database created under real Electron", fs.existsSync(dbFile), dbFile);
    const { openStore } = await import(pathToFileURL(path.join(ROOT, "agent", "store.js")).href);
    const check = openStore(dbFile);
    const names = check.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    ok("agent schema present under real Electron", names.includes("payment") && names.includes("customer"),
       names.join(","));

    const paid = check.prepare("SELECT * FROM payment WHERE router_id = ?").get("rsmoke");
    ok("a real payment crosses DPAPI + renderer into the database", !!paid && paid.amount === 500,
       JSON.stringify(paid || null));

    // The blob that supplied the router also holds its password. It must not have followed the
    // router into the mirror.
    const dump = JSON.stringify(check.prepare("SELECT * FROM router").all());
    ok("no router credential reached the database", !dump.includes("s3cret") && !dump.includes("admin"), dump);

    host.stop();

    // The Stage 1 poller read router.host from a list whose entries only ever carried .ip, so every
    // poll would have gone to `undefined`. Unit tests pin routersForPolling(); this pins the whole
    // path — real DPAPI blob, real host, through startAgentHost's own wiring.
    const polled = [];
    const poller = startAgentHost({
      app, win, store, exec: async (o) => { polled.push(o); return []; },
    });
    await poller.pollOnce();
    poller.stop();
    ok("the poller is given a real host and port",
       polled.length > 0 && polled[0].host === "10.0.0.1" && polled[0].port === 8728,
       JSON.stringify(polled[0] || null));
    ok("the poller only ever reads",
       polled.length > 0 && polled.every((o) => /\/print$/.test(String(o.cmd || ""))),
       polled.map((o) => o.cmd).join(", "));
  } catch (e) {
    ok("smoke harness ran without throwing", false, (e && e.stack) || String(e));
  }
  finish();
});
