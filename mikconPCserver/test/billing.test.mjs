import { test } from "node:test";
import assert from "node:assert/strict";
import { billableFrom } from "../agent/billing.js";

const keys = (rows) => rows.map((r) => `${r.kind}/${r.src}/${r.key}`).sort();

// THE test of this stage. RouterOS builds a dynamic simple queue for every rate-limited lease, so
// a naive /queue/simple read finds each DHCP customer a second time. Counting them twice does not
// throw, does not look wrong in the database, and doubles every aging figure the operator sees.
test("a lease and its own dynamic queue are ONE customer", () => {
  const rows = billableFrom({
    leases: [{ "mac-address": "AA:BB:CC:DD:EE:FF", comment: "[bill p=750]", address: "10.0.0.7" }],
    queues: [{ name: "dhcp-10.0.0.7", target: "10.0.0.7/32", comment: "[bill p=750]", dynamic: "true" }],
  });
  assert.equal(rows.length, 1, "the dynamic queue was counted as a second customer");
  assert.deepEqual(keys(rows), ["ipoe/lease/AA:BB:CC:DD:EE:FF"]);
});

// A STATIC queue is a real, separately-billed customer: someone on a fixed IP with no DHCP lease.
test("a static billed queue is a customer in its own right", () => {
  const rows = billableFrom({
    queues: [{ name: "shop", target: "10.0.0.50/32", comment: "[bill p=1200 c=monthly]", dynamic: "false" }],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, "10.0.0.50");
  assert.equal(rows[0].src, "queue");
  assert.equal(rows[0].kind, "ipoe");
  assert.equal(rows[0].price, 1200);
});

// RouterOS omits a false flag entirely on some versions. Absent must mean static, not dynamic.
test("a queue with no dynamic property at all is treated as static", () => {
  const rows = billableFrom({ queues: [{ target: "10.0.0.51/32", comment: "[bill p=300]" }] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, "10.0.0.51");
});

// A SECRET is a subscriber whether or not anyone has priced them yet - an untagged one is a
// customer with no price. A LEASE is not: every phone, TV and guest laptop on the network has one,
// so the tag is what separates a customer from the DHCP table's ordinary traffic. A QUEUE without
// a tag is a QoS rule. These are the shared UI's own three rules; billing-projection-parity
// asserts they still are, because this test alone would let both sides drift together.
//
// The earlier version of this test asserted that EVERY secret and lease is a customer. That was
// wrong against the app, and made the agent report eleven customers on a router showing five.
test("a secret needs no tag, but a lease does, and so does a queue", () => {
  const rows = billableFrom({
    secrets: [{ name: "ana", comment: "" }],
    leases: [{ "mac-address": "AA:BB", comment: "" },
             { "mac-address": "CC:DD", comment: "Bea [bill p=500]" }],
    queues: [{ target: "10.0.0.9/32", comment: "throttle the printer", dynamic: "false" }],
  });
  assert.deepEqual(keys(rows), ["ipoe/lease/CC:DD", "ppp/secret/ana"]);
  assert.equal(rows.find((r) => r.key === "ana").price, 0);
});

// Disabled is the router saying the service is over. The tag usually stays on the row, so reading
// the tag without reading this bills someone who is no longer connected - and then texts them
// about it. The app hit that and fixed it; the agent must not relearn it.
test("a disabled secret or lease is not a customer, tag or no tag", () => {
  const rows = billableFrom({
    secrets: [{ name: "gone", disabled: "true", comment: "Moved away [bill p=500]" },
              { name: "here", disabled: "false", comment: "[bill p=750]" }],
    leases: [{ "mac-address": "AA:BB", disabled: "true", comment: "Old tenant [bill p=600]" },
             { "mac-address": "CC:DD", comment: "Bea [bill p=450]" }],
  });
  assert.deepEqual(keys(rows), ["ipoe/lease/CC:DD", "ppp/secret/here"]);
  assert.equal(rows.reduce((s, r) => s + r.price, 0), 1200, "a disconnected customer was billed");
});

// RouterOS omits the flag entirely on some versions. Absent must mean ENABLED - hiding a paying
// customer is the worse of the two errors.
test("a row with no disabled property at all is enabled", () => {
  const rows = billableFrom({
    secrets: [{ name: "ana", comment: "[bill p=750]" }],
    leases: [{ "mac-address": "AA:BB", comment: "[bill p=600]" }],
  });
  assert.equal(rows.length, 2);
});

// target is "10.0.0.7/32" or a comma list. The address is the billing identity for a static
// customer, since such a device reports no MAC to the router unless it happens to be in ARP.
test("a queue key is the first target, with the mask stripped", () => {
  const rows = billableFrom({
    queues: [{ target: "10.0.0.7/32,10.0.0.8/32", comment: "[bill p=500]", dynamic: "false" }],
  });
  assert.equal(rows[0].key, "10.0.0.7");
});

// The case above cannot tell the comma from the mask: its first entry carries a /32, so stripping
// the mask alone already yields the right answer and the comma split goes unexercised. RouterOS
// accepts a bare address in a target list, and there the two come apart - dropping the comma split
// keys the customer as "10.0.0.7,10.0.0.8", which is not an identity anything can match on later.
// Found by a mutation that survived the test above.
test("a comma list whose first target carries no mask still keys on that first address", () => {
  const rows = billableFrom({
    queues: [{ target: "10.0.0.7,10.0.0.8/32", comment: "[bill p=500]", dynamic: "false" }],
  });
  assert.equal(rows[0].key, "10.0.0.7");
});

// No identity means no row. Storing these under "" would collide every such record onto one.
test("rows with no usable identity are skipped", () => {
  const rows = billableFrom({
    secrets: [{ name: "", comment: "[bill p=500]" }],
    leases: [{ "mac-address": "", comment: "[bill p=500]" }, { address: "10.0.0.5" }],
    queues: [{ target: "", comment: "[bill p=500]", dynamic: "false" },
             { comment: "[bill p=500]", dynamic: "false" }],
  });
  assert.deepEqual(rows, []);
});

test("the parsed fields land on the row, and the raw tag is kept beside them", () => {
  const rows = billableFrom({
    secrets: [{ name: "ana", comment: "Ana Cruz [bill p=500 c=15d due=2026-09-01 paid=2026-08-01 bal=100 ph=09171234567 plan=Fibre 20 Mbps]" }],
  });
  const r = rows[0];
  assert.equal(r.price, 500);
  assert.equal(r.cycle, "15d");
  assert.equal(r.due, "2026-09-01");
  assert.equal(r.paid, "2026-08-01");
  assert.equal(r.bal, 100);
  assert.equal(r.phone, "09171234567");
  assert.equal(r.plan, "Fibre 20 Mbps");
  assert.equal(r.name, "Ana Cruz");
  assert.match(r.raw_comment, /^Ana Cruz \[bill /, "the tag must be kept verbatim as evidence");
});

// A row with no human text in its comment still needs something to show.
test("a name falls back to the source's own label", () => {
  const rows = billableFrom({
    secrets: [{ name: "ana", comment: "[bill p=500]" }],
    leases: [{ "mac-address": "AA:BB", "host-name": "sala-tv", comment: "[bill p=1]" }],
    queues: [{ name: "shop", target: "10.0.0.50/32", comment: "[bill p=1]", dynamic: "false" }],
  });
  const by = (k) => rows.find((r) => r.key === k).name;
  assert.equal(by("ana"), "ana");
  assert.equal(by("AA:BB"), "sala-tv");
  assert.equal(by("10.0.0.50"), "shop");
});

test("a tagged row with w= surfaces wallet on the billable customer", () => {
  const rows = billableFrom({
    secrets: [{ name: "ana", comment: "Ana [bill p=750 c=monthly due=2026-08-18 w=1500 plan=Fibre 20]" }],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].wallet, 1500);
});

test("missing source arrays are not an error", () => {
  assert.deepEqual(billableFrom({}), []);
  assert.deepEqual(billableFrom(), []);
});
