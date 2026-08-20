/* PC-server only. Adds the Payment Gateway pane and moves GCash approval out of Payment Reminder. ES5. */
(function () {
  function onReady(fn) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn);
    else fn();
  }
  function $(id) { return document.getElementById(id); }
  function api() {
    try { return window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.PayReminder; }
    catch (e) { return null; }
  }
  function hideField(inputId) {
    var el = $(inputId);
    if (!el) return;
    el.style.display = "none";
    var lab = el.previousElementSibling;
    if (lab && lab.tagName === "LABEL") lab.style.display = "none";
  }

  onReady(function () {
    var row = document.querySelector(".client-modes");
    var rem = $("pane-reminder");
    if (!row || !rem) return;

    var btn = document.createElement("button");
    btn.id = "seg-gateway";
    btn.className = "ghost sm";
    btn.type = "button";
    btn.textContent = "Payment Gateway";
    btn.onclick = function () { window.clientMode("gateway"); };
    row.appendChild(btn);

    var pane = document.createElement("div");
    pane.id = "pane-gateway";
    pane.className = "hide";
    pane.innerHTML =
      '<div class="card">' +
        '<h2><span data-icon="coins"></span>Payment Gateway</h2>' +
        '<div class="sub">PayMongo or Xendit checkout. After the client pays, the server approves and reconnects by itself — no Telegram tap.</div>' +
        '<label style="display:flex;align-items:center;gap:9px;margin-top:4px;font-weight:600">' +
          '<input type="checkbox" id="pg-enable" style="width:auto;margin:0"> Enable payment gateway' +
        '</label>' +
        '<label>Provider</label>' +
        '<select id="pg-provider">' +
          '<option value="paymongo">PayMongo</option>' +
          '<option value="xendit">Xendit</option>' +
        '</select>' +
        '<label>Public HTTPS URL of this server</label>' +
        '<input id="pg-base" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="https://your-tunnel.trycloudflare.com">' +
        '<div class="muted" style="font-size:11.5px">PayMongo/Xendit send the paid notice here. Use Cloudflare Tunnel or Tailscale.</div>' +
        '<div id="pg-hooks" class="muted" style="font-size:11.5px;margin-top:6px"></div>' +
        '<div id="pg-paymongo-fields">' +
          '<label>PayMongo secret key</label>' +
          '<input id="pg-pm-secret" type="password" autocomplete="off" placeholder="sk_live_… or sk_test_…">' +
          '<label>PayMongo webhook secret</label>' +
          '<input id="pg-pm-hook" type="password" autocomplete="off" placeholder="whsk_…">' +
        '</div>' +
        '<div id="pg-xendit-fields" class="hide">' +
          '<label>Xendit secret key</label>' +
          '<input id="pg-xn-secret" type="password" autocomplete="off" placeholder="xnd_production_… or xnd_development_…">' +
          '<label>Xendit webhook token</label>' +
          '<input id="pg-xn-hook" type="password" autocomplete="off" placeholder="Callback verification token">' +
        '</div>' +
        '<div id="pg-error" class="muted" style="color:var(--bad);font-size:12px;margin-top:8px"></div>' +
        '<button id="pg-save" style="width:100%;margin-top:10px" type="button"><span data-icon="check" data-icon-size="15"></span>Save payment gateway</button>' +
      '</div>' +
      '<div class="card">' +
        '<h2><span data-icon="phone"></span>GCash Telegram / app approval</h2>' +
        '<div class="sub">Turn this off if you only want PayMongo or Xendit. Manual GCash on /payment and Telegram/app Approve stay off while this is unchecked.</div>' +
        '<label style="display:flex;align-items:center;gap:9px;margin-top:4px;font-weight:600">' +
          '<input type="checkbox" id="pg-gcash-manual" style="width:auto;margin:0"> Enable GCash Telegram and app approval' +
        '</label>' +
      '</div>';
    rem.parentNode.appendChild(pane);
    if (typeof window.paintIcons === "function") window.paintIcons(pane);

    var approval = $("pr-approval");
    var pending = $("pr-approval-pending");
    var hist = $("pr-approval-history");
    if (approval) pane.appendChild(approval);
    if (pending) pane.appendChild(pending);
    if (hist) pane.appendChild(hist);

    hideField("pr-intake-port");
    var en = $("pr-intake-enable");
    if (en) {
      var wrap = en.parentNode;
      if (wrap && wrap.tagName === "LABEL") wrap.style.display = "none";
    }

    function syncProviderFields() {
      var p = $("pg-provider").value;
      $("pg-paymongo-fields").className = p === "xendit" ? "hide" : "";
      $("pg-xendit-fields").className = p === "xendit" ? "" : "hide";
    }
    $("pg-provider").onchange = syncProviderFields;

    function fillHooks(view) {
      var lines = [];
      if (view.webhookPaymongo) lines.push("PayMongo webhook: " + view.webhookPaymongo);
      if (view.webhookXendit) lines.push("Xendit invoice webhook: " + view.webhookXendit);
      if (!lines.length) lines.push("Save a public HTTPS URL to see the webhook addresses.");
      $("pg-hooks").textContent = lines.join("  ·  ");
    }

    window.loadPaymentGateway = function () {
      var p = api();
      if (!p || !p.getGateway) return;
      p.getGateway().then(function (view) {
        $("pg-enable").checked = !!view.enabled;
        $("pg-provider").value = view.provider === "xendit" ? "xendit" : "paymongo";
        $("pg-base").value = view.publicBaseUrl || "";
        $("pg-gcash-manual").checked = view.gcashManual !== false;
        $("pg-pm-secret").value = "";
        $("pg-pm-hook").value = "";
        $("pg-xn-secret").value = "";
        $("pg-xn-hook").value = "";
        $("pg-pm-secret").placeholder = view.paymongo && view.paymongo.hasSecret ? "Saved — leave blank to keep it" : "sk_live_… or sk_test_…";
        $("pg-pm-hook").placeholder = view.paymongo && view.paymongo.hasWebhook ? "Saved — leave blank to keep it" : "whsk_…";
        $("pg-xn-secret").placeholder = view.xendit && view.xendit.hasSecret ? "Saved — leave blank to keep it" : "xnd_production_… or xnd_development_…";
        $("pg-xn-hook").placeholder = view.xendit && view.xendit.hasWebhook ? "Saved — leave blank to keep it" : "Callback verification token";
        $("pg-error").textContent = "";
        fillHooks(view);
        syncProviderFields();
      }).catch(function (e) {
        $("pg-error").textContent = (e && e.message) || "Could not read gateway settings.";
      });
      if (window.loadPayApproval) window.loadPayApproval();
    };

    $("pg-save").onclick = function () {
      var p = api();
      if (!p || !p.setGateway) return;
      var btn = $("pg-save");
      btn.disabled = true;
      p.setGateway({
        enabled: !!$("pg-enable").checked,
        provider: $("pg-provider").value,
        gcashManual: !!$("pg-gcash-manual").checked,
        publicBaseUrl: $("pg-base").value,
        paymongo: { secretKey: $("pg-pm-secret").value, webhookSecret: $("pg-pm-hook").value },
        xendit: { secretKey: $("pg-xn-secret").value, webhookToken: $("pg-xn-hook").value }
      }).then(function (view) {
        if (window.toast) window.toast("Payment gateway saved.", "ok");
        fillHooks(view || {});
        window.loadPaymentGateway();
      }).catch(function (e) {
        $("pg-error").textContent = (e && e.message) || "Could not save.";
        if (window.toast) window.toast((e && e.message) || "Could not save.", "bad");
      }).then(function () { btn.disabled = false; });
    };

    var orig = window.clientMode;
    window.clientMode = function (m) {
      if (m === "gateway") {
        try { window.CLIENT_MODE = "gateway"; } catch (e) {}
        ["ppp", "ipoe", "reminder"].forEach(function (x) {
          var paneEl = $("pane-" + x);
          var seg = $("seg-" + x);
          if (paneEl) paneEl.classList.add("hide");
          if (seg) seg.classList.add("ghost");
        });
        pane.classList.remove("hide");
        btn.classList.remove("ghost");
        if (window.stopThroughput) window.stopThroughput();
        window.loadPaymentGateway();
        return;
      }
      pane.classList.add("hide");
      btn.classList.add("ghost");
      if (typeof orig === "function") orig(m);
    };
  });
})();
