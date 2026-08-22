// Reads every configured router and refreshes the customer cache.
//
// It OBSERVES ONLY. The router's own mikcon-cutoff script remains the single thing that
// disables service - a PC that is switched off must never mean nobody gets cut off. A test
// asserts every command this issues ends in /print, and that the only attribute ever sent is
// .proplist, which narrows a read.
//
// The router client is injected (in production, exec() from main/routeros.js, which is
// Electron-free) so this whole file tests without a router or a desktop app.
//
// This file owns the COMMANDS. Every rule about what counts as a customer lives in billing.js,
// because deciding whether a queue is a duplicate of a lease needs all three results in hand at
// once - which a per-source loop cannot express.
import { billableFrom } from "./billing.js";

// The app's own QUEUE_FIELDS, pinned against it by a test. Queues are the one source where most
// rows returned are discarded (RouterOS builds a dynamic queue per rate-limited lease), so this
// read asks for only the columns billing uses. `dynamic` is load-bearing: the duplicate filter
// reads it, and dropping it would make every queue look static.
export const QUEUE_FIELDS = [".id", "name", "target", "max-limit", "comment", "dynamic"];

export function replaceSessionLive(db, routerId, names, seenAt) {
  const rid = String(routerId || "");
  db.prepare("DELETE FROM session_live WHERE router_id = ?").run(rid);
  const ins = db.prepare("INSERT OR REPLACE INTO session_live (router_id, name, seen_at) VALUES (?,?,?)");
  const seen = new Set();
  for (const raw of names || []) {
    const name = String(raw || "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    ins.run(rid, name, String(seenAt || ""));
  }
}

function liveNamesFrom({ activePpp, leases }) {
  const names = [];
  for (const row of activePpp || []) {
    const n = String((row && row.name) || "").trim();
    if (n) names.push(n);
  }
  for (const lease of leases || []) {
    const mac = String((lease && lease["mac-address"]) || "").trim();
    const st = String((lease && lease.status) || "").toLowerCase();
    const addr = String((lease && lease.address) || "").trim();
    const live = st === "bound" || (!st && !!(mac || addr));
    if (!live) continue;
    if (mac) names.push(mac);
    if (addr) names.push(addr);
  }
  return names;
}

export async function pollRouter({ db, client, router, clock }) {
  const today = clock.today();
  const call = (cmd, attrs) => client({
    host: router.host, port: router.port, user: router.user, pass: router.pass,
    tls: router.tls, tlsFingerprint: router.tlsFingerprint, cmd,
    ...(attrs ? { attrs } : {}),
  });

  // Sequential, and all three before anything is written: a queue cannot be judged a duplicate
  // until the leases are known.
  const secrets = await call("/ppp/secret/print");
  const leases = await call("/ip/dhcp-server/lease/print");
  const queues = await call("/queue/simple/print", { ".proplist": QUEUE_FIELDS.join(",") });

  // Live sessions are optional: a user who can print secrets but not /ppp/active must still
  // refresh the billing cache. Failures leave the previous snapshot in place.
  let activePpp = [];
  let liveOk = true;
  try {
    activePpp = await call("/ppp/active/print", { ".proplist": "name" });
  } catch {
    liveOk = false;
  }

  const upsert = db.prepare(`
    INSERT INTO customer (router_id,kind,key,raw_comment,last_seen,src,name,phone,plan,price,cycle,due,paid,bal,wallet)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(router_id,kind,key) DO UPDATE SET
      raw_comment = excluded.raw_comment,
      last_seen   = excluded.last_seen,
      src         = excluded.src,
      name        = excluded.name,
      phone       = excluded.phone,
      plan        = excluded.plan,
      price       = excluded.price,
      cycle       = excluded.cycle,
      due         = excluded.due,
      paid        = excluded.paid,
      bal         = excluded.bal,
      wallet      = excluded.wallet`);

  const rows = billableFrom({ secrets, leases, queues });
  for (const c of rows) {
    upsert.run(router.id, c.kind, c.key, c.raw_comment, today, c.src,
               c.name, c.phone, c.plan, c.price, c.cycle, c.due, c.paid, c.bal, c.wallet);
  }
  if (liveOk) replaceSessionLive(db, router.id, liveNamesFrom({ activePpp, leases }), today);
  return rows;
}

export async function pollAll({ db, client, routers, clock }) {
  const ok = [];
  const failed = [];
  const customers = {};
  // Sequential on purpose: these are the operator's own routers over a home uplink, and a
  // burst of parallel API logins is how you get RouterOS to start refusing them.
  for (const router of routers || []) {
    try {
      customers[router.id] = await pollRouter({ db, client, router, clock });
      ok.push(router.id);
    } catch (e) {
      // One unreachable router must not cost the others their refresh.
      failed.push({ id: router.id, error: (e && e.message) || String(e) });
    }
  }
  return { ok, failed, customers };
}
