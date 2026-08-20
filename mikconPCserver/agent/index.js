// Wiring only. Every dependency is injected, so this file never reaches for a database path,
// a router credential, or a clock of its own — which is what keeps agent/ testable headless
// and free of Electron.
import { importSnapshot } from "./import-legacy.js";
import { pollAll } from "./poller.js";

export function createAgent({ db, client, clock, logger = console }) {
  if (!db) throw new Error("agent needs a database");
  if (!clock) throw new Error("agent needs a clock");

  return {
    // Idempotent, so the caller may run it as often as it likes — which is exactly how the
    // mirror stays current without a second write path.
    sync(snapshot) {
      if (!clock.isSane()) {
        // Refusing is the safe side: a machine that boots believing it is 1970 would, once
        // the ladder exists, act on dates that never happened.
        throw new Error("refusing to sync: the system clock reads " + clock.today());
      }
      try {
        return importSnapshot(db, snapshot, { at: clock.today() });
      } catch (e) {
        // localStorage remains the record. A failed mirror must never break the app.
        logger.error("agent: import failed", (e && e.message) || e);
        return { routers: 0, payments: 0, messages: 0, sales: 0 };
      }
    },

    poll(routers) {
      return pollAll({ db, client, routers, clock });
    },

    close() {
      try { db.close(); } catch {}
    },
  };
}
