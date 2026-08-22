/* PC-server only. Semaphore / USB dongle setup, and PPPoE + IPoE on the notice picker. ES5. */
(function () {
  function onReady(fn) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn);
    else fn();
  }
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function tools() {
    try { return window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.AppTools; }
    catch (e) { return null; }
  }
  function toast(msg, kind) {
    if (window.toast) window.toast(msg, kind || "ok");
  }

  onReady(function () {
    var host = $("settings-pane-sms") || $("view-sms");
    if (!host) return;

    var style = document.createElement("style");
    style.textContent =
      ".sms-kind{font-size:10px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;" +
        "color:var(--accent2);margin-left:6px}" +
      "#sms-kind-filter{gap:6px;flex-wrap:wrap;margin-top:8px}" +
      "#sms-gateway-card input,#sms-gateway-card select{width:100%;box-sizing:border-box}" +
      "#sms-via-semaphore.hide,#sms-via-dongle.hide{display:none}";
    document.head.appendChild(style);

    var card = document.createElement("div");
    card.className = "card";
    card.id = "sms-gateway-card";
    card.innerHTML =
      "<h2><span data-icon=\"phone\"></span>Send from this PC</h2>" +
      "<div class=\"sub\">Use <b>Semaphore</b> (cloud, needs internet) or a <b>USB GSM dongle</b> plugged into this computer. " +
        "Notices and overdue reminders go to billed <b>PPPoE</b> and <b>IPoE</b> clients who have a mobile number.</div>" +
      "<label>How to send</label>" +
      "<select id=\"sms-via\">" +
        "<option value=\"none\">Not set</option>" +
        "<option value=\"semaphore\">Semaphore</option>" +
        "<option value=\"dongle\">USB GSM dongle</option>" +
      "</select>" +
      "<div id=\"sms-via-semaphore\" class=\"hide\">" +
        "<label>API key</label>" +
        "<input id=\"sms-sem-key\" type=\"password\" autocomplete=\"off\" placeholder=\"Semaphore apikey\">" +
        "<label>Sender name</label>" +
        "<input id=\"sms-sem-sender\" placeholder=\"Approved sender name\" maxlength=\"11\">" +
        "<div class=\"muted\" style=\"font-size:11.5px;margin-top:4px\">Get a key at semaphore.co. The sender name must already be approved on that account.</div>" +
      "</div>" +
      "<div id=\"sms-via-dongle\" class=\"hide\">" +
        "<label>COM port</label>" +
        "<div class=\"row\" style=\"gap:8px;align-items:end\">" +
          "<div style=\"flex:1\"><input id=\"sms-dongle-port\" list=\"sms-dongle-ports\" placeholder=\"COM3\" autocapitalize=\"off\"></div>" +
          "<button class=\"ghost sm shrink\" type=\"button\" id=\"sms-dongle-scan\">Scan</button>" +
        "</div>" +
        "<datalist id=\"sms-dongle-ports\"></datalist>" +
        "<label>Baud</label>" +
        "<input id=\"sms-dongle-baud\" placeholder=\"115200\" inputmode=\"numeric\">" +
        "<label>SIM PIN (if the SIM is locked)</label>" +
        "<input id=\"sms-dongle-pin\" type=\"password\" autocomplete=\"off\" placeholder=\"optional\">" +
        "<div class=\"muted\" style=\"font-size:11.5px;margin-top:4px\">Huawei, SIM800 and Wavecom dongles work. Pick the AT command port, not the diagnostics port.</div>" +
      "</div>" +
      "<button style=\"width:100%;margin-top:12px\" type=\"button\" id=\"sms-gateway-save\">Save SMS gateway</button>" +
      "<div id=\"sms-gateway-msg\" class=\"muted\" style=\"margin-top:8px\"></div>";

    if (host.firstChild) host.insertBefore(card, host.firstChild);
    else host.appendChild(card);
    if (typeof window.paintIcons === "function") window.paintIcons(card);

    var lastInfo = null;
    window._smsKind = window._smsKind || "all";

    function showVia(via) {
      var s = $("sms-via-semaphore");
      var d = $("sms-via-dongle");
      if (s) s.classList.toggle("hide", via !== "semaphore");
      if (d) d.classList.toggle("hide", via !== "dongle");
    }

    function fillPorts(ports) {
      var list = $("sms-dongle-ports");
      if (!list) return;
      list.innerHTML = (ports || []).map(function (p) {
        return "<option value=\"" + esc(p.id || p.label || "") + "\">";
      }).join("");
    }

    function applyInfo(info) {
      lastInfo = info || lastInfo;
      if (!info) return;
      var via = info.via || "none";
      if ($("sms-via")) $("sms-via").value = via;
      showVia(via);
      if ($("sms-sem-sender")) $("sms-sem-sender").value = (info.semaphore && info.semaphore.sendername) || "";
      if ($("sms-sem-key")) {
        $("sms-sem-key").value = "";
        $("sms-sem-key").placeholder = (info.semaphore && info.semaphore.hasKey) ? "saved — type to replace" : "Semaphore apikey";
      }
      if ($("sms-dongle-port")) $("sms-dongle-port").value = (info.dongle && info.dongle.port) || "";
      if ($("sms-dongle-baud")) $("sms-dongle-baud").value = String((info.dongle && info.dongle.baud) || 115200);
      if ($("sms-dongle-pin")) {
        $("sms-dongle-pin").value = "";
        $("sms-dongle-pin").placeholder = (info.dongle && info.dongle.hasPin) ? "saved — type to replace" : "optional";
      }
      relabelState(info);
    }

    function relabelState(info) {
      var st = $("sms-state");
      if (!st || !info) return;
      if (!info.canSend) {
        st.innerHTML = "<span style=\"color:var(--warn)\">SMS is not set up on this PC.</span> Choose Semaphore or a USB GSM dongle above.";
        return;
      }
      if (info.via === "semaphore") {
        st.innerHTML = "Ready. Notices send through Semaphore to PPPoE and IPoE clients with a mobile number.";
      } else if (info.via === "dongle") {
        st.innerHTML = "Ready. Notices send through the USB dongle (" +
          esc((info.dongle && info.dongle.port) || "") +
          ") to PPPoE and IPoE clients with a mobile number.";
      }
    }

    function addKindFilter() {
      var notice = $("sms-card-notice");
      if (!notice || $("sms-kind-filter")) return;
      var row = $("sms-notice-search") && $("sms-notice-search").parentNode;
      var bar = document.createElement("div");
      bar.id = "sms-kind-filter";
      bar.className = "row";
      bar.innerHTML =
        "<button type=\"button\" class=\"ghost sm\" data-kind=\"all\">All</button>" +
        "<button type=\"button\" class=\"ghost sm\" data-kind=\"ppp\">PPPoE</button>" +
        "<button type=\"button\" class=\"ghost sm\" data-kind=\"ipoe\">IPoE</button>";
      if (row && row.parentNode) row.parentNode.insertBefore(bar, row);
      else notice.insertBefore(bar, notice.firstChild);
      paintKind();
      bar.onclick = function (ev) {
        var btn = ev.target && ev.target.closest ? ev.target.closest("[data-kind]") : null;
        if (!btn) return;
        window._smsKind = btn.getAttribute("data-kind") || "all";
        paintKind();
        if (typeof window.renderNoticePicker === "function") window.renderNoticePicker();
      };
    }

    function paintKind() {
      var bar = $("sms-kind-filter");
      if (!bar) return;
      var btns = bar.querySelectorAll("[data-kind]");
      var cur = window._smsKind || "all";
      for (var i = 0; i < btns.length; i++) {
        if (btns[i].getAttribute("data-kind") === cur) btns[i].classList.add("on");
        else btns[i].classList.remove("on");
      }
    }

    function matchKind(b) {
      var k = window._smsKind || "all";
      if (k === "all") return true;
      var ty = b && b.type === "ipoe" ? "ipoe" : "ppp";
      return ty === k;
    }

    if (typeof window.noticeClients === "function") {
      var origClients = window.noticeClients;
      window.noticeClients = function () {
        return origClients().filter(matchKind);
      };
    }
    if (typeof window.noticeMissing === "function") {
      var origMissing = window.noticeMissing;
      window.noticeMissing = function () {
        return origMissing().filter(matchKind);
      };
    }

    function stampKinds() {
      var list = $("sms-notice-list");
      if (!list || typeof window.pppBills !== "function") return;
      var bills = window.pppBills() || [];
      var byName = {};
      for (var i = 0; i < bills.length; i++) {
        byName[bills[i].name] = bills[i].type === "ipoe" ? "IPoE" : "PPPoE";
      }
      var nms = list.querySelectorAll(".nm");
      for (var j = 0; j < nms.length; j++) {
        if (nms[j].querySelector(".sms-kind")) continue;
        var ty = byName[nms[j].textContent];
        if (!ty) continue;
        var pill = document.createElement("span");
        pill.className = "sms-kind";
        pill.textContent = ty;
        nms[j].appendChild(document.createTextNode(" "));
        nms[j].appendChild(pill);
      }
      var empty = list.querySelector(".empty");
      if (empty) {
        if (/No PPPoE clients with an amount/.test(empty.textContent || "")) {
          empty.textContent = "No billed PPPoE or IPoE clients with an amount set.";
        }
        if (/No client has a mobile number/.test(empty.textContent || "")) {
          empty.textContent = "No PPPoE or IPoE client has a mobile number yet.";
        }
      }
      var note = list.querySelector(".estnote");
      if (note && /PPPoE/.test(note.innerHTML || "") && /Mobile number/.test(note.innerHTML || "")) {
        note.innerHTML = "Add one in <b>PPPoE</b> or <b>IPoE</b> → edit client → Mobile number.";
      }
    }

    if (typeof window.renderNoticePicker === "function") {
      var origRender = window.renderNoticePicker;
      window.renderNoticePicker = function () {
        origRender.apply(this, arguments);
        stampKinds();
      };
    }

    if (typeof window.loadSmsPanel === "function") {
      var origLoad = window.loadSmsPanel;
      window.loadSmsPanel = function () {
        return Promise.resolve(origLoad.apply(this, arguments)).then(function () {
          addKindFilter();
          if (lastInfo) relabelState(lastInfo);
          else return loadInfo();
        }).catch(function () {
          addKindFilter();
        });
      };
    }

    function loadInfo() {
      var AT = tools();
      if (!AT || !AT.getSmsConfig) return Promise.resolve();
      return AT.getSmsConfig().then(function (info) {
        applyInfo(info);
        return info;
      }).catch(function () {});
    }

    function scanPorts() {
      var AT = tools();
      if (!AT || !AT.listSmsPorts) return;
      var btn = $("sms-dongle-scan");
      if (btn) btn.disabled = true;
      AT.listSmsPorts().then(function (j) {
        fillPorts((j && j.ports) || []);
        var n = ((j && j.ports) || []).length;
        if ($("sms-gateway-msg")) {
          $("sms-gateway-msg").textContent = n
            ? (n + " serial port" + (n === 1 ? "" : "s") + " found. Pick the AT command port.")
            : "No serial port found. Type COM3 (or /dev/ttyUSB0) if the dongle is already mapped.";
        }
      }).catch(function (e) {
        if ($("sms-gateway-msg")) $("sms-gateway-msg").textContent = (e && e.message) || "Could not scan ports.";
      }).then(function () {
        if (btn) btn.disabled = false;
      });
    }

    if ($("sms-via")) $("sms-via").onchange = function () { showVia(this.value); };
    if ($("sms-dongle-scan")) $("sms-dongle-scan").onclick = scanPorts;
    if ($("sms-gateway-save")) $("sms-gateway-save").onclick = function () {
      var AT = tools();
      if (!AT || !AT.setSmsConfig) { toast("SMS gateway is not available.", "bad"); return; }
      var btn = $("sms-gateway-save");
      btn.disabled = true;
      var via = ($("sms-via") && $("sms-via").value) || "none";
      var payload = {
        via: via,
        semaphore: {
          apikey: ($("sms-sem-key") && $("sms-sem-key").value) || "",
          sendername: ($("sms-sem-sender") && $("sms-sem-sender").value) || ""
        },
        dongle: {
          port: ($("sms-dongle-port") && $("sms-dongle-port").value) || "",
          baud: ($("sms-dongle-baud") && $("sms-dongle-baud").value) || 115200,
          pin: ($("sms-dongle-pin") && $("sms-dongle-pin").value) || ""
        }
      };
      AT.setSmsConfig(payload).then(function (info) {
        applyInfo(info);
        try { if (window.SMS) window.SMS.probed = false; } catch (e) {}
        if (typeof window.loadSmsPanel === "function") window.loadSmsPanel();
        toast(info && info.canSend ? "SMS gateway saved. You can send notices." : "SMS gateway saved.", "ok");
        if ($("sms-gateway-msg")) {
          $("sms-gateway-msg").textContent = info && info.canSend
            ? "Saved. Review and send a notice to PPPoE and IPoE clients below."
            : "Saved. Choose Semaphore or a USB dongle to enable sending.";
        }
      }).catch(function (e) {
        toast((e && e.message) || "Could not save SMS gateway.", "bad");
      }).then(function () { btn.disabled = false; });
    };

    addKindFilter();
    loadInfo();
  });
})();
