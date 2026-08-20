// Is the router's nightly cut-off actually enforcing?
//
// The app has cutoffIsStale() already, but it only ever fires when an operator happens to open that
// screen. A router whose scheduler entry was deleted, or which still runs V0 or V1, enforces
// silently less than the operator believes - and on a router with no PPPoE, V1 enforces nothing at
// all. This is the part that watches.
//
// Pure: takes the two RouterOS rows and returns a verdict. No client, no clock, no I/O.

// Must match the shared UI's own CUTOFF_VERSION; a test pins it. If the app ships a newer script
// and this is left behind, every router in the field reads as fine while running an old one.
export const CUTOFF_VERSION = 2;

export function cutoffVersionOf(source) {
  const m = /MIKCON-CUTOFF-V(\d+)/.exec(String(source || ""));
  // No marker at all means it predates them - which is every router in the field today.
  return m ? Number(m[1]) : 0;
}

// In descending severity. The order of the checks below IS the severity order.
export function cutoffHealth({ script, scheduler } = {}) {
  if (!script) return { verdict: "missing", version: 0, grace: null, expProfile: "" };

  const src = String(script.source || "");
  const version = cutoffVersionOf(src);
  const g = /:local grace (\d+)/.exec(src);
  const d = /:local dry (true|false)/.exec(src);
  const p = /:local expProf "([^"]*)"/.exec(src);
  // null, not 0. Zero grace means cut off on the due date - a guess that would have Stage 4
  // promising customers a disconnection date the router disagrees with.
  const base = { version, grace: g ? Number(g[1]) : null, expProfile: p ? p[1] : "" };

  // Only OLDER counts as stale. A newer script came from a newer app, and telling an operator to
  // downgrade it would be worse than saying nothing.
  if (version < CUTOFF_VERSION) return { verdict: "stale", ...base };
  // A disabled entry and an absent one are the same situation to act on: it never runs.
  if (!scheduler || String(scheduler.disabled || "") === "true") return { verdict: "unscheduled", ...base };
  if (d && d[1] === "true") return { verdict: "dry", ...base };
  return { verdict: "ok", ...base };
}

const RANK = { missing: 4, stale: 3, unscheduled: 2, dry: 1, ok: 0 };

// The worst verdict in a list, or null when nothing is wrong. The tray takes its wording from this.
export function worstVerdict(verdicts) {
  let worst = null;
  let rank = 0;
  for (const v of verdicts || []) {
    const r = RANK[v] || 0;
    if (r > rank) { rank = r; worst = v; }
  }
  return worst;
}
