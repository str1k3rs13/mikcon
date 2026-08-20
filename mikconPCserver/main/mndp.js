// MikroTik Neighbor Discovery (MNDP): UDP broadcast on port 5678, TLV replies.
// LAN-only — does not cross a router/VPN. Ported from RouterApi.java discover().
import dgram from "node:dgram";

export function parseMndp(data, len) {
  if (len < 18) return null;
  const o = {};
  let p = 4, sawMac = false;
  while (p + 4 <= len) {
    const type = (data[p] << 8) | data[p + 1];
    const tlen = (data[p + 2] << 8) | data[p + 3];
    p += 4;
    if (tlen < 0 || p + tlen > len) break;
    switch (type) {
      case 1: if (tlen === 6) { o.mac = macStr(data, p); sawMac = true; } break;
      case 5: o.identity = data.toString("utf8", p, p + tlen); break;
      case 7: o.version = data.toString("utf8", p, p + tlen); break;
      case 8: o.platform = data.toString("utf8", p, p + tlen); break;
      case 12: o.board = data.toString("utf8", p, p + tlen); break;
      case 16: o.iface = data.toString("utf8", p, p + tlen); break;
    }
    p += tlen;
  }
  return sawMac ? o : null;
}

function macStr(b, off) {
  const parts = [];
  for (let i = 0; i < 6; i++) parts.push(b[off + i].toString(16).padStart(2, "0").toUpperCase());
  return parts.join(":");
}

export function discover({ timeout } = {}) {
  const t = Math.max(1500, Math.min(Number(timeout) || 4000, 10000));
  return new Promise((resolve) => {
    const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const found = new Map();
    sock.on("message", (msg, rinfo) => {
      const info = parseMndp(msg, msg.length);
      if (!info) return;
      info.ip = rinfo.address;
      const key = info.mac || info.ip;
      if (key && !found.has(key)) found.set(key, info);
    });
    sock.on("error", () => finish());
    sock.bind(5678, () => {
      try {
        sock.setBroadcast(true);
        const probe = Buffer.from([0, 0, 0, 0]);
        sock.send(probe, 0, probe.length, 5678, "255.255.255.255");
      } catch {}
    });
    const timer = setTimeout(finish, t);
    function finish() { clearTimeout(timer); try { sock.close(); } catch {} resolve({ ok: true, routers: [...found.values()] }); }
  });
}
