import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function makeFileEncryptor(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const keyFile = path.join(dir, "secure.key");
  let key;
  if (fs.existsSync(keyFile)) {
    key = fs.readFileSync(keyFile);
    if (key.length !== 32) throw new Error("secure.key is the wrong size");
  } else {
    key = crypto.randomBytes(32);
    fs.writeFileSync(keyFile, key, { mode: 0o600 });
  }
  return {
    isEncryptionAvailable: () => true,
    encryptString(s) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv("aes-256-gcm", key, iv);
      const enc = Buffer.concat([c.update(String(s), "utf8"), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), enc]);
    },
    decryptString(buf) {
      const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
      const iv = b.subarray(0, 12);
      const tag = b.subarray(12, 28);
      const enc = b.subarray(28);
      const d = crypto.createDecipheriv("aes-256-gcm", key, iv);
      d.setAuthTag(tag);
      return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
    },
  };
}
