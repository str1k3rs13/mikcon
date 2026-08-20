// The parser has had a parity test since Task 1. The PROJECTION did not, and that is where the
// divergence actually happened: agent/billing.js counted every PPPoE secret and every DHCP lease,
// while the shipped app drops disabled ones and requires a [bill ...] tag on a lease. On an
// ordinary router that made the agent report eleven customers where the app showed five - and the
// disabled rows still carried live tags, so it invented revenue nobody owed.
//
// Same technique as billing-parity.test.mjs: extract the REAL functions out of the shared UI,
// evaluate them, and run both projections over the same router rows. A divergence fails the build
// instead of inflating a bill.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { billableFrom } from "../agent/billing.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SHARED_UI = path.resolve(here, "..", "..", "juanfi-app", "www", "index.html");

function extractFunction(src, name) {
  const start = src.indexOf("function " + name + "(");
  if (start < 0) return null;
  const open = src.indexOf("{", start);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  return null;
}

// allIpoeClients is the app's whole IPoE projection. The PPPoE half lives inline in pppBills() and
// cannot be extracted as a function, so its one rule - drop a disabled secret - is applied here the
// way pppBills applies it, and pinned by a test below so it cannot drift silently either.
function loadTheirs() {
  const src = readFileSync(SHARED_UI, "utf8");
  const re = /var BILL_RE=[^\n]+/.exec(src);
  assert.ok(re, "could not find BILL_RE in the shared UI - the extractor needs updating");
  // Every function allIpoeClients reaches, not just the ones named in it: these are evaluated in a
  // bare scope, so a helper left out of this list is a ReferenceError at call time rather than a
  // missing-name assertion. rateGroups backs leaseRate/queueRate, and ipoeQueueIndex is what pairs
  // a lease-backed customer with the simple queue their speed now lives on.
  const names = ["parseBill", "isBilledLease", "isBilledQueue", "rateGroups", "leaseRate", "queueRate",
                 "planForRate", "ipoeQueueIndex", "ipoeClients", "ipoeQueueClients", "allIpoeClients"];
  const fns = names.map((n) => {
    const f = extractFunction(src, n);
    assert.ok(f, "could not find " + n + " in the shared UI - the extractor needs updating");
    return f;
  });
  return new Function(`${re[0]}\n${fns.join("\n")}\nreturn allIpoeClients;`)();
}

// An extractor that silently matched nothing would make every assertion below pass vacuously.
test("the extracted projection is real and behaves", () => {
  const theirs = loadTheirs();
  const got = theirs([{ "mac-address": "AA:BB", address: "10.0.0.7", comment: "[bill p=500]" }], [], [], {});
  assert.equal(got.length, 1, "the extracted allIpoeClients did not project a known lease");
  assert.equal(got[0].key, "AA:BB");
});

// The rule pppBills applies to secrets, pinned so a change to it is noticed here.
test("the shared UI still drops disabled PPPoE secrets", () => {
  const src = readFileSync(SHARED_UI, "utf8");
  const ppp = /var ppp=\(_sales&&_sales\.pppRows\|\|\[\]\)\.filter\(([^\n]+)\)/.exec(src);
  assert.ok(ppp, "pppBills no longer filters pppRows - the agent's secret rule may now be wrong");
  assert.match(ppp[1], /disabled/, "pppBills stopped filtering on disabled");
});

// A router that looks like a real one: paying customers, two people who left, and the DHCP noise
// every router carries. This is the corpus the divergence was measured on.
const LEASES = [
  { "mac-address": "AA:00:00:00:00:01", address: "10.0.0.21", "host-name": "dina-laptop",
    comment: "Dina Lim [bill p=600 c=monthly due=2026-09-05]" },
  { "mac-address": "AA:00:00:00:00:02", address: "10.0.0.22", "host-name": "eli-pc",
    comment: "Eli Tan [bill p=450 c=15d due=2026-08-20]" },
  // Left the service. The operator disabled the lease rather than deleting it, and the tag is still
  // on it - which is exactly why "disabled" has to be read.
  { "mac-address": "AA:00:00:00:00:03", address: "10.0.0.23", "host-name": "moved-out",
    disabled: "true", comment: "Old Tenant [bill p=600 c=monthly due=2026-07-01]" },
  // Ordinary DHCP noise. Nobody tagged these; they are not customers.
  { "mac-address": "BB:00:00:00:00:01", address: "10.0.0.150", "host-name": "iPhone", comment: "" },
  { "mac-address": "BB:00:00:00:00:02", address: "10.0.0.151", "host-name": "living-room-TV", comment: "" },
  // An absent disabled property means ENABLED. RouterOS omits it on some versions, and reading
  // that as "gone" would hide a real paying customer - the worse of the two errors.
  { "mac-address": "AA:00:00:00:00:04", address: "10.0.0.24", "host-name": "fely",
    comment: "Fely Uy [bill p=700 c=monthly due=2026-09-20]" },
];
const QUEUES = [
  { name: "fay-static", target: "10.0.0.31/32", "max-limit": "8M/8M", dynamic: "false",
    comment: "Fay Ong [bill p=800 c=monthly due=2026-09-10]" },
  { name: "dhcp1", target: "10.0.0.21/32", "max-limit": "10M/10M", dynamic: "true",
    comment: "Dina Lim [bill p=600 c=monthly due=2026-09-05]" },
  { name: "throttle-printer", target: "10.0.0.99/32", dynamic: "false", comment: "office printer" },
  { name: "hana-static", target: "10.0.0.34/32", comment: "Hana Diaz [bill p=800]" },
];
const SECRETS = [
  { name: "ana", comment: "Ana Cruz [bill p=750 c=monthly due=2026-09-01]" },
  // Untagged, but a secret IS a subscriber - one nobody has priced yet. The app keeps these.
  { name: "carl", comment: "Carl - not billed yet" },
  { name: "old-carl", disabled: "true", comment: "Carl (moved away) [bill p=500 c=monthly due=2026-06-01]" },
];

test("the agent's IPoE projection picks the same customers as the shared UI", () => {
  const theirs = loadTheirs();
  const app = theirs(LEASES, QUEUES, [], {}).map((c) => c.key).sort();
  const agent = billableFrom({ leases: LEASES, queues: QUEUES })
    .filter((r) => r.kind === "ipoe").map((r) => r.key).sort();
  assert.deepEqual(agent, app);
});

test("the agent's PPPoE projection picks the same secrets as the shared UI", () => {
  const app = SECRETS.filter((u) => String(u.disabled || "") !== "true").map((u) => u.name).sort();
  const agent = billableFrom({ secrets: SECRETS })
    .filter((r) => r.kind === "ppp").map((r) => r.key).sort();
  assert.deepEqual(agent, app);
});

// The headline the audit turned up, stated as a number so a regression is unmissable.
test("the agent's total matches the app's, rather than more than doubling it", () => {
  const theirs = loadTheirs();
  const app = theirs(LEASES, QUEUES, [], {}).length
            + SECRETS.filter((u) => String(u.disabled || "") !== "true").length;
  const agent = billableFrom({ secrets: SECRETS, leases: LEASES, queues: QUEUES }).length;
  assert.equal(agent, app, `the agent reports ${agent} customers where the app shows ${app}`);
});

// Money, not just headcount: a disabled row carries a live tag, so counting it invents revenue.
test("no disabled row contributes a price", () => {
  const rows = billableFrom({ secrets: SECRETS, leases: LEASES, queues: QUEUES });
  const total = rows.reduce((sum, r) => sum + (r.price || 0), 0);
  // ana 750 + fay 800 + hana 800 + dina 600 + eli 450 + fely 700; carl is 0. The two disabled rows
  // would have added 1100 between them.
  assert.equal(total, 4100, "expected revenue includes a customer who is no longer connected");
  assert.equal(rows.find((r) => r.key === "AA:00:00:00:00:03"), undefined, "a disabled lease was billed");
  assert.equal(rows.find((r) => r.key === "old-carl"), undefined, "a disabled secret was billed");
});
