// RouterOS binary-API client for MikconPC. Ports MtApi.java semantics: full TLS
// validation unless a SHA-256 fingerprint is pinned, separate connect vs read
// timeouts, and handshake-only retries (a command is never replayed).
import net from "node:net";
import tls from "node:tls";
import crypto from "node:crypto";
import { encodeSentence, readLen, parseSentence } from "./routeros-framing.js";

export function normalizeFingerprint(fp) {
  const original = (fp == null ? "" : String(fp));
  if (/[\r\n]/.test(original)) throw new Error("TLS fingerprint contains invalid characters");
  const raw = original.trim();
  if (raw && !/^[0-9A-Fa-f: ]+$/.test(raw)) throw new Error("TLS fingerprint contains invalid characters");
  const pin = raw.replace(/[^0-9A-Fa-f]/g, "").toLowerCase();
  if (pin && !/^[0-9a-f]{64}$/.test(pin)) throw new Error("TLS fingerprint must be a SHA-256 certificate fingerprint");
  return pin;
}

function validateRequest({ host, port, cmd, tlsFingerprint }) {
  if (!host || host.length > 253 || /[\r\n]/.test(host)) throw new Error("invalid router host");
  if (!(port >= 1 && port <= 65535)) throw new Error("invalid router API port");
  if (!cmd || cmd.length > 256 || /[\r\n]/.test(cmd)) throw new Error("invalid router API request");
  if (tlsFingerprint && (tlsFingerprint.length > 128 || /[\r\n]/.test(tlsFingerprint))) throw new Error("invalid TLS fingerprint");
}

function openSocket({ host, port, useTls, pin, connectTimeout, readTimeout }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, arg) => { if (settled) return; settled = true; clearTimeout(timer); fn(arg); };
    const fail = (msg) => { try { sock.destroy(); } catch {} done(reject, new Error(msg)); };

    const timer = setTimeout(() => fail(`Couldn't reach the router at ${host}:${port} — connection timed out.`), connectTimeout);

    const onReady = () => {
      if (useTls && pin) {
        const cert = sock.getPeerCertificate(true);
        if (!cert || !cert.raw) return fail("router sent no certificate");
        const now = Date.now();
        if (now < Date.parse(cert.valid_from) || now > Date.parse(cert.valid_to)) return fail("router certificate is not currently valid");
        const actual = crypto.createHash("sha256").update(cert.raw).digest("hex");
        if (actual !== pin) return fail("router certificate fingerprint does not match the saved pin");
      } else if (useTls && !sock.authorized) {
        return fail("router certificate is not trusted: " + (sock.authorizationError || "unknown"));
      }
      // Idle timeout is applied only while a command is in flight. A pooled
      // session must not be killed just because the UI or agent is quiet.
      sock.setTimeout(0);
      done(resolve, sock);
    };

    const sock = useTls
      ? tls.connect({ host, port, servername: host, rejectUnauthorized: !pin }, onReady)
      : net.connect({ host, port }, onReady);

    sock.on("error", (e) => fail(`Couldn't reach the router at ${host}:${port} — ${e.message}`));
  });
}

async function openWithRetries(opts, attempts) {
  const n = Math.max(1, Math.min(attempts, 4));
  let last;
  for (let i = 0; i < n; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 400 * i));
    try { return await openSocket(opts); } catch (e) { last = e; }
  }
  throw last;
}

function runCommand(sock, words, readTimeout) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0), cur = [], replies = [], trap = null, settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(arg);
    };
    const onData = (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      let pos = 0;
      while (true) {
        const L = readLen(buf, pos);
        if (!L || L.next + L.len > buf.length) break;
        if (L.len === 0) {
          const { type, attrs } = parseSentence(cur);
          cur = [];
          if (type === "!re") replies.push(attrs);
          else if (type === "!trap") trap = attrs.message || "command failed";
          else if (type === "!fatal") return finish(reject, new Error("RouterOS fatal: connection closed"));
          else if (type === "!done") {
            if (trap) return finish(reject, new Error(trap));
            if (attrs.ret !== undefined && replies.length === 0) replies.push({ ret: attrs.ret });
            return finish(resolve, replies);
          }
        } else cur.push(buf.subarray(L.next, L.next + L.len).toString("utf8"));
        pos = L.next + L.len;
      }
      buf = buf.subarray(pos);
    };
    const onErr = () => finish(reject, new Error("connection closed by router"));
    // destroy() emits close, not error — a timeout that only killed the socket left the
    // Promise pending, so the header chip stayed on "connecting…" forever.
    const onTimeout = () => { try { sock.destroy(); } catch {} finish(reject, new Error("router command timed out")); };
    const cleanup = () => {
      sock.setTimeout(0);
      sock.off("data", onData);
      sock.off("error", onErr);
      sock.off("timeout", onTimeout);
    };
    sock.setTimeout(Number(readTimeout) || 8000);
    sock.on("data", onData);
    sock.on("error", onErr);
    sock.on("timeout", onTimeout);
    sock.write(encodeSentence(words));
  });
}

async function login(sock, user, pass, readTimeout) {
  const r = await runCommand(sock, ["/login", "=name=" + user, "=password=" + pass], readTimeout);
  const challenge = r && r[0] && r[0].ret;
  if (challenge) {
    const md5 = crypto.createHash("md5");
    md5.update(Buffer.concat([Buffer.from([0]), Buffer.from(pass, "utf8"), Buffer.from(challenge, "hex")]));
    await runCommand(sock, ["/login", "=name=" + user, "=response=00" + md5.digest("hex")], readTimeout);
  }
}

function sessionKey({ host, port, user, pass, tls, pin }) {
  return [host, port, user || "", pass || "", tls ? "1" : "0", pin || ""].join("\0");
}

const sessions = new Map();

function getEntry(key) {
  let e = sessions.get(key);
  if (!e) {
    e = { key, sock: null, connecting: null, tail: Promise.resolve() };
    sessions.set(key, e);
  }
  return e;
}

function dropSock(e, sock) {
  if (!e) return;
  if (sock && e.sock && sock !== e.sock) return;
  if (e.sock) {
    try { e.sock.destroy(); } catch {}
  }
  e.sock = null;
}

function attachSock(e, sock) {
  e.sock = sock;
  const onDead = () => {
    if (e.sock === sock) e.sock = null;
  };
  sock.on("close", onDead);
  sock.on("end", onDead);
  sock.on("error", onDead);
}

async function openAndLogin(o, pin, readTimeout, connectTimeout) {
  const sock = await openWithRetries(
    { host: o.host, port: o.port, useTls: !!o.tls, pin, connectTimeout, readTimeout },
    o.retries == null ? 2 : o.retries
  );
  try {
    await login(sock, o.user || "", o.pass || "", readTimeout);
    return sock;
  } catch (err) {
    try { sock.destroy(); } catch {}
    throw err;
  }
}

async function ensureSock(e, o, pin, readTimeout, connectTimeout) {
  if (e.sock && !e.sock.destroyed) return e.sock;
  if (e.connecting) return e.connecting;
  e.connecting = openAndLogin(o, pin, readTimeout, connectTimeout).then((sock) => {
    e.connecting = null;
    attachSock(e, sock);
    return sock;
  }).catch((err) => {
    e.connecting = null;
    throw err;
  });
  return e.connecting;
}

export function closeSessions() {
  for (const e of sessions.values()) {
    e.connecting = null;
    dropSock(e);
  }
  sessions.clear();
}

export function sessionCount() {
  let n = 0;
  for (const e of sessions.values()) {
    if (e.sock && !e.sock.destroyed) n++;
  }
  return n;
}

export async function exec(o) {
  const host = String(o.host || "").trim();
  const port = Number(o.port) || 8728;
  const cmd = String(o.cmd || "").trim();
  validateRequest({ host, port, cmd, tlsFingerprint: o.tlsFingerprint });
  const pin = normalizeFingerprint(o.tlsFingerprint || "");
  const readTimeout = Number(o.timeout) || 8000;
  const connectTimeout = Number(o.connectTimeout) || Math.max(readTimeout, 15000);
  const key = sessionKey({ host, port, user: o.user, pass: o.pass, tls: !!o.tls, pin });
  const e = getEntry(key);
  const words = [cmd];
  for (const [k, v] of Object.entries(o.attrs || {})) words.push("=" + k + "=" + (v == null ? "" : v));
  for (const [k, v] of Object.entries(o.queries || {})) words.push("?" + k + "=" + (v == null ? "" : v));

  const run = async () => {
    const sock = await ensureSock(e, { ...o, host, port }, pin, readTimeout, connectTimeout);
    try {
      return await runCommand(sock, words, readTimeout);
    } catch (err) {
      dropSock(e, sock);
      throw err;
    }
  };
  const p = e.tail.then(run, run);
  e.tail = p.then(() => {}, () => {});
  return p;
}
