import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import tls from "node:tls";
import crypto from "node:crypto";
import { normalizeFingerprint, exec, closeSessions, sessionCount } from "../main/routeros.js";
import { encodeSentence, readLen } from "../main/routeros-framing.js";

const CERT = `-----BEGIN CERTIFICATE-----
MIIDCTCCAfGgAwIBAgIUVWY5SzzLTcaKecE4ZGmBLXikTzowDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDcyOTExMjIwNFoXDTM2MDcy
NjExMjIwNFowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAtgyocNYKkncRLK/JEWPUIaKBCefGHy3HiE112LC2jzaL
HpslFpDPmRLupeWLw1iOJx81Z3I/28znl612/y5DsPC7YupjhXwF0CY6yPK2S+sW
2o7b/T23yfIT1m5EsvIFkMtdiBvhfe0aP6kjfHGTyXai09z929I7jjV3Z9kGjdTt
Dy63wbebeYqJt84DqIB1dM1YDkHFKg4T4lfVwd9y8gWcI0DaCdin6iDLReyCLzrt
KlaXqxSLBVS7y278omsQGx3WZ/XKThgmICvLYmj984EXs/a6DjiwyY6dyOSYrSM8
z0ctOSdBxLNs6Sb2ilEOV1bm6NYE7Qxqyc2STz2zKwIDAQABo1MwUTAdBgNVHQ4E
FgQUXXSQZOeO+Z/jCNvP98NoWYUXT1gwHwYDVR0jBBgwFoAUXXSQZOeO+Z/jCNvP
98NoWYUXT1gwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAUFcm
1aZSc6ro3UnRYloAlz0JaIMnpR1oXPj819y3a6nOLpzhhXatdQfN7Uds23ewUtDH
/Ete5vSUE4gyaoTJOZ/DSo72OZ6BKr5AKL/c3Pj+JNqDbgGisJWJI9j0QosI5XmY
02r2Ze24zeO5pO50kxlI0p9inMUZQNK8dJnlVQJZ5DzJhHACkuarJP1GQEksTJvC
9biFVWV4NLWkKuQoDQYcMCFA/iIyStjtt/cnxCgk4PyFtDxS28T1oDVSWj3EoG2n
YQFLAhup9BakbvK8a+1t0VO62r5oARkVBmjJaDkwVuCyAf5/h+p/d7pnVbNKNqWg
6+VM+pPgc4QVKt381g==
-----END CERTIFICATE-----`;

const KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC2DKhw1gqSdxEs
r8kRY9QhooEJ58YfLceITXXYsLaPNosemyUWkM+ZEu6l5YvDWI4nHzVncj/bzOeX
rXb/LkOw8Lti6mOFfAXQJjrI8rZL6xbajtv9PbfJ8hPWbkSy8gWQy12IG+F97Ro/
qSN8cZPJdqLT3P3b0juONXdn2QaN1O0PLrfBt5t5iom3zgOogHV0zVgOQcUqDhPi
V9XB33LyBZwjQNoJ2KfqIMtF7IIvOu0qVperFIsFVLvLbvyiaxAbHdZn9cpOGCYg
K8tiaP3zgRez9roOOLDJjp3I5JitIzzPRy05J0HEs2zpJvaKUQ5XVubo1gTtDGrJ
zZJPPbMrAgMBAAECggEAJmhMPyYBK/5fyrg5aOhRUFlK9Q6Hf3t2jbyd4L4Dffpp
Zmcf739UtPxICgsALhHoR7uvVihF7bbwo1Du+o5FrLZVKly962MLjOsL2upN6H1s
IGckZWyYckwWwFYaO1CROQeWr4kGTT1xHL4v5OjHX6keWClXC4Hym6GPFAM2/UPz
Me6msXvd9SgNOaUso22WxkrWPVw/MxHuPmxsPQzwK+hOWbxe08izEdXlfV8sQBrO
tSv4FngPQULvhiuLAq0vqLdh4JYNEOJNfPK6NUX3JBPPkBtvjWEvqx0BGsa1v6NK
zhMT/27q9Hoiq/BBqdpZjub6xBol9lfa0ycFhGYw4QKBgQD662qiZ182/UpsruMC
1jLsutuGbZxQL+8H2VGDLT+1a5xjyF9cjMM4nJ9hqHcZoUXgC+w7PaJd4W46CtsX
eyoRWop5dP49XJJy4QgTTDQN38Ghp8xEOf7u1VBnh83jLtnkxtU1oCTmFXL2WMXA
TMq3BoLjrQPpszGbtXHGb/gwiwKBgQC5vETdBJwTaDBnzgErfOEA8DOE89qOrfKM
m3ekRR3X0ccFwJSfkBuJyb4xHG7CW3Jf6OdCc67RkUjV65ZTl55qnTq6rsbmLbLx
wirakjyYbO+1hOAjLkKuWaga/EfPjAYk5YS7IH7bMPVJ7oo6+AvdaD1ql9VdI+Fv
KVuNcyE74QKBgCMnpJMIZKCxsCG2Bvw4wn3EWElnRgU+EgFJg1AboNdsMkcQpbuz
xQ5Dc1kdX0JqA/417W0HX55DnUvohXWuveAcjVYi/BPgymvp91Ws0YY4GUrq1YWh
koQnwtIehswTnledO/X9b+4Eh0zYdyxQFf66nNAFR40QnByyuTQSL/WtAoGAK9H1
VUfPIu0D7pm1wPLXiwcgwI9f0yXLAc10Lrd30QFXOU40QmkXdiy4yJFyuDwnAeXL
Gex9JEhorL/GWbZ9052Ay6aMmqXRgCRVQ/gYf8XD0EmnL+WsKcJRXPyEXL0mffIA
nL2P8FrepDC5QCxhcD01sD5eQnlCqJ1TUk4FW0ECgYEAx+NjpETq6fwgvpNR4jPT
2E8JPm66E1E9HtktXZmVSTYtWQSrhLZ+6ygPMUfPxsUkkqR/NtchPvMX25dl04jF
vdxPrObrKyTQ1Fo/RN7to2/fS5pKn+nqE6VKEeQm5CiivqRr3xER+aEkKsvo/O/L
EPxDDE+i6GPKECM2Z4FB3Xc=
-----END PRIVATE KEY-----`;

test("normalizeFingerprint accepts a valid sha256 and strips separators", () => {
  const hex = "a".repeat(64);
  assert.equal(normalizeFingerprint("AA:" + hex.slice(2)), hex);
});
test("normalizeFingerprint rejects wrong length", () => {
  assert.throws(() => normalizeFingerprint("abcd"));
});
test("normalizeFingerprint rejects bad characters and CRLF injection", () => {
  assert.throws(() => normalizeFingerprint("zz" + "a".repeat(62)));
  assert.throws(() => normalizeFingerprint("a".repeat(64) + "\n"));
});

// A minimal fake router: accepts /login (plaintext), answers a print with one row.
function fakeRouter() {
  return net.createServer((sock) => {
    let buf = Buffer.alloc(0), words = [];
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      let pos = 0;
      while (true) {
        const L = readLen(buf, pos);
        if (!L || L.next + L.len > buf.length) break;
        if (L.len === 0) {
          const cmd = words[0];
          if (cmd === "/login") sock.write(encodeSentence(["!done"]));
          else if (cmd === "/ip/hotspot/user/print") {
            sock.write(encodeSentence(["!re", "=name=v-01", ".tag=" + tagOf(words)]));
            sock.write(encodeSentence(["!done", ".tag=" + tagOf(words)]));
          } else sock.write(encodeSentence(["!done", ".tag=" + tagOf(words)]));
          words = [];
        } else words.push(buf.subarray(L.next, L.next + L.len).toString("utf8"));
        pos = L.next + L.len;
      }
      buf = buf.subarray(pos);
    });
  });
}
function tagOf(words) { const t = words.find((w) => w.startsWith(".tag=")); return t ? t.slice(5) : "1"; }

test("exec logs in and returns rows from a fake router (plain TCP)", async () => {
  const srv = fakeRouter();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  try {
    const rows = await exec({
      host: "127.0.0.1", port, user: "admin", pass: "x", tls: false,
      cmd: "/ip/hotspot/user/print", attrs: {}, queries: {},
      timeout: 2000, connectTimeout: 2000, retries: 1,
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, "v-01");
  } finally { srv.close(); }
});

test("exec rejects an invalid host without connecting", async () => {
  await assert.rejects(() => exec({ host: "bad\r\nhost", port: 8728, cmd: "/x", timeout: 500, connectTimeout: 500, retries: 1 }));
});

// A TLS fake router: like fakeRouter but with TLS handshake.
function tlsRouter() {
  return tls.createServer({ key: KEY, cert: CERT }, (sock) => {
    let buf = Buffer.alloc(0), words = [];
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      let pos = 0;
      while (true) {
        const L = readLen(buf, pos);
        if (!L || L.next + L.len > buf.length) break;
        if (L.len === 0) {
          const cmd = words[0];
          if (cmd === "/login") sock.write(encodeSentence(["!done"]));
          else if (cmd === "/ip/hotspot/user/print") {
            sock.write(encodeSentence(["!re", "=name=v-tls", ".tag=" + tagOf(words)]));
            sock.write(encodeSentence(["!done", ".tag=" + tagOf(words)]));
          } else sock.write(encodeSentence(["!done", ".tag=" + tagOf(words)]));
          words = [];
        } else words.push(buf.subarray(L.next, L.next + L.len).toString("utf8"));
        pos = L.next + L.len;
      }
      buf = buf.subarray(pos);
    });
  });
}

test("exec with TLS and correct pin resolves and returns rows", async () => {
  const srv = tlsRouter();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  try {
    const cert = new crypto.X509Certificate(CERT);
    const pin = crypto.createHash("sha256").update(cert.raw).digest("hex");
    const rows = await exec({
      host: "127.0.0.1", port, user: "admin", pass: "x", tls: true, tlsFingerprint: pin,
      cmd: "/ip/hotspot/user/print", attrs: {}, queries: {},
      timeout: 2000, connectTimeout: 2000, retries: 1,
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, "v-tls");
  } finally { srv.close(); }
});

test("exec with TLS and wrong pin rejects with fingerprint error", async () => {
  const srv = tlsRouter();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  try {
    const cert = new crypto.X509Certificate(CERT);
    const pin = crypto.createHash("sha256").update(cert.raw).digest("hex");
    const wrongPin = (pin[0] === "a" ? "b" : "a") + pin.slice(1);
    await assert.rejects(
      () => exec({
        host: "127.0.0.1", port, user: "admin", pass: "x", tls: true, tlsFingerprint: wrongPin,
        cmd: "/ip/hotspot/user/print", attrs: {}, queries: {},
        timeout: 2000, connectTimeout: 2000, retries: 1,
      }),
      /fingerprint/i
    );
  } finally { srv.close(); }
});

test("exec with TLS and no fingerprint rejects self-signed certificate", async () => {
  const srv = tlsRouter();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  try {
    await assert.rejects(
      () => exec({
        host: "127.0.0.1", port, user: "admin", pass: "x", tls: true,
        cmd: "/ip/hotspot/user/print", attrs: {}, queries: {},
        timeout: 2000, connectTimeout: 2000, retries: 1,
      })
    );
  } finally { srv.close(); }
});

// A fake router that demands the legacy MD5-challenge login handshake: the first
// /login gets a challenge back (=ret=<32 hex>), and only a second /login carrying
// =response= is accepted.
test("exec logs in via legacy MD5 challenge when the router demands it", async () => {
  const state = { sawResponse: false };
  const srv = net.createServer((sock) => {
    let buf = Buffer.alloc(0), words = [];
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      let pos = 0;
      while (true) {
        const L = readLen(buf, pos);
        if (!L || L.next + L.len > buf.length) break;
        if (L.len === 0) {
          const cmd = words[0];
          const tag = tagOf(words);
          if (cmd === "/login") {
            if (words.some((w) => w.startsWith("=response="))) {
              state.sawResponse = true;
              sock.write(encodeSentence(["!done", ".tag=" + tag]));
            } else {
              sock.write(encodeSentence(["!done", "=ret=a1b2c3d4e5f60718a1b2c3d4e5f60718", ".tag=" + tag]));
            }
          } else if (cmd === "/ip/hotspot/user/print") {
            sock.write(encodeSentence(["!re", "=name=v-md5", ".tag=" + tag]));
            sock.write(encodeSentence(["!done", ".tag=" + tag]));
          } else {
            sock.write(encodeSentence(["!done", ".tag=" + tag]));
          }
          words = [];
        } else words.push(buf.subarray(L.next, L.next + L.len).toString("utf8"));
        pos = L.next + L.len;
      }
      buf = buf.subarray(pos);
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  try {
    const rows = await exec({
      host: "127.0.0.1", port, user: "admin", pass: "x", tls: false,
      cmd: "/ip/hotspot/user/print", attrs: {}, queries: {},
      timeout: 2000, connectTimeout: 2000, retries: 1,
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, "v-md5");
    assert.equal(state.sawResponse, true);
  } finally { srv.close(); }
});

// A fake router that traps a duplicate /ip/hotspot/user/add. Retries only wrap the
// connect/handshake step, so a trapped command must never be replayed.
test("exec does not retry/replay a command that already reached the router", async () => {
  let addCount = 0;
  const srv = net.createServer((sock) => {
    let buf = Buffer.alloc(0), words = [];
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      let pos = 0;
      while (true) {
        const L = readLen(buf, pos);
        if (!L || L.next + L.len > buf.length) break;
        if (L.len === 0) {
          const cmd = words[0];
          const tag = tagOf(words);
          if (cmd === "/login") {
            sock.write(encodeSentence(["!done", ".tag=" + tag]));
          } else if (cmd === "/ip/hotspot/user/add") {
            addCount++;
            sock.write(encodeSentence(["!trap", "=message=already have such entry", ".tag=" + tag]));
            sock.write(encodeSentence(["!done", ".tag=" + tag]));
          } else {
            sock.write(encodeSentence(["!done", ".tag=" + tag]));
          }
          words = [];
        } else words.push(buf.subarray(L.next, L.next + L.len).toString("utf8"));
        pos = L.next + L.len;
      }
      buf = buf.subarray(pos);
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  try {
    await assert.rejects(
      () => exec({
        host: "127.0.0.1", port, user: "admin", pass: "x", tls: false,
        cmd: "/ip/hotspot/user/add", attrs: { name: "x" }, queries: {},
        retries: 3, timeout: 2000, connectTimeout: 2000,
      }),
      /already have/i
    );
    assert.equal(addCount, 1);
  } finally { srv.close(); }
});

test("a hung command rejects instead of leaving the caller pending forever", async () => {
  const srv = net.createServer((sock) => { /* accept, never reply */ });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  const t0 = Date.now();
  try {
    await assert.rejects(
      () => exec({
        host: "127.0.0.1", port, user: "admin", pass: "x", tls: false,
        cmd: "/system/resource/print", attrs: {}, queries: {},
        retries: 1, timeout: 400, connectTimeout: 800,
      }),
      /timed out|closed|Couldn't reach/i
    );
    assert.ok(Date.now() - t0 < 4000, "hung command must fail inside the read timeout, not hang");
  } finally { srv.close(); closeSessions(); }
});

test("exec reuses one TCP session for two commands to the same router", async () => {
  let logins = 0;
  let sockets = 0;
  const srv = net.createServer((sock) => {
    sockets++;
    let buf = Buffer.alloc(0), words = [];
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      let pos = 0;
      while (true) {
        const L = readLen(buf, pos);
        if (!L || L.next + L.len > buf.length) break;
        if (L.len === 0) {
          const cmd = words[0];
          const tag = tagOf(words);
          if (cmd === "/login") {
            logins++;
            sock.write(encodeSentence(["!done", ".tag=" + tag]));
          } else if (cmd === "/system/resource/print") {
            sock.write(encodeSentence(["!re", "=uptime=" + logins, ".tag=" + tag]));
            sock.write(encodeSentence(["!done", ".tag=" + tag]));
          } else {
            sock.write(encodeSentence(["!done", ".tag=" + tag]));
          }
          words = [];
        } else words.push(buf.subarray(L.next, L.next + L.len).toString("utf8"));
        pos = L.next + L.len;
      }
      buf = buf.subarray(pos);
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  try {
    const opts = {
      host: "127.0.0.1", port, user: "admin", pass: "x", tls: false,
      cmd: "/system/resource/print", attrs: {}, queries: {},
      timeout: 2000, connectTimeout: 2000, retries: 1,
    };
    const a = await exec(opts);
    const b = await exec(opts);
    assert.equal(a[0].uptime, "1");
    assert.equal(b[0].uptime, "1");
    assert.equal(logins, 1, "second command must reuse the logged-in socket");
    assert.equal(sockets, 1);
    assert.equal(sessionCount(), 1);
  } finally { srv.close(); closeSessions(); }
});

test("exec reconnects and logs in again after the router drops the socket", async () => {
  let logins = 0;
  const srv = net.createServer((sock) => {
    let buf = Buffer.alloc(0), words = [];
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      let pos = 0;
      while (true) {
        const L = readLen(buf, pos);
        if (!L || L.next + L.len > buf.length) break;
        if (L.len === 0) {
          const cmd = words[0];
          const tag = tagOf(words);
          if (cmd === "/login") {
            logins++;
            sock.write(encodeSentence(["!done", ".tag=" + tag]));
          } else if (cmd === "/system/identity/print") {
            sock.write(encodeSentence(["!re", "=name=box", ".tag=" + tag]));
            sock.write(encodeSentence(["!done", ".tag=" + tag]));
            sock.end();
          } else {
            sock.write(encodeSentence(["!done", ".tag=" + tag]));
          }
          words = [];
        } else words.push(buf.subarray(L.next, L.next + L.len).toString("utf8"));
        pos = L.next + L.len;
      }
      buf = buf.subarray(pos);
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  try {
    const opts = {
      host: "127.0.0.1", port, user: "admin", pass: "x", tls: false,
      cmd: "/system/identity/print", attrs: {}, queries: {},
      timeout: 2000, connectTimeout: 2000, retries: 1,
    };
    const a = await exec(opts);
    assert.equal(a[0].name, "box");
    await new Promise((r) => setTimeout(r, 40));
    const b = await exec(opts);
    assert.equal(b[0].name, "box");
    assert.equal(logins, 2, "a dropped socket must open a new login, not replay on a dead fd");
  } finally { srv.close(); closeSessions(); }
});

test("concurrent execs on one router share a socket and do not interleave sentences", async () => {
  let logins = 0;
  let inflight = 0;
  let maxInflight = 0;
  const srv = net.createServer((sock) => {
    let buf = Buffer.alloc(0), words = [];
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      let pos = 0;
      while (true) {
        const L = readLen(buf, pos);
        if (!L || L.next + L.len > buf.length) break;
        if (L.len === 0) {
          const cmd = words[0];
          const tag = tagOf(words);
          if (cmd === "/login") {
            logins++;
            sock.write(encodeSentence(["!done", ".tag=" + tag]));
          } else if (cmd === "/ip/address/print") {
            inflight++;
            if (inflight > maxInflight) maxInflight = inflight;
            const n = inflight;
            setTimeout(() => {
              sock.write(encodeSentence(["!re", "=address=" + n, ".tag=" + tag]));
              sock.write(encodeSentence(["!done", ".tag=" + tag]));
              inflight--;
            }, 30);
          } else {
            sock.write(encodeSentence(["!done", ".tag=" + tag]));
          }
          words = [];
        } else words.push(buf.subarray(L.next, L.next + L.len).toString("utf8"));
        pos = L.next + L.len;
      }
      buf = buf.subarray(pos);
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  try {
    const opts = {
      host: "127.0.0.1", port, user: "admin", pass: "x", tls: false,
      cmd: "/ip/address/print", attrs: {}, queries: {},
      timeout: 2000, connectTimeout: 2000, retries: 1,
    };
    const rows = await Promise.all([exec(opts), exec(opts), exec(opts)]);
    assert.equal(rows.length, 3);
    assert.equal(logins, 1);
    assert.equal(maxInflight, 1, "RouterOS API sentences must stay one-at-a-time on the pooled socket");
  } finally { srv.close(); closeSessions(); }
});
