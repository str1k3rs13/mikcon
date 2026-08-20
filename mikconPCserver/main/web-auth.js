import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const MAX_PASSWORD_CHARS = 256;

export function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const pw = String(password || "").slice(0, MAX_PASSWORD_CHARS);
  const hash = crypto.scryptSync(pw, salt, 32).toString("hex");
  return { salt, hash };
}

export function checkPassword(password, salt, hash) {
  if (!salt || !hash) return false;
  const pw = String(password || "");
  if (pw.length > MAX_PASSWORD_CHARS) return false;
  const got = crypto.scryptSync(pw, salt, 32);
  const want = Buffer.from(String(hash), "hex");
  if (got.length !== want.length) return false;
  return crypto.timingSafeEqual(got, want);
}

export function makeLoginGuard({ maxFails = 5, windowMs = 60_000, maxKeys = 4000 } = {}) {
  const buckets = new Map();
  return {
    blocked(ip) {
      const b = buckets.get(String(ip || "unknown"));
      return !!(b && b.until > Date.now());
    },
    fail(ip) {
      const key = String(ip || "unknown");
      if (!buckets.has(key) && buckets.size >= maxKeys) buckets.delete(buckets.keys().next().value);
      let b = buckets.get(key);
      const now = Date.now();
      if (!b || now - b.first > windowMs * 15) b = { n: 0, first: now, until: 0 };
      b.n++;
      if (b.n >= maxFails) { b.until = now + windowMs; b.n = 0; }
      buckets.set(key, b);
    },
    ok(ip) { buckets.delete(String(ip || "unknown")); },
  };
}

export const DEFAULT_PASSWORD = "1234";
export const MIN_PASSWORD_CHARS = 4;

export function generatePassword() {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let out = "";
  const bytes = crypto.randomBytes(10);
  for (let i = 0; i < 10; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function passwordFile(dir) {
  return path.join(dir, "login.json");
}

export function writePasswordRecord(dir, rec) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(passwordFile(dir), JSON.stringify(rec), { encoding: "utf8", mode: 0o600 });
}

export function savePassword(dir, password, { mustChange = false } = {}) {
  const rec = { ...hashPassword(password), mustChange: !!mustChange };
  writePasswordRecord(dir, rec);
  return rec;
}

export function validateNewPassword(password, confirm) {
  const pw = String(password == null ? "" : password);
  const cf = String(confirm == null ? "" : confirm);
  if (pw.length < MIN_PASSWORD_CHARS) return { ok: false, error: "New password must be at least " + MIN_PASSWORD_CHARS + " characters." };
  if (pw.length > MAX_PASSWORD_CHARS) return { ok: false, error: "New password is too long." };
  if (pw !== cf) return { ok: false, error: "New password and confirm do not match." };
  if (pw === DEFAULT_PASSWORD) return { ok: false, error: "Choose a password other than 1234." };
  return { ok: true, password: pw };
}

export function loadOrCreatePassword(dir, { reset = false, fromEnv = "" } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = passwordFile(dir);
  if (!reset && fromEnv) {
    const rec = savePassword(dir, fromEnv, { mustChange: false });
    return { password: null, created: false, fromEnv: true, rec, mustChange: false };
  }
  if (!reset && fs.existsSync(file)) {
    const rec = JSON.parse(fs.readFileSync(file, "utf8"));
    return { password: null, created: false, rec, mustChange: !!rec.mustChange };
  }
  const rec = savePassword(dir, DEFAULT_PASSWORD, { mustChange: true });
  return { password: DEFAULT_PASSWORD, created: true, rec, mustChange: true };
}

export function readPasswordRecord(dir) {
  const rec = JSON.parse(fs.readFileSync(passwordFile(dir), "utf8"));
  if (rec.mustChange == null) rec.mustChange = false;
  return rec;
}

export function makeSessionStore() {
  const sessions = new Map();
  return {
    create(opts) {
      const token = crypto.randomBytes(24).toString("base64url");
      sessions.set(token, { exp: Date.now() + SESSION_TTL_MS, mustChange: !!(opts && opts.mustChange) });
      return token;
    },
    valid(token) {
      if (!token) return false;
      const s = sessions.get(token);
      if (!s || s.exp < Date.now()) {
        sessions.delete(token);
        return false;
      }
      s.exp = Date.now() + SESSION_TTL_MS;
      return true;
    },
    needsPasswordChange(token) {
      if (!token) return false;
      const s = sessions.get(token);
      return !!(s && s.mustChange && s.exp >= Date.now());
    },
    markPasswordChanged(token) {
      const s = sessions.get(token);
      if (s) s.mustChange = false;
    },
    drop(token) { sessions.delete(token); },
  };
}

export function parseCookie(header, name) {
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return "";
}
