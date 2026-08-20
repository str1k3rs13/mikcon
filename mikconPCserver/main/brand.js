const LOGO_RE = /^data:image\/(png|jpeg|jpg|webp);base64,/i;
const LOGO_MAX = 400000;
const BANNER_MAX = 1500000;

export function sanitizeBrand(input) {
  const o = input && typeof input === "object" ? input : {};
  let logo = String(o.logoDataUrl == null ? "" : o.logoDataUrl);
  if (logo && (!LOGO_RE.test(logo) || logo.length > LOGO_MAX)) logo = "";
  let banner = String(o.bannerDataUrl == null ? "" : o.bannerDataUrl);
  if (banner && (!LOGO_RE.test(banner) || banner.length > BANNER_MAX)) banner = "";
  return {
    name: String(o.name == null ? "" : o.name).replace(/\s+/g, " ").trim().slice(0, 80),
    phone: String(o.phone == null ? "" : o.phone).replace(/\s+/g, " ").trim().slice(0, 40),
    address: String(o.address == null ? "" : o.address).replace(/\s+/g, " ").trim().slice(0, 160),
    logoDataUrl: logo,
    message: String(o.message == null ? "" : o.message).slice(0, 2000),
    bannerDataUrl: banner,
  };
}

export function mergeBrand(prev, next) {
  if (!next || typeof next !== "object") return sanitizeBrand(prev);
  return sanitizeBrand(Object.assign({}, prev || {}, next));
}

export function mergeGcash(prev, next) {
  const p = prev && typeof prev === "object" ? prev : {};
  const n = next && typeof next === "object" ? next : {};
  const keep = (a, b) => {
    const v = a != null ? String(a) : "";
    return v.trim() ? v : String(b || "");
  };
  return {
    name: keep(n.name, p.name),
    number: keep(n.number, p.number),
    qrDataUrl: keep(n.qrDataUrl, p.qrDataUrl),
  };
}
