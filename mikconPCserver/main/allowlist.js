// Central URL/host/scheme policy. Mirrors AppTools.isAllowedExternalHost and the
// index.html safeExternalUrl/licBase checks so the desktop build enforces the same
// allowlists in the trusted main process.

function host(u) { return u.hostname.toLowerCase().replace(/\.$/, ""); }

function externalHostAllowed(h) {
  return h === "miklic.jeff-network.com" || h === "mikcon.jeff-network.com"
    || h === "facebook.com" || h.endsWith(".facebook.com")
    || h === "paymongo.com" || h.endsWith(".paymongo.com")
    || h === "paymongo.page" || h.endsWith(".paymongo.page")
    || h === "pm.link" || h.endsWith(".pm.link");
}

export function isAllowedExternal(raw) {
  let u; try { u = new URL(String(raw || "")); } catch { return false; }
  if (u.protocol !== "https:" || u.username || u.password) return false;
  if (u.port && u.port !== "443") return false;
  return externalHostAllowed(host(u));
}

export function canOpenExternally(raw) {
  let u; try { u = new URL(String(raw || "")); } catch { return false; }
  if (u.protocol === "tel:") {
    const p = u.pathname;                       // everything after "tel:"
    return /^[0-9+().\-\s]+$/.test(p) && /^\+?[0-9]{7,15}$/.test(p.replace(/[\s().\-]/g, ""));
  }
  if (u.protocol !== "https:") return false;               // scheme allowlist BEFORE host
  return isAllowedExternal(raw);
}

export function isAllowedLicenseUrl(raw, { allowLoopback = false } = {}) {
  let u; try { u = new URL(String(raw || "")); } catch { return false; }
  const h = host(u);
  const loopback = h === "localhost" || h === "127.0.0.1" || h === "::1";
  if (loopback) {
    if (!allowLoopback && process.env.MIKCON_DEV_LICENSE !== "1") return false;
    return u.protocol === "http:" || u.protocol === "https:";
  }
  if (u.protocol !== "https:" || u.username || u.password) return false;
  if (u.port && u.port !== "443") return false;
  return h === "miklic.jeff-network.com" || h === "mikcon.jeff-network.com";
}
