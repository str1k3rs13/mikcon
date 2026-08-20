// Live-router shakedown for the payment-approval RECONNECT path.
//
// The one part of the GCash payment-reminder feature that has never touched real hardware is the
// router reconnect that an approval triggers (see the "NOT hardware-verified" note atop
// main/pay-bot.js). This script drives the EXACT production code — main/pay-bot.js's makeReconnector
// over agent/pay-approve.js's applyApproval — against a real RouterOS box, so the commands under
// test are the ones that actually ship, not a copy that could drift.
//
// SAFE BY DEFAULT: it is a DRY RUN unless you pass --commit. In dry-run it still performs the READ
// commands against the router (so it shows you the real .ids, leases, NO-PAY entries and queues it
// WOULD act on), but every write (/set, /remove, /add) is printed and withheld. Point it at a
// DEDICATED test secret / lease the first time.
//
// PPPoE:  node scripts/reconnect-shakedown.mjs --host 10.0.0.1 --user admin --pass secret \
//           --kind ppp --key test-client --profile default
// IPoE :  node scripts/reconnect-shakedown.mjs --host 10.0.0.1 --user admin --pass secret \
//           --kind ipoe --key AA:BB:CC:00:00:21        (MAC — or pass an IP directly)
// Add --commit to actually reconnect (enable the PPP secret / clear NO-PAY). Add --tls (and usually
// --port 8729) for the TLS API. --help for the full flag list.
import { exec as realExec } from "../main/routeros.js";
import { makeReconnector } from "../main/pay-bot.js";
import { applyApproval } from "../agent/pay-approve.js";

function parseArgs(argv) {
  const a = { port: 0, kind: "", key: "", profile: "", amount: 100, price: 0, bal: 0,
    due: "", phone: "", tls: false, commit: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const next = () => argv[++i];
    switch (t) {
      case "--help": case "-h": a.help = true; break;
      case "--tls": a.tls = true; break;
      case "--commit": a.commit = true; break;
      case "--host": a.host = next(); break;
      case "--port": a.port = Number(next()) || 0; break;
      case "--user": a.user = next(); break;
      case "--pass": a.pass = next(); break;
      case "--fp": a.fp = next(); break;
      case "--kind": a.kind = String(next() || "").toLowerCase(); break;
      case "--key": a.key = next(); break;
      case "--address": a.address = next(); break;
      case "--profile": a.profile = next(); break;
      case "--amount": a.amount = Number(next()) || 0; break;
      case "--price": a.price = Number(next()) || 0; break;
      case "--bal": a.bal = Number(next()) || 0; break;
      case "--due": a.due = next(); break;
      case "--phone": a.phone = next(); break;
      default: console.error("unknown arg: " + t); a.help = true;
    }
  }
  return a;
}

const USAGE = `reconnect-shakedown — verify the approval reconnect path against a real router.

Required: --host --user --pass --kind ppp|ipoe --key <secret-name | MAC | IP>
Optional: --port (default 8728, or 8729 with --tls) --tls --fp <sha256> --profile <ppp profile>
          --address <ip> (ipoe, if key is a MAC and you want to skip lease lookup)
          --amount --price --bal --due YYYY-MM-DD --phone  (only shape the [bill] comment)
          --commit  ACTUALLY perform the reconnect (default is a dry run: reads real, writes withheld)

The first run should target a DEDICATED test secret/lease. Dry-run shows exactly what --commit would do.`;

function today() { return new Date().toISOString().slice(0, 10); }

// Wrap exec so reads reach the router (reconnect needs the real rows) but writes are withheld unless
// --commit. A print/getall is a read; anything ending /set, /remove or /add is a write.
function wrapExec(commit) {
  const trace = [];
  const isWrite = (cmd) => /\/(set|remove|add)$/.test(String(cmd || ""));
  const wrapped = async (o) => {
    const write = isWrite(o.cmd);
    const payload = JSON.stringify(o.attrs || o.queries || {});
    if (write && !commit) {
      console.log("  WOULD WRITE  " + o.cmd + "  " + payload + "   (withheld — dry run)");
      trace.push({ cmd: o.cmd, write: true, sent: false });
      return []; // reconnectOnRouter ignores a write's return value
    }
    console.log((write ? "  WRITE        " : "  read         ") + o.cmd + "  " + payload);
    const res = await realExec(o);
    trace.push({ cmd: o.cmd, write, sent: true, rows: Array.isArray(res) ? res.length : undefined });
    return res;
  };
  wrapped.trace = trace;
  return wrapped;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help || !a.host || !a.user || a.pass == null || !a.kind || !a.key) {
    console.log(USAGE);
    process.exit(a.help ? 0 : 2);
  }
  if (a.kind !== "ppp" && a.kind !== "ipoe") { console.error("--kind must be ppp or ipoe"); process.exit(2); }

  const port = a.port || (a.tls ? 8729 : 8728);
  const router = { host: a.host, port, user: a.user, pass: a.pass, tls: a.tls, tlsFingerprint: a.fp || "" };

  // Synthesize the customer + request the way the app would have them at approval time, then run the
  // REAL pure approval logic to get the reconnect intent + [bill] comment that ships.
  const customer = {
    kind: a.kind, key: a.key, address: a.address || "", plan: a.profile || "",
    price: a.price, bal: a.bal, cycle: "monthly", due: a.due || today(), paid: "",
    phone: a.phone || "", raw_comment: "", router_id: "shakedown",
  };
  const request = { ref: "SHAKEDOWN-" + Date.now(), amount: a.amount };
  const outcome = applyApproval({ request, customer, today: today() });

  console.log("=== reconnect shakedown ===");
  console.log("router      : " + a.host + ":" + port + (a.tls ? " (TLS)" : "") + " as " + a.user);
  console.log("target      : " + a.kind + " / " + a.key + (a.profile ? " -> profile " + a.profile : ""));
  console.log("mode        : " + (a.commit ? "COMMIT (writes WILL be sent)" : "DRY RUN (writes withheld)"));
  console.log("bill comment: " + outcome.comment);
  console.log("reconnect   : " + JSON.stringify(outcome.reconnect));
  console.log("--- router exchange ---");

  const exec = wrapExec(a.commit);
  const reconnectOnRouter = makeReconnector(exec);
  try {
    await reconnectOnRouter(router, outcome);
  } catch (e) {
    console.log("--- FAILED ---");
    console.error("reconnect threw: " + (e && e.message || e));
    console.error("(a read that failed here means the router/credentials/target are wrong, or the " +
      "secret/lease does not exist — nothing was reconnected.)");
    process.exit(1);
  }

  const writes = exec.trace.filter((t) => t.write);
  console.log("--- OK ---");
  console.log("reads: " + exec.trace.filter((t) => !t.write).length +
    "   writes: " + writes.length + (a.commit ? " (sent)" : " (withheld)"));
  if (!a.commit && writes.length) {
    console.log("Re-run with --commit to actually reconnect. Confirm on the router afterward:");
    if (a.kind === "ppp") console.log("  /ppp/secret/print where name=\"" + a.key + "\"   (disabled=no, the new comment)");
    else console.log("  /ip/firewall/address-list/print where list=NO-PAY   (the address should be gone)");
  }
}

main();
