// Public /payment page: last-name lookup, then either a PayMongo/Xendit checkout
// (webhook auto-approves) or a GCash reference (Telegram/app approval).
import { randomUUID } from "node:crypto";
import { normalizeSubmission } from "../agent/pay-request.js";
import { matchesAccount, normalizeFirstName, normalizeLastName, normalizePhoneTail, publicCustomerCard, serviceStatus } from "../agent/last-name.js";
import { parseBill } from "../agent/billing.js";
import { publicReceipt } from "../agent/receipt.js";

const BODY_CAP = 4096;
const RATE_LIMIT_CAPACITY = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;
const PICK_TTL_MS = 15 * 60_000;

export function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function makeRateLimiter({ capacity = RATE_LIMIT_CAPACITY, windowMs = RATE_LIMIT_WINDOW_MS } = {}) {
  const buckets = new Map();
  return function take(key) {
    const now = Date.now();
    let b = buckets.get(key);
    if (!b) {
      b = { tokens: capacity, last: now };
      buckets.set(key, b);
    }
    const elapsed = now - b.last;
    if (elapsed > 0) {
      b.tokens = Math.min(capacity, b.tokens + (elapsed / windowMs) * capacity);
      b.last = now;
    }
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  };
}

function readBody(req, capBytes) {
  return new Promise((resolve, reject) => {
    let total = 0;
    let settled = false;
    let chunks = [];
    function fail(code, err) {
      if (settled) return;
      settled = true;
      chunks = [];
      reject(Object.assign(err || new Error(code), { code }));
    }
    req.on("data", (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > capBytes) { fail("BODY_TOO_LARGE"); return; }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", (e) => fail("BODY_ERROR", e));
  });
}

export function renderPaymentPage(config) {
  const gcash = (config && config.gcash) || {};
  const brand = (config && config.brand) || {};
  const gateway = (config && config.gateway) || {};
  const gcashManual = config && config.gcashManual !== false;
  const gatewayOn = !!gateway.enabled;
  const bizName = escapeHtml(brand.name || "Mikcon");
  const bizPhone = escapeHtml(brand.phone || "");
  const bizAddr = escapeHtml(brand.address || "");
  const logo = escapeHtml(brand.logoDataUrl || "");
  const initial = escapeHtml(((brand.name || "M").trim().charAt(0) || "M").toUpperCase());
  const message = escapeHtml(brand.message || "Pay your bill or add credit. Type your last name to find your account.");
  const gname = escapeHtml(gcash.name || "");
  const gnumber = escapeHtml(gcash.number || "");
  const qr = escapeHtml(gcash.qrDataUrl || "");
  const banner = escapeHtml(brand.bannerDataUrl || "");
  const provider = escapeHtml(gateway.provider === "xendit" ? "Xendit" : "PayMongo");
  const pageTitle = brand.name ? escapeHtml(brand.name) + " — Pay" : "Pay or add credit";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'">
<title>${pageTitle}</title>
<style>
  :root{
    --bg:#EEF1F5;--ink:#0F1720;--muted:#5A6A7A;--brand:#163A5C;--cta:#163A5C;--on:#FFFFFF;
    --paper:#FFFFFF;--shell:#E4E9EF;--line:#D5DCE5;--err:#B42318;--ok:#163A5C;--gcash:#0070E0;
    --tile:#F6F8FA;--ring:#163A5C;--rail:#163A5C;
    --shadow:0 1px 0 rgba(15,23,32,.04),0 8px 20px rgba(15,23,32,.05);
    --ease:cubic-bezier(.32,.72,0,1);
  }
  @media (prefers-color-scheme:dark){
    :root{
      --bg:#0C1118;--ink:#E8EEF4;--muted:#8B98A8;--brand:#8FB4D4;--cta:#1A6BB5;--on:#FFFFFF;
      --paper:#161D27;--shell:#1A222C;--line:#2A3542;--err:#F07171;--ok:#8FB4D4;--gcash:#0070E0;
      --tile:#121820;--ring:#8FB4D4;--rail:#8FB4D4;
      --shadow:0 1px 0 rgba(255,255,255,.04),0 10px 24px rgba(0,0,0,.38);
    }
  }
  *{box-sizing:border-box}
  html{min-height:100vh;min-height:100dvh}
  body{
    margin:0;min-height:100vh;min-height:100dvh;color:var(--ink);background:var(--bg);
    font-family:"Plus Jakarta Sans","Segoe UI Variable","Segoe UI",system-ui,sans-serif;
    font-size:16px;line-height:1.5;font-weight:400;
  }
  body::before{content:"";display:block;height:3px;background:var(--rail)}
  .skip{position:absolute;left:-999px;top:8px;padding:8px 12px;background:var(--cta);color:var(--on);border-radius:8px}
  .skip:focus{left:8px;z-index:4}
  .wrap{max-width:26.5rem;margin:0 auto;padding:22px 16px 48px}
  .brand{display:flex;align-items:center;gap:12px;margin:0 0 18px;padding-bottom:14px;border-bottom:1px solid var(--line)}
  .mark{
    width:36px;height:36px;border-radius:8px;background:var(--brand);color:var(--on);
    display:flex;align-items:center;justify-content:center;font-weight:700;font-size:15px;flex-shrink:0;
  }
  .mark-img{width:36px;height:36px;border-radius:8px;object-fit:cover;flex-shrink:0;border:1px solid var(--line);background:var(--paper)}
  .biz-meta{margin:0 0 16px;font-size:12px;color:var(--muted);line-height:1.45}
  .biz-foot{margin:28px 0 0;padding-top:14px;border-top:1px solid var(--line);font-size:12px;color:var(--muted);line-height:1.5}
  .brand strong{display:block;font-size:15px;font-weight:600;letter-spacing:-.01em;color:var(--ink)}
  .brand span{display:block;font-size:12px;color:var(--muted);font-weight:500;margin-top:1px}
  .banner{width:100%;max-width:100%;height:auto;border-radius:12px;margin:0 0 16px;display:block;border:1px solid var(--line)}
  h1{font-size:1.5rem;line-height:1.2;letter-spacing:-.025em;margin:0 0 6px;font-weight:600;text-wrap:balance}
  .lede{margin:0 0 18px;color:var(--muted);max-width:38ch;font-size:15px}
  .prog{display:flex;gap:0;margin:0 0 18px;padding:0;list-style:none}
  .prog li{
    flex:1;text-align:center;font-size:12px;font-weight:600;color:var(--muted);
    padding:6px 4px 10px;border-bottom:2px solid var(--line);
  }
  .prog li.on{color:var(--brand);border-bottom-color:var(--brand)}
  .prog li.done{color:var(--brand);border-bottom-color:var(--brand);opacity:.72}
  .card{
    background:var(--paper);border-radius:12px;padding:20px 16px 16px;margin:0 0 16px;
    box-shadow:var(--shadow);border:1px solid var(--line);
    animation:rise .2s var(--ease);
  }
  @keyframes rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
  .shell{background:var(--shell);border-radius:12px;padding:5px;margin:16px 0 4px;border:1px solid var(--line)}
  .shell-in{background:var(--paper);border-radius:8px;padding:16px 14px 14px}
  label{display:block;font-size:13px;font-weight:600;margin:14px 0 6px;color:var(--ink)}
  label:first-child{margin-top:0}
  input,select{
    font:inherit;width:100%;min-height:48px;padding:12px 14px;border-radius:8px;
    border:1px solid var(--line);background:var(--paper);color:var(--ink);outline:none;
  }
  input:focus,select:focus{border-color:var(--ring);box-shadow:0 0 0 3px rgba(22,58,92,.18)}
  @media (prefers-color-scheme:dark){
    input:focus,select:focus{box-shadow:0 0 0 3px rgba(143,180,212,.28)}
  }
  input:disabled{opacity:.55;background:var(--tile)}
  button{
    font:inherit;font-weight:600;width:100%;min-height:48px;margin-top:14px;padding:12px 16px;
    border-radius:8px;border:0;background:var(--cta);color:var(--on);cursor:pointer;
    display:inline-flex;align-items:center;justify-content:center;gap:10px;
    touch-action:manipulation;transition:transform .16s var(--ease), opacity .16s var(--ease);
  }
  button:hover{opacity:.94}
  button:active{transform:scale(.98)}
  button:focus-visible{outline:3px solid var(--ring);outline-offset:3px}
  button:disabled{opacity:.5;cursor:not-allowed;transform:none}
  button.ghost{background:transparent;color:var(--brand);border:1px solid var(--line);font-weight:600}
  button.gcash{background:var(--gcash);color:#fff;border-radius:8px}
  .btn-ico{
    width:22px;height:22px;border-radius:6px;background:rgba(255,255,255,.16);
    display:inline-flex;align-items:center;justify-content:center;font-size:13px;line-height:1;
  }
  .muted{color:var(--muted);font-size:13px;margin:10px 0 0;line-height:1.45}
  .err{color:var(--err);font-weight:600}
  .ok{color:var(--ok);font-weight:600}
  #result{min-height:1.5em;margin:0 0 8px}
  .qr{max-width:168px;display:block;margin:12px auto 4px;border:1px solid var(--line);border-radius:8px;padding:8px;background:var(--paper)}
  .hit{
    display:block;width:100%;text-align:left;background:var(--tile);color:var(--ink);
    border:1px solid var(--line);margin:8px 0 0;padding:14px;border-radius:8px;min-height:48px;
  }
  .hit strong{display:block;font-size:16px;font-weight:600}
  .hit em{display:block;font-style:normal;color:var(--muted);font-size:13px;font-weight:500;margin-top:2px}
  .hide{display:none !important}
  .who{margin:0 0 12px;padding-bottom:10px;border-bottom:1px solid var(--line)}
  .who b{display:block;font-size:1.05rem;letter-spacing:-.02em;font-weight:600;overflow-wrap:anywhere}
  .who .site{display:block;color:var(--muted);font-size:12px;margin-top:2px;overflow-wrap:anywhere}
  .dash{
    display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px;margin:0 0 8px;
    align-items:stretch;
  }
  .tile{
    min-width:0;min-height:4.5rem;background:var(--tile);border-radius:8px;padding:10px;
    border:1px solid var(--line);display:flex;flex-direction:column;justify-content:flex-start;
  }
  .tile .k{display:block;font-size:11px;font-weight:600;color:var(--muted)}
  .tile .v{
    display:block;font-size:clamp(1.05rem,4.8vw,1.35rem);font-weight:700;letter-spacing:-.03em;
    font-variant-numeric:tabular-nums;margin-top:4px;line-height:1.15;overflow-wrap:anywhere;color:var(--brand);
  }
  .tile-wallet .v{color:var(--ink)}
  .substat{
    margin:0 0 12px;padding:12px;border-radius:8px;border:1px solid var(--line);background:var(--tile);
  }
  .substat .substat-k{display:block;font-size:11px;font-weight:600;color:var(--muted);letter-spacing:.04em;text-transform:uppercase}
  .substat .substat-v{display:block;font-size:1.15rem;font-weight:700;letter-spacing:-.02em;margin-top:2px;color:var(--brand)}
  .substat .substat-d{display:block;font-size:13px;color:var(--muted);margin-top:4px;line-height:1.4}
  .substat.due .substat-v{color:var(--ink)}
  .substat.over .substat-v{color:var(--err)}
  .facts{
    display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:2px 8px;margin:0 0 8px;
  }
  .facts .meta{margin:0;font-size:12px;line-height:1.35;overflow-wrap:anywhere}
  .meta{margin:0 0 4px;font-size:12px;color:var(--muted);overflow-wrap:anywhere}
  .meta.rec{margin:0 0 8px}
  .note{margin:0 0 8px;font-size:13px;color:var(--brand);font-weight:600;overflow-wrap:anywhere}
  .amt{
    font-size:clamp(1.25rem,7vw,1.7rem);font-weight:700;letter-spacing:-.04em;margin:2px 0 10px;
    font-variant-numeric:tabular-nums;color:var(--ink);overflow-wrap:anywhere;line-height:1.15;
  }
  @media (max-width:360px){
    .wrap{padding:16px 12px 40px}
    .card{padding:16px 12px 14px}
    .dash,.facts{gap:6px}
    .tile{padding:8px}
  }
  .payee{margin:0 0 2px;font-size:14px;color:var(--ink)}
  .wait-head{display:flex;align-items:flex-start;gap:10px}
  .pulse{
    width:10px;height:10px;margin-top:7px;border-radius:999px;background:var(--cta);flex-shrink:0;
    animation:pulse 1.6s var(--ease) infinite;
  }
  .pulse.done{background:var(--ok);animation:none}
  .pulse.bad{background:var(--err);animation:none}
  @keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.82)}}
  .rcpt{
    white-space:pre-wrap;background:var(--tile);padding:12px;border-radius:8px;font-size:13px;
    font-family:ui-monospace,"Cascadia Mono","Segoe UI Mono",monospace;margin:12px 0 0;overflow:auto;
    border:1px solid var(--line);color:var(--ink);
  }
  @media (prefers-reduced-motion:reduce){
    button,.pulse,.card{transition:none;animation:none}
  }
</style>
</head>
<body data-gname="${gname}" data-gnumber="${gnumber}">
<a class="skip" href="#step-name">Skip to account lookup</a>
<main class="wrap">
${banner ? `<img class="banner" src="${banner}" alt="">` : ""}
<div class="brand">
  ${logo ? `<img class="mark-img" src="${logo}" alt="">` : `<span class="mark" aria-hidden="true">${initial}</span>`}
  <div><strong>${bizName}</strong><span>${bizPhone || "Customer billing"}</span></div>
</div>
${bizAddr ? `<p class="biz-meta">${bizAddr}</p>` : ""}
<h1>Pay or add credit</h1>
<p class="lede">${message}</p>
<ol class="prog" aria-label="Payment progress">
  <li id="prog-find" class="on">Find</li>
  <li id="prog-pay">Pay</li>
  <li id="prog-wait">Receipt</li>
</ol>

<div class="card" id="step-name">
  <label for="last">Last name</label>
  <input id="last" maxlength="40" autocomplete="family-name" placeholder="e.g. Cruz">
  <label for="first">First name</label>
  <input id="first" maxlength="40" autocomplete="given-name" placeholder="e.g. Juan">
  <label for="tail">Last 4 digits of your cellphone</label>
  <input id="tail" maxlength="4" inputmode="numeric" autocomplete="off" placeholder="e.g. 4567">
  <button type="button" id="find">Find my account<span class="btn-ico" aria-hidden="true">→</span></button>
  <p class="muted">Use the name on your bill. If we have your number, type its last 4 digits.</p>
</div>

<div class="card hide" id="step-hits"></div>

<div class="card hide" id="step-pay">
  <div id="who" class="who"></div>
  <div class="dash" id="dash">
    <div class="tile">
      <span class="k">Amount due</span>
      <span class="v" id="dash-due">₱0</span>
    </div>
    <div class="tile tile-wallet">
      <span class="k">Wallet</span>
      <span class="v" id="dash-wallet">₱0</span>
    </div>
  </div>
  <div class="substat" id="dash-status">
    <span class="substat-k">Status</span>
    <span class="substat-v" id="dash-status-v">—</span>
    <span class="substat-d" id="dash-until"></span>
  </div>
  <div class="facts">
    <p class="meta" id="dash-date"></p>
    <p class="meta" id="dash-plan"></p>
  </div>
  <p class="meta rec" id="dash-receipt"></p>
  <p class="note hide" id="dash-note"></p>
  <label for="purpose">What are you paying?</label>
  <select id="purpose">
    <option value="bill">Pay full bill</option>
    <option value="partial">Pay partial</option>
    <option value="topup">Add credit (wallet)</option>
  </select>
  <label for="amount" id="amt-lab">Amount</label>
  <input id="amount" inputmode="decimal" placeholder="e.g. 750">
  <div class="shell">
    <div class="shell-in">
      <div class="muted">Send this amount</div>
      <div class="amt" id="amt-show">₱0</div>
      ${gname ? `<p class="payee">Name: <b>${gname}</b></p>` : ""}
      ${gnumber ? `<p class="payee">Number: <b id="gnum">${gnumber}</b></p>` : `<p class="muted">Ask the office for the GCash number.</p>`}
      ${qr ? `<img class="qr" src="${qr}" alt="GCash QR">` : ""}
      ${gatewayOn ? `<button type="button" id="pay-now">Pay now with ${provider}<span class="btn-ico" aria-hidden="true">→</span></button>
      <p class="muted">Opens ${provider}. Pay there with GCash, card, or QR. This page waits after you finish.</p>` : ""}
      ${gcashManual ? `<p class="muted">GCash cannot auto-fill Send money. We copy the amount and open the app. Stay on this page, then paste the reference.</p>
      <button type="button" class="gcash" id="open-gcash">Open GCash and pay</button>` : ""}
    </div>
  </div>
  ${gcashManual ? `<label for="ref">GCash reference (after you pay)</label>
  <input id="ref" maxlength="40" autocomplete="off" placeholder="Reference number">
  <button type="button" id="send">I already paid</button>` : ""}
  <p class="meta" id="dash-status-foot"></p>
  <button type="button" class="ghost" id="back">Look up another name</button>
</div>

<div class="card hide" id="step-wait">
  <div class="wait-head">
    <span class="pulse" id="wait-dot" aria-hidden="true"></span>
    <p id="wait-msg" style="margin:0"><b>Waiting for approval.</b></p>
  </div>
  <p class="muted">Keep this page open. The office will approve in the app or Telegram. This page updates by itself.</p>
  <pre id="wait-receipt" class="rcpt hide"></pre>
</div>

<p id="result" aria-live="polite"></p>
${(brand.name || brand.phone || brand.address) ? `<footer class="biz-foot">${bizName}${bizPhone ? "<br>" + bizPhone : ""}${bizAddr ? "<br>" + bizAddr : ""}</footer>` : ""}
</main>
<script>
(function(){
  var pick = "";
  var dueAmt = 0;
  var waitTok = "";
  var waitN = 0;
  var openedGcash = false;
  var result = document.getElementById("result");
  function show(id){
    function vis(name, on){
      var el = document.getElementById("step-" + name);
      if (!el) return;
      if (on) el.classList.remove("hide");
      else el.classList.add("hide");
    }
    vis("name", id==="name");
    vis("hits", id==="hits");
    vis("pay", id==="pay");
    vis("wait", id==="wait");
    var cur = id==="wait" ? "prog-wait" : (id==="pay" || id==="hits" ? "prog-pay" : "prog-find");
    if (id==="hits") cur = "prog-find";
    ["prog-find","prog-pay","prog-wait"].forEach(function(pid){
      var p = document.getElementById(pid);
      if (!p) return;
      p.className = pid === cur ? "on" : ((id==="wait" && pid !== "prog-wait") || (id==="pay" && pid==="prog-find") ? "done" : "");
    });
  }
  function peso(n){ return "₱" + Number(n||0).toLocaleString("en-PH"); }
  function fail(msg){ result.className="err"; result.textContent=msg; }
  function ok(msg){ result.className="ok"; result.textContent=msg; }
  function payAmount(){
    var p = document.getElementById("purpose").value;
    var a = Number(document.getElementById("amount").value);
    if (p === "bill" && dueAmt > 0) return dueAmt;
    return a;
  }
  function syncAmt(){
    var a = payAmount();
    document.getElementById("amt-show").textContent = peso(a > 0 ? a : 0);
    var p = document.getElementById("purpose").value;
    document.getElementById("amount").disabled = (p === "bill" && dueAmt > 0);
  }

  document.getElementById("find").onclick = function(){
    result.textContent = "";
    var findBtn = document.getElementById("find");
    findBtn.disabled = true;
    findBtn.setAttribute("aria-busy", "true");
    fetch("/api/payment/lookup", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({
        lastName: document.getElementById("last").value,
        firstName: document.getElementById("first").value,
        phoneTail: document.getElementById("tail").value
      })
    }).then(function(r){ return r.json().then(function(j){ return {ok:r.ok, j:j}; }); })
      .then(function(x){
        if(!x.ok){ fail(x.j && x.j.error || "Could not search."); document.getElementById("last").focus(); return; }
        var hits = (x.j && x.j.matches) || [];
        if(!hits.length){ fail("No account found. Check the name and last 4 digits."); document.getElementById("last").focus(); return; }
        if(hits.length === 1){ choose(hits[0]); return; }
        var box = document.getElementById("step-hits");
        box.textContent = "";
        var p = document.createElement("p");
        p.textContent = "Several accounts match. Tap yours.";
        box.appendChild(p);
        hits.forEach(function(h){
          var b = document.createElement("button");
          b.type = "button";
          b.className = "hit";
          var nm = document.createElement("strong");
          nm.textContent = h.name || "Customer";
          b.appendChild(nm);
          var em = document.createElement("em");
          var bits = [];
          if (h.site) bits.push(h.site);
          if (h.plan) bits.push(h.plan);
          if (h.status && h.status.kind === "ok") bits.push("active until " + h.status.until);
          else if (h.status && h.status.kind === "due") bits.push("expires today");
          else if (h.status && h.status.kind === "over") bits.push("expired " + h.status.until);
          bits.push(h.amountDue ? ("due " + peso(h.amountDue)) : "no amount due");
          em.textContent = bits.join(" - ");
          b.appendChild(em);
          b.onclick = function(){ choose(h); };
          box.appendChild(b);
        });
        show("hits");
      }).catch(function(){ fail("Could not reach the server."); })
      .then(function(){
        findBtn.disabled = false;
        findBtn.removeAttribute("aria-busy");
      });
  };

  function onEnter(e){
    var k = e.key || e.keyCode;
    if (k === "Enter" || k === 13) document.getElementById("find").click();
  }
  ["last","first","tail"].forEach(function(id){
    var el = document.getElementById(id);
    if (el) el.onkeydown = onEnter;
  });

  function setText(id, text, hideIfEmpty){
    var el = document.getElementById(id);
    if (!el) return;
    el.textContent = text || "";
    if (hideIfEmpty) {
      if (text) el.classList.remove("hide");
      else el.classList.add("hide");
    }
  }

  function choose(h){
    pick = h.pick;
    dueAmt = Number(h.amountDue) || 0;
    var who = document.getElementById("who");
    who.textContent = "";
    var b = document.createElement("b");
    b.textContent = h.name || "Customer";
    who.appendChild(b);
    if (h.site) {
      var site = document.createElement("span");
      site.className = "site";
      site.textContent = h.site;
      who.appendChild(site);
    }
    setText("dash-due", dueAmt > 0 ? peso(dueAmt) : "₱0");
    setText("dash-wallet", peso(h.wallet));
    var st = h.status || {};
    var box = document.getElementById("dash-status");
    if (box) box.className = "substat" + (st.kind ? " " + st.kind : "");
    setText("dash-status-v", st.label || "Unknown");
    var until = "";
    if (st.kind === "ok") {
      until = "Valid until " + st.until;
      if (st.days != null) until += " · " + st.days + " day" + (st.days === 1 ? "" : "s") + " left";
    } else if (st.kind === "due") {
      until = "Expires today · " + (st.until || "");
    } else if (st.kind === "over") {
      until = "Expired on " + (st.until || "");
    } else if (st.until) {
      until = "Valid until " + st.until;
    } else {
      until = "No expiry date on this account.";
    }
    setText("dash-until", until);
    setText("dash-date", h.due ? ("Due " + h.due) : "No due date");
    setText("dash-status-foot", until);
    setText("dash-plan", h.plan ? ("Plan " + h.plan) : "", true);
    var rec = "";
    if (h.lastReceipt && h.lastReceipt.code) {
      rec = "Last receipt " + h.lastReceipt.code + " - " + peso(h.lastReceipt.amount);
    } else {
      rec = "No receipt on file yet.";
    }
    setText("dash-receipt", rec);
    document.getElementById("purpose").value = (h.notDue || !(dueAmt > 0)) ? "topup" : "bill";
    setText("dash-note", h.notDue ? "Not due yet - a payment now goes to your wallet." : "", true);
    document.getElementById("amount").value = dueAmt > 0 ? String(dueAmt) : "";
    syncAmt();
    show("pay");
    result.textContent = "";
  }

  document.getElementById("purpose").onchange = function(){
    var p = document.getElementById("purpose").value;
    if (p === "bill" && dueAmt > 0) document.getElementById("amount").value = String(dueAmt);
    if (p !== "bill") document.getElementById("amount").value = "";
    syncAmt();
  };
  document.getElementById("amount").oninput = syncAmt;

  var openBtn = document.getElementById("open-gcash");
  if (openBtn) openBtn.onclick = function(){
    var a = payAmount();
    if (!(a > 0)) { fail("Enter the amount first."); return; }
    syncAmt();
    try { if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(String(a)); } catch (e) {}
    openedGcash = true;
    ok("Amount " + peso(a) + " copied. GCash is opening. Send money, paste that amount, then come back and paste the reference.");
    var android = /Android/i.test(navigator.userAgent || "");
    var href = android
      ? "intent://#Intent;scheme=gcash;package=com.globe.gcash.android;end"
      : "gcash://";
    var link = document.createElement("a");
    link.href = href;
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  document.getElementById("back").onclick = function(){ pick=""; waitTok=""; show("name"); result.textContent=""; };

  var sendBtn = document.getElementById("send");
  if (sendBtn) sendBtn.onclick = function(){
    if(!pick){ fail("Find your account first."); return; }
    var purpose = document.getElementById("purpose").value === "topup" ? "topup" : "bill";
    result.textContent = "Submitting...";
    fetch("/api/payment/submit", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({
        pick: pick,
        purpose: purpose,
        ref: document.getElementById("ref").value,
        amount: payAmount()
      })
    }).then(function(r){ return r.json().then(function(j){ return {ok:r.ok, j:j}; }); })
      .then(function(x){
        if(!x.ok){ fail(x.j && x.j.error || "Could not submit."); return; }
        beginWait(x.j.token);
      }).catch(function(){ fail("Could not reach the server."); });
  };

  var payNow = document.getElementById("pay-now");
  if (payNow) payNow.onclick = function(){
    if(!pick){ fail("Find your account first."); return; }
    var a = payAmount();
    if (!(a > 0)) { fail("Enter the amount first."); return; }
    var purpose = document.getElementById("purpose").value === "topup" ? "topup" : "bill";
    result.textContent = "Opening payment...";
    fetch("/api/payment/checkout", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ pick: pick, purpose: purpose, amount: a })
    }).then(function(r){ return r.json().then(function(j){ return {ok:r.ok, j:j}; }); })
      .then(function(x){
        if(!x.ok){ fail(x.j && x.j.error || "Could not start payment."); return; }
        if (x.j.token) try { sessionStorage.setItem("mikcon-pay-wait", x.j.token); } catch (e) {}
        location.href = x.j.url;
      }).catch(function(){ fail("Could not reach the server."); });
  };

  function beginWait(tok){
    waitTok = tok;
    waitN = 0;
    var msg = document.getElementById("wait-msg");
    if (msg) msg.innerHTML = "<b>Waiting for approval.</b>";
    var dot = document.getElementById("wait-dot");
    if (dot) dot.className = "pulse";
    var rec = document.getElementById("wait-receipt");
    if (rec) { rec.textContent = ""; rec.classList.add("hide"); }
    show("wait");
    ok("Waiting for approval.");
    tickWait();
  }

  function tickWait(){
    if (!waitTok) return;
    fetch("/api/payment/status?token=" + encodeURIComponent(waitTok))
      .then(function(r){ return r.json(); })
      .then(function(j){
        if (j.status === "approved") {
          var top = j.purpose === "topup";
          ok(top ? "Approved. Credit was added to your wallet." : "Approved. You should be back online.");
          document.getElementById("wait-msg").textContent = top ? "Approved. Credit added." : "Approved. Reconnected.";
          var dot = document.getElementById("wait-dot");
          if (dot) { dot.className = "pulse done"; }
          if (j.receipt && j.receipt.text) {
            var box = document.getElementById("wait-receipt");
            box.textContent = j.receipt.text;
            box.classList.remove("hide");
          }
          waitTok = "";
          return;
        }
        if (j.status === "declined") {
          fail("The office declined this payment.");
          document.getElementById("wait-msg").textContent = "Declined.";
          var bad = document.getElementById("wait-dot");
          if (bad) { bad.className = "pulse bad"; }
          waitTok = "";
          return;
        }
        waitN++;
        if (waitN < 200) setTimeout(tickWait, 3000);
      }).catch(function(){ if (waitN < 200) { waitN++; setTimeout(tickWait, 4000); } });
  }

  document.addEventListener("visibilitychange", function(){
    if (document.visibilityState === "visible" && pick && !waitTok) {
      try { var rf = document.getElementById("ref"); if (rf) rf.focus(); } catch (e) {}
      if (openedGcash) {
        ok("Paste the GCash reference, then tap I already paid. The office will approve it.");
      }
    }
  });

  (function resumeWait(){
    var q = "";
    try { q = (location.search || "").replace(/^\\?/, ""); } catch (e) {}
    var params = {};
    q.split("&").forEach(function(p){
      var i = p.indexOf("=");
      if (i < 0) return;
      params[decodeURIComponent(p.slice(0,i))] = decodeURIComponent(p.slice(i+1).replace(/\\+/g, " "));
    });
    var tok = params.wait || "";
    if (!tok) {
      try { tok = sessionStorage.getItem("mikcon-pay-wait") || ""; } catch (e) {}
    }
    if (params.cancel) {
      try { sessionStorage.removeItem("mikcon-pay-wait"); } catch (e) {}
      fail("Payment was cancelled. You can try again.");
      return;
    }
    if (tok) beginWait(tok);
  })();
})();
</script>
</body>
</html>`;
}

const PAGE_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    ...PAGE_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

export function makePaymentApi({ db, payStore, clock, getConfig, onPending, routerNameOf, gateway, receipts }) {
  const take = makeRateLimiter();
  const picks = new Map();
  const listStmt = db.prepare(
    "SELECT router_id,kind,key,name,phone,price,due,bal,wallet,plan,raw_comment FROM customer WHERE name IS NOT NULL AND name != ''");

  function prunePicks() {
    const now = Date.now();
    for (const [k, v] of picks) if (v.exp < now) picks.delete(k);
  }

  function clientIp(req) {
    return (req.socket && req.socket.remoteAddress) || "unknown";
  }

  async function parseJson(req, res) {
    const contentType = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (contentType !== "application/json") {
      sendJson(res, 400, { error: "Content-Type must be application/json." });
      return null;
    }
    let raw;
    try { raw = await readBody(req, BODY_CAP); }
    catch (e) {
      sendJson(res, e && e.code === "BODY_TOO_LARGE" ? 413 : 400, { error: "Could not read the request." });
      return null;
    }
    try { return JSON.parse(raw.toString("utf8")); }
    catch {
      sendJson(res, 400, { error: "Invalid JSON." });
      return null;
    }
  }

  async function handleLookup(req, res) {
    if (!take(clientIp(req))) return sendJson(res, 429, { error: "Too many requests. Wait a moment." });
    const body = await parseJson(req, res);
    if (!body) return;
    const last = normalizeLastName(body.lastName);
    const first = normalizeFirstName(body.firstName);
    const phoneTail = normalizePhoneTail(body.phoneTail);
    if (!last || !first) return sendJson(res, 400, { error: "Enter your first name and last name." });
    prunePicks();
    const rows = listStmt.all();
    const matches = [];
    for (const row of rows) {
      const parsed = parseBill(row.raw_comment);
      const phone = row.phone || parsed.phone || "";
      if (!matchesAccount({ name: row.name, phone }, { lastName: last, firstName: first, phoneTail })) continue;
      const customer = {
        ...row,
        wallet: row.wallet != null ? row.wallet : parsed.wallet,
        bal: row.bal != null ? row.bal : parsed.bal,
        price: row.price != null ? row.price : parsed.price,
        due: row.due || parsed.due,
        plan: row.plan || parsed.plan || "",
      };
      const pick = randomUUID();
      picks.set(pick, {
        routerId: row.router_id,
        kind: row.kind,
        key: row.key,
        name: row.name,
        due: customer.due || "",
        exp: Date.now() + PICK_TTL_MS,
      });
      const site = typeof routerNameOf === "function" ? routerNameOf(row.router_id) : "";
      const lastRec = receipts && receipts.lastForCustomer
        ? receipts.lastForCustomer(row.router_id, row.key)
        : null;
      const today = clock && typeof clock.today === "function" ? clock.today() : "";
      const status = serviceStatus({ due: customer.due, today });
      matches.push({
        pick,
        ...publicCustomerCard(customer, site),
        notDue: status.kind === "ok",
        status,
        lastReceipt: publicReceipt(lastRec),
      });
      if (matches.length >= 12) break;
    }
    sendJson(res, 200, { matches });
  }

  async function handleSubmit(req, res) {
    const ip = clientIp(req);
    if (!take(ip)) return sendJson(res, 429, { error: "Too many requests. Wait a moment." });
    const body = await parseJson(req, res);
    if (!body) return;
    prunePicks();
    const hit = picks.get(String(body.pick || ""));
    if (!hit || hit.exp < Date.now()) {
      return sendJson(res, 400, { error: "Find your account again, then submit." });
    }
    let purpose = String(body.purpose || "bill").toLowerCase() === "topup" ? "topup" : "bill";
    if (hit.due && clock.today() && String(hit.due) > String(clock.today())) purpose = "topup";
    const norm = normalizeSubmission({ account: hit.name, ref: body.ref, amount: body.amount });
    if (!norm.ok) return sendJson(res, 400, { error: norm.error });
    let created;
    try {
      created = payStore.create({
        routerId: hit.routerId,
        request: { ...norm.request, purpose },
        customerKey: hit.key,
        clientIp: ip,
        purpose,
      });
    } catch {
      return sendJson(res, 400, { error: "That reference was already submitted." });
    }
    picks.delete(String(body.pick || ""));
    const row = payStore.byToken(created.token);
    try { if (onPending) await onPending(row); } catch {}
    sendJson(res, 200, { token: created.token });
  }

  async function handleCheckout(req, res) {
    const ip = clientIp(req);
    if (!take(ip)) return sendJson(res, 429, { error: "Too many requests. Wait a moment." });
    if (!gateway || typeof gateway.createCheckout !== "function" || !gateway.enabled()) {
      return sendJson(res, 400, { error: "Payment gateway is off." });
    }
    const body = await parseJson(req, res);
    if (!body) return;
    prunePicks();
    const hit = picks.get(String(body.pick || ""));
    if (!hit || hit.exp < Date.now()) {
      return sendJson(res, 400, { error: "Find your account again, then pay." });
    }
    let purpose = String(body.purpose || "bill").toLowerCase() === "topup" ? "topup" : "bill";
    if (hit.due && clock.today() && String(hit.due) > String(clock.today())) purpose = "topup";
    const amount = Math.round(Number(body.amount) * 100) / 100;
    if (!(amount > 0)) return sendJson(res, 400, { error: "Enter the amount you want to pay." });
    const provider = gateway.provider();
    const prefixTok = randomUUID();
    const ref = gateway.ref ? gateway.ref(provider, prefixTok) : ((provider === "xendit" ? "XN" : "PM") + prefixTok.replace(/-/g, "").slice(0, 16));
    let created;
    try {
      created = payStore.create({
        routerId: hit.routerId,
        request: { account: hit.name, ref, amount },
        customerKey: hit.key,
        clientIp: ip,
        purpose,
      });
    } catch {
      return sendJson(res, 400, { error: "Could not start this payment. Try again." });
    }
    const successUrl = gateway.successUrl(created.token, req);
    const cancelUrl = gateway.cancelUrl(req);
    if (!/^https?:\/\//i.test(successUrl)) {
      try { payStore.decide(created.id, "declined"); } catch {}
      return sendJson(res, 400, { error: "Set the public HTTPS URL in Payment Gateway first." });
    }
    let session;
    try {
      session = await gateway.createCheckout({
        token: created.token,
        amount,
        description: (purpose === "topup" ? "Add credit · " : "Bill · ") + hit.name,
        successUrl,
        cancelUrl,
      });
    } catch (e) {
      try { payStore.decide(created.id, "declined"); } catch {}
      return sendJson(res, 400, { error: (e && e.message) || "Payment provider failed." });
    }
    if (!session || !session.ok || !session.url) {
      try { payStore.decide(created.id, "declined"); } catch {}
      return sendJson(res, 400, { error: (session && session.error) || "Payment provider failed." });
    }
    picks.delete(String(body.pick || ""));
    sendJson(res, 200, { token: created.token, url: session.url });
  }

  function handleStatus(req, res, url) {
    const tk = url.searchParams.get("token");
    const row = tk ? payStore.byToken(tk) : null;
    if (!row) return sendJson(res, 404, { status: "unknown" });
    let rec = null;
    if (receipts) {
      rec = (row.id != null && receipts.lastForRequest(row.id))
        || receipts.lastForCustomer(row.router_id, row.customer_key);
    }
    sendJson(res, 200, {
      status: row.status,
      purpose: row.purpose || "bill",
      receipt: publicReceipt(rec),
    });
  }

  function handleReceipt(req, res, url) {
    const code = url.searchParams.get("code");
    const rec = receipts && code ? receipts.byCode(code) : null;
    if (!rec) return sendJson(res, 404, { error: "Receipt not found." });
    sendJson(res, 200, publicReceipt(rec));
  }

  function handlePage(req, res) {
    const html = renderPaymentPage(typeof getConfig === "function" ? getConfig() : {});
    res.writeHead(200, {
      ...PAGE_HEADERS,
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "Content-Length": Buffer.byteLength(html),
    });
    res.end(html);
  }

  return { handleLookup, handleSubmit, handleCheckout, handleStatus, handleReceipt, handlePage };
}
