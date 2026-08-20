// A mock RouterOS 7 router that speaks the real binary API over a real TCP socket.
//
// This exists for the one thing no unit test can prove: that the rules in agent/billing.js hold
// against the SHAPE RouterOS actually returns, rather than against the hand-written arrays the
// unit tests feed them. The plan gates the Stage 3 merge on driving the build against a real
// router; this narrows what that check has left to find, it does not replace it - see the header
// of routeros7-integration.test.mjs for what a mock still cannot tell you.
//
// What is modelled from real v7 behaviour, and why each detail earns its place:
//
//   - Login is the post-6.43 single sentence: /login with =name= and =password=, answered !done
//     with NO =ret=. A v6.42 router answers with a =ret= challenge, and main/routeros.js still
//     handles that; replying the v7 way is what makes this a v7 mock.
//   - Booleans are the STRINGS "true"/"false", never JSON booleans.
//   - RouterOS builds a DYNAMIC simple queue for every rate-limited connection. A PPPoE session
//     gets one named <pppoe-USER>; a DHCP lease with a rate-limit gets one too. This is the
//     double-count trap the whole dynamic filter exists for, so the fleet below fires it on both
//     technologies at once.
//   - Some static queues carry =dynamic=false and some OMIT the property entirely. Both occur in
//     the field across versions, and "absent means static" is exactly what
//     String((q&&q.dynamic)||"") !== "true" is written to preserve.
//   - .proplist is honoured, because the poller sends one for the queue read. A mock that ignored
//     it would hide a proplist that forgot to ask for "dynamic".
//   - .id values look like *1, *A, *1F - RouterOS hex ids, not integers.
import net from "node:net";
import { encodeSentence, readLen } from "../../main/routeros-framing.js";

// A small ISP's router, built so that a naive projection double-counts and a correct one does not.
//
// Eight paying customers:
//   PPPoE   ana, ben, carl          (carl is untagged - a customer with no price, not a non-customer)
//   DHCP    dina, eli               (both rate-limited, so both have a dynamic queue shadowing them)
//   Static  fay, gil, hana          (queues are their only record; hana's queue omits =dynamic=)
export const FLEET = {
  secrets: [
    { ".id": "*1", name: "ana", service: "pppoe", profile: "default",
      comment: "Ana Cruz [bill p=750 c=monthly due=2026-09-01 ph=09171234567 plan=Fibre 20 Mbps]" },
    { ".id": "*2", name: "ben", service: "pppoe", profile: "expired",
      comment: "Ben Reyes [bill p=500 c=monthly due=2026-08-01 bal=200 plan=Home 10 Mbps]" },
    { ".id": "*3", name: "carl", service: "pppoe", profile: "default", comment: "Carl - not billed yet" },
  ],
  leases: [
    { ".id": "*4", address: "10.0.0.21", "mac-address": "AA:BB:CC:00:00:21", "host-name": "dina-laptop",
      status: "bound", "rate-limit": "10M/10M", comment: "Dina Lim [bill p=600 c=monthly due=2026-09-05]" },
    { ".id": "*5", address: "10.0.0.22", "mac-address": "AA:BB:CC:00:00:22", "host-name": "eli-pc",
      status: "bound", "rate-limit": "5M/5M", comment: "Eli Tan [bill p=450 c=15d due=2026-08-20]" },
  ],
  queues: [
    // Dynamic shadows. RouterOS creates these itself; counting them is the doubling bug.
    { ".id": "*A", name: "<pppoe-ana>", target: "10.0.0.11/32", "max-limit": "20M/20M",
      comment: "", dynamic: "true" },
    { ".id": "*B", name: "<pppoe-ben>", target: "10.0.0.12/32", "max-limit": "10M/10M",
      comment: "", dynamic: "true" },
    { ".id": "*C", name: "<pppoe-carl>", target: "10.0.0.13/32", "max-limit": "10M/10M",
      comment: "", dynamic: "true" },
    // A dynamic queue that INHERITED the lease's comment, tag and all. RouterOS copies the comment
    // onto the queue it builds for a rate-limited lease, so the tag alone cannot tell these apart
    // from a real customer - only =dynamic=true can.
    { ".id": "*D", name: "dhcp1", target: "10.0.0.21/32", "max-limit": "10M/10M",
      comment: "Dina Lim [bill p=600 c=monthly due=2026-09-05]", dynamic: "true" },
    { ".id": "*E", name: "dhcp2", target: "10.0.0.22/32", "max-limit": "5M/5M",
      comment: "Eli Tan [bill p=450 c=15d due=2026-08-20]", dynamic: "true" },
    // Real static customers: the queue IS the record, because a static device reports no MAC.
    { ".id": "*F", name: "fay-static", target: "10.0.0.31/32", "max-limit": "8M/8M",
      comment: "Fay Ong [bill p=800 c=monthly due=2026-09-10 plan=Business 8 Mbps]", dynamic: "false" },
    { ".id": "*10", name: "gil-static", target: "10.0.0.32,10.0.0.33/32", "max-limit": "8M/8M",
      comment: "Gil Ramos [bill p=800 c=monthly due=2026-09-12]", dynamic: "false" },
    // No =dynamic= property at all. Absent must mean static, or Hana silently stops being a customer.
    { ".id": "*11", name: "hana-static", target: "10.0.0.34/32", "max-limit": "8M/8M",
      comment: "Hana Diaz [bill p=800 c=monthly due=2026-09-15]" },
    // An untagged static queue is a QoS rule, not a person. It must not become a customer.
    { ".id": "*12", name: "throttle-printer", target: "10.0.0.99/32", "max-limit": "1M/1M",
      comment: "office printer - keep it off the uplink", dynamic: "false" },
  ],
};

export const CUTOFF_SCRIPT_V2 = [
  "# MIKCON-CUTOFF-V2",
  ':local expProf "expired"',
  ":local grace 3",
  ":local dry false",
  "# ... the rest of the shipped script ...",
].join("\r\n");   // RouterOS stores script sources with CRLF

export const CUTOFF_SCRIPT_V1 = [
  "# MIKCON-CUTOFF-V1",
  ':local expProf "expired"',
  ":local grace 5",
  ":local dry false",
].join("\r\n");

// Builds one router. `state` chooses what the cut-off reads answer, so a fleet can mix healthy and
// broken routers in a single test.
export function routerOS7({
  fleet = FLEET,
  script = CUTOFF_SCRIPT_V2,        // null = no mikcon-cutoff script installed
  scheduler = { ".id": "*20", name: "mikcon-cutoff", interval: "1d", "on-event": "mikcon-cutoff" },
  user = "admin",
  pass = "s3cret",
  onCommand = () => {},
} = {}) {
  const rows = (cmd) => {
    switch (cmd) {
      case "/ppp/secret/print": return fleet.secrets;
      case "/ip/dhcp-server/lease/print": return fleet.leases;
      case "/queue/simple/print": return fleet.queues;
      case "/system/script/print":
        return script ? [{ ".id": "*1E", name: "mikcon-cutoff", owner: "admin", source: script }] : [];
      case "/system/scheduler/print": return scheduler ? [scheduler] : [];
      default: return null;         // an unknown command is a !trap, as on a real router
    }
  };

  const sockets = new Set();
  const srv = net.createServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    let authed = false;
    let buf = Buffer.alloc(0);
    let words = [];

    const send = (w) => sock.write(encodeSentence(w));

    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      let pos = 0;
      while (true) {
        const L = readLen(buf, pos);
        if (!L || L.next + L.len > buf.length) break;
        if (L.len === 0) {
          handle(words);
          words = [];
        } else {
          words.push(buf.subarray(L.next, L.next + L.len).toString("utf8"));
        }
        pos = L.next + L.len;
      }
      buf = buf.subarray(pos);
    });

    function handle(w) {
      const cmd = w[0];
      const attr = (k) => {
        const hit = w.find((x) => x.startsWith("=" + k + "="));
        return hit === undefined ? undefined : hit.slice(k.length + 2);
      };
      const tagWord = w.find((x) => x.startsWith(".tag="));
      const tag = tagWord ? [tagWord] : [];
      onCommand({ cmd, words: w });

      if (cmd === "/login") {
        // v7: one sentence in, !done out. No =ret= challenge - that is the v6.42 path.
        if (attr("name") === user && attr("password") === pass) { authed = true; send(["!done", ...tag]); }
        else send(["!trap", "=message=cannot log in", ...tag]), send(["!done", ...tag]);
        return;
      }
      if (!authed) { send(["!trap", "=message=not logged in", ...tag]); send(["!done", ...tag]); return; }

      const data = rows(cmd);
      if (data === null) {
        send(["!trap", "=message=no such command prefix", ...tag]);
        send(["!done", ...tag]);
        return;
      }
      // .proplist narrows which properties come back, exactly as on a real router. A proplist that
      // forgets a field means that field is simply absent from every row.
      const proplist = attr(".proplist");
      const keep = proplist ? proplist.split(",").filter(Boolean) : null;
      for (const row of data) {
        const out = ["!re", ...tag];
        for (const [k, v] of Object.entries(row)) {
          if (keep && !keep.includes(k)) continue;
          out.push("=" + k + "=" + v);
        }
        send(out);
      }
      send(["!done", ...tag]);
    }
  });
  srv._mikconSockets = sockets;
  return srv;
}

// Starts one on an ephemeral port and hands back {port, close}.
export async function startRouterOS7(opts = {}) {
  const srv = routerOS7(opts);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return {
    port: srv.address().port,
    close: () => new Promise((r) => {
      // A pooled API client keeps the TCP session open. server.close() will not
      // finish until those sockets drop, so tear them down the way a powered-off
      // router would.
      for (const s of srv._mikconSockets || []) {
        try { s.destroy(); } catch {}
      }
      srv.close(r);
    }),
  };
}
