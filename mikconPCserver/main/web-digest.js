// SHA-256 / SHA-512 for insecure-origin browsers (http://192.168.x.x has no crypto.subtle).
function asBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function rotr(x, n) {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

const K256 = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

export function sha256(data) {
  const msg = asBytes(data);
  const bitLen = msg.length * 8;
  const withPad = msg.length + 1 + 8;
  const paddedLen = ((withPad + 63) & ~63);
  const buf = new Uint8Array(paddedLen);
  buf.set(msg);
  buf[msg.length] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(paddedLen - 4, bitLen >>> 0);
  // high 32 bits of length: always 0 for our license-sized inputs
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000));

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Uint32Array(64);
  for (let i = 0; i < paddedLen; i += 64) {
    for (let t = 0; t < 16; t++) w[t] = view.getUint32(i + t * 4);
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K256[t] + w[t]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }
  const out = new DataView(new ArrayBuffer(32));
  out.setUint32(0, h0); out.setUint32(4, h1); out.setUint32(8, h2); out.setUint32(12, h3);
  out.setUint32(16, h4); out.setUint32(20, h5); out.setUint32(24, h6); out.setUint32(28, h7);
  return out.buffer;
}

const MASK64 = (1n << 64n) - 1n;
function rotr64(x, n) {
  n = BigInt(n);
  return ((x >> n) | (x << (64n - n))) & MASK64;
}
const K512 = [
  0x428a2f98d728ae22n, 0x7137449123ef65cdn, 0xb5c0fbcfec4d3b2fn, 0xe9b5dba58189dbbcn,
  0x3956c25bf348b538n, 0x59f111f1b605d019n, 0x923f82a4af194f9bn, 0xab1c5ed5da6d8118n,
  0xd807aa98a3030242n, 0x12835b0145706fben, 0x243185be4ee4b28cn, 0x550c7dc3d5ffb4e2n,
  0x72be5d74f27b896fn, 0x80deb1fe3b1696b1n, 0x9bdc06a725c71235n, 0xc19bf174cf692694n,
  0xe49b69c19ef14ad2n, 0xefbe4786384f25e3n, 0x0fc19dc68b8cd5b5n, 0x240ca1cc77ac9c65n,
  0x2de92c6f592b0275n, 0x4a7484aa6ea6e483n, 0x5cb0a9dcbd41fbd4n, 0x76f988da831153b5n,
  0x983e5152ee66dfabn, 0xa831c66d2db43210n, 0xb00327c898fb213fn, 0xbf597fc7beef0ee4n,
  0xc6e00bf33da88fc2n, 0xd5a79147930aa725n, 0x06ca6351e003826fn, 0x142929670a0e6e70n,
  0x27b70a8546d22ffcn, 0x2e1b21385c26c926n, 0x4d2c6dfc5ac42aedn, 0x53380d139d95b3dfn,
  0x650a73548baf63den, 0x766a0abb3c77b2a8n, 0x81c2c92e47edaee6n, 0x92722c851482353bn,
  0xa2bfe8a14cf10364n, 0xa81a664bbc423001n, 0xc24b8b70d0f89791n, 0xc76c51a30654be30n,
  0xd192e819d6ef5218n, 0xd69906245565a910n, 0xf40e35855771202an, 0x106aa07032bbd1b8n,
  0x19a4c116b8d2d0c8n, 0x1e376c085141ab53n, 0x2748774cdf8eeb99n, 0x34b0bcb5e19b48a8n,
  0x391c0cb3c5c95a63n, 0x4ed8aa4ae3418acbn, 0x5b9cca4f7763e373n, 0x682e6ff3d6b2b8a3n,
  0x748f82ee5defb2fcn, 0x78a5636f43172f60n, 0x84c87814a1f0ab72n, 0x8cc702081a6439ecn,
  0x90befffa23631e28n, 0xa4506cebde82bde9n, 0xbef9a3f7b2c67915n, 0xc67178f2e372532bn,
  0xca273eceea26619cn, 0xd186b8c721c0c207n, 0xeada7dd6cde0eb1en, 0xf57d4f7fee6ed178n,
  0x06f067aa72176fban, 0x0a637dc5a2c898a6n, 0x113f9804bef90daen, 0x1b710b35131c471bn,
  0x28db77f523047d84n, 0x32caab7b40c72493n, 0x3c9ebe0a15c9bebcn, 0x431d67c49c100d4cn,
  0x4cc5d4becb3e42b6n, 0x597f299cfc657e2an, 0x5fcb6fab3ad6faecn, 0x6c44198c4a475817n,
];

export function sha512(data) {
  const msg = asBytes(data);
  const bitLen = BigInt(msg.length) * 8n;
  const withPad = msg.length + 1 + 16;
  const paddedLen = (withPad + 127) & ~127;
  const buf = new Uint8Array(paddedLen);
  buf.set(msg);
  buf[msg.length] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(paddedLen - 4, Number(bitLen & 0xffffffffn));
  view.setUint32(paddedLen - 8, Number((bitLen >> 32n) & 0xffffffffn));

  let h = [
    0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
    0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
  ];
  const w = new Array(80);
  for (let i = 0; i < paddedLen; i += 128) {
    for (let t = 0; t < 16; t++) {
      const hi = view.getUint32(i + t * 8);
      const lo = view.getUint32(i + t * 8 + 4);
      w[t] = (BigInt(hi) << 32n) | BigInt(lo);
    }
    for (let t = 16; t < 80; t++) {
      const s0 = rotr64(w[t - 15], 1) ^ rotr64(w[t - 15], 8) ^ (w[t - 15] >> 7n);
      const s1 = rotr64(w[t - 2], 19) ^ rotr64(w[t - 2], 61) ^ (w[t - 2] >> 6n);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) & MASK64;
    }
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (let t = 0; t < 80; t++) {
      const S1 = rotr64(e, 14) ^ rotr64(e, 18) ^ rotr64(e, 41);
      const ch = (e & f) ^ ((~e) & g);
      const t1 = (hh + S1 + ch + K512[t] + w[t]) & MASK64;
      const S0 = rotr64(a, 28) ^ rotr64(a, 34) ^ rotr64(a, 39);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) & MASK64;
      hh = g; g = f; f = e; e = (d + t1) & MASK64;
      d = c; c = b; b = a; a = (t1 + t2) & MASK64;
    }
    h[0] = (h[0] + a) & MASK64; h[1] = (h[1] + b) & MASK64;
    h[2] = (h[2] + c) & MASK64; h[3] = (h[3] + d) & MASK64;
    h[4] = (h[4] + e) & MASK64; h[5] = (h[5] + f) & MASK64;
    h[6] = (h[6] + g) & MASK64; h[7] = (h[7] + hh) & MASK64;
  }
  const out = new DataView(new ArrayBuffer(64));
  for (let i = 0; i < 8; i++) {
    out.setUint32(i * 8, Number(h[i] >> 32n));
    out.setUint32(i * 8 + 4, Number(h[i] & 0xffffffffn));
  }
  return out.buffer;
}

export function hex(buf) {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function hmacSha256(key, data) {
  const block = 64;
  let k = asBytes(key);
  const msg = asBytes(data);
  if (k.length > block) k = new Uint8Array(sha256(k));
  const pad = new Uint8Array(block);
  pad.set(k);
  const inner = new Uint8Array(block + msg.length);
  const outer = new Uint8Array(block + 32);
  for (let i = 0; i < block; i++) {
    inner[i] = pad[i] ^ 0x36;
    outer[i] = pad[i] ^ 0x5c;
  }
  inner.set(msg, block);
  outer.set(new Uint8Array(sha256(inner)), block);
  return sha256(outer);
}

export function pbkdf2Sha256(password, salt, iterations, dkLen) {
  const pass = asBytes(password);
  const slt = asBytes(salt);
  const rounds = Math.max(1, Number(iterations) || 1);
  const outLen = Math.max(1, Number(dkLen) || 32);
  const out = new Uint8Array(outLen);
  const blocks = Math.ceil(outLen / 32);
  for (let i = 1; i <= blocks; i++) {
    const blockSalt = new Uint8Array(slt.length + 4);
    blockSalt.set(slt);
    blockSalt[slt.length] = (i >>> 24) & 0xff;
    blockSalt[slt.length + 1] = (i >>> 16) & 0xff;
    blockSalt[slt.length + 2] = (i >>> 8) & 0xff;
    blockSalt[slt.length + 3] = i & 0xff;
    let u = new Uint8Array(hmacSha256(pass, blockSalt));
    const t = new Uint8Array(u);
    for (let j = 2; j <= rounds; j++) {
      u = new Uint8Array(hmacSha256(pass, u));
      for (let k = 0; k < 32; k++) t[k] ^= u[k];
    }
    out.set(t.subarray(0, Math.min(32, outLen - (i - 1) * 32)), (i - 1) * 32);
  }
  return out.buffer;
}

export function installSubtleDigestPolyfill(cryptoObj) {
  const c = cryptoObj || globalThis.crypto;
  if (!c) return false;
  if (c.subtle && typeof c.subtle.digest === "function" && typeof c.subtle.deriveBits === "function") return false;
  const digest = (algo, data) => {
    const name = String((algo && algo.name) || algo).toUpperCase();
    if (name.includes("SHA-256")) return Promise.resolve(sha256(data));
    if (name.includes("SHA-512")) return Promise.resolve(sha512(data));
    return Promise.reject(new Error("digest not supported: " + name));
  };
  const importKey = (format, keyData, algo) => {
    const name = String((algo && algo.name) || algo).toUpperCase();
    if (format === "raw" && name.includes("PBKDF2")) {
      return Promise.resolve({ _pbkdf2: true, _raw: asBytes(keyData) });
    }
    return Promise.reject(new Error("WebCrypto importKey unavailable on this origin"));
  };
  const deriveBits = (algo, key, length) => {
    const name = String((algo && algo.name) || "").toUpperCase();
    const hash = String((algo && algo.hash && algo.hash.name) || (algo && algo.hash) || "").toUpperCase();
    if (!name.includes("PBKDF2") || !hash.includes("SHA-256") || !key || !key._pbkdf2) {
      return Promise.reject(new Error("WebCrypto deriveBits unavailable on this origin"));
    }
    const bits = Number(length) || 256;
    return Promise.resolve(pbkdf2Sha256(key._raw, algo.salt, algo.iterations, Math.ceil(bits / 8)));
  };
  const missing = {
    digest,
    importKey,
    deriveBits,
    verify: () => Promise.reject(new Error("WebCrypto verify unavailable on this origin")),
  };
  if (c.subtle && typeof c.subtle.digest === "function") {
    if (typeof c.subtle.importKey !== "function") c.subtle.importKey = importKey;
    if (typeof c.subtle.deriveBits !== "function") c.subtle.deriveBits = deriveBits;
    return true;
  }
  try {
    Object.defineProperty(c, "subtle", { configurable: true, value: missing });
  } catch {
    c.subtle = missing;
  }
  return true;
}
