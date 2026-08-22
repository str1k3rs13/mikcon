/* PC-server only. Settings in the left rail: click Settings to drop the four items. ES5. */
(function () {
  function onReady(fn) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn);
    else fn();
  }
  function $(id) { return document.getElementById(id); }
  function paint(el) {
    if (typeof window.paintIcons === "function") window.paintIcons(el);
  }
  function hideSmsTab() {
    var t = $("tab-sms");
    if (t) {
      t.classList.add("hide");
      t.style.display = "none";
    }
  }
  function hidePanes(ids) {
    for (var i = 0; i < ids.length; i++) {
      var pane = $("view-" + ids[i]);
      var t = $("tab-" + ids[i]);
      if (pane) pane.classList.add("hide");
      if (t) t.classList.remove("on");
    }
  }
  function move(el, into) {
    if (el && into) into.appendChild(el);
  }
  function pane(id) {
    var d = document.createElement("div");
    d.id = id;
    d.className = "settings-pane hide";
    return d;
  }

  onReady(function () {
    var nav = document.querySelector("nav.tabs");
    var main = document.querySelector("main");
    if (!nav || !main) return;

    var style = document.createElement("style");
    style.textContent =
      "#settings-menu{display:none;flex-direction:column;width:100%;padding:0 0 4px 8px;gap:0}" +
      "#settings-menu.open{display:flex}" +
      "#settings-menu button{flex:0 0 auto;width:100%;justify-content:flex-start;text-align:left;" +
        "font-size:12.5px;font-weight:600;padding:8px 10px 8px 32px;border-radius:8px;" +
        "background:none;border:none;color:var(--muted)}" +
      "#settings-menu button.on{color:var(--accent2);background:var(--panel2)}" +
      "#tab-settings .settings-caret{margin-left:auto;font-size:11px;opacity:.7}" +
      "#view-settings .settings-pane.hide{display:none}" +
      "#settings-menu button.hide{display:none}" +
      "@media (max-width:899px){" +
        "#settings-menu{position:absolute;left:8px;right:8px;bottom:calc(56px + env(safe-area-inset-bottom));" +
          "background:var(--navbg);border:1px solid var(--line);border-radius:12px;padding:8px;z-index:40;box-shadow:0 8px 24px var(--shadow)}" +
        "#settings-menu button{padding:12px}" +
      "}";
    document.head.appendChild(style);

    var tab = document.createElement("button");
    tab.id = "tab-settings";
    tab.type = "button";
    tab.innerHTML = '<span class="i" data-icon="pencil" data-icon-size="20"></span>Settings<span class="settings-caret">▾</span>';
    nav.appendChild(tab);
    paint(tab);

    var menu = document.createElement("div");
    menu.id = "settings-menu";
    menu.innerHTML =
      '<button type="button" data-set="biz">Business name</button>' +
      '<button type="button" data-set="sms">SMS</button>' +
      '<button type="button" data-set="pair">Device pairing</button>' +
      '<button type="button" data-set="staff">Add staff</button>';
    if (tab.nextSibling) nav.insertBefore(menu, tab.nextSibling);
    else nav.appendChild(menu);

    var view = document.createElement("section");
    view.id = "view-settings";
    view.className = "hide";
    main.appendChild(view);

    var paneBiz = pane("settings-pane-biz");
    var paneSms = pane("settings-pane-sms");
    var panePair = pane("settings-pane-pair");
    var paneStaff = pane("settings-pane-staff");
    view.appendChild(paneBiz);
    view.appendChild(paneSms);
    view.appendChild(panePair);
    view.appendChild(paneStaff);

    move($("biz-card"), paneBiz);

    paneStaff.innerHTML = '<div class="card" id="settings-staff-card">' +
      '<h2><span data-icon="users"></span>Staff</h2>' +
      '<div class="sub">Give a cashier or technician a PIN and the screens they can open. Stored on the active router.</div>' +
      "</div>";
    var staffCard = $("settings-staff-card");
    var staffList = $("staff-list");
    var addStaff = staffList && staffList.nextElementSibling;
    move(staffList, staffCard);
    if (addStaff && addStaff.tagName === "BUTTON") move(addStaff, staffCard);

    var leftover = $("scan-list") && $("scan-list").parentNode;
    if (leftover && leftover !== staffCard) {
      var h2 = leftover.querySelector("h2");
      if (h2) h2.innerHTML = '<span data-icon="search"></span>Scan results';
      var oldSub = leftover.querySelector(".sub");
      if (oldSub && /cashier|technician|PIN/.test(oldSub.textContent || "")) oldSub.remove();
      paint(leftover);
    }

    panePair.innerHTML = '<div class="card" id="settings-pair-card">' +
      '<h2><span data-icon="open"></span>Device pairing</h2>' +
      '<div class="sub">Join this PC with a device that already paid, or accept a phone that wants to join.</div>' +
      "</div>";
    var pairCard = $("settings-pair-card");
    var lic = $("st-licid") && $("st-licid").parentNode;
    move(lic, pairCard);
    move($("st-pack"), pairCard);

    var sms = $("view-sms");
    if (sms) {
      while (sms.firstChild) paneSms.appendChild(sms.firstChild);
    }

    hideSmsTab();
    paint(view);
    paint(staffCard);
    paint(pairCard);

    function canOpen(view) {
      if (typeof window.pcCanOpen !== "function") return true;
      return !!window.pcCanOpen(view);
    }
    function firstSettings() {
      var ids = ["biz", "sms", "pair", "staff"];
      for (var i = 0; i < ids.length; i++) {
        if (canOpen(ids[i])) return ids[i];
      }
      return canOpen("sms") ? "sms" : "";
    }
    function blocked() {
      if (typeof window.toast === "function") window.toast("Your account cannot open that screen.", "bad");
    }
    function paintPerms() {
      hideSmsTab();
      tab.classList.toggle("hide", !canOpen("settings"));
      var btns = menu.querySelectorAll("[data-set]");
      for (var i = 0; i < btns.length; i++) {
        var k = btns[i].getAttribute("data-set");
        btns[i].classList.toggle("hide", !canOpen(k));
      }
      var jobs = $("tab-jobs");
      if (jobs) jobs.classList.toggle("hide", !canOpen("jobs"));
      var map = $("tab-map");
      if (map) map.classList.toggle("hide", !canOpen("map"));
    }

    function setMenuOpen(open) {
      if (open) menu.classList.add("open");
      else menu.classList.remove("open");
      var caret = tab.querySelector(".settings-caret");
      if (caret) caret.textContent = open ? "▴" : "▾";
    }

    function showPick(which) {
      var key = which || "biz";
      var ids = ["biz", "sms", "pair", "staff"];
      for (var i = 0; i < ids.length; i++) {
        var p = $("settings-pane-" + ids[i]);
        if (!p) continue;
        if (ids[i] === key) p.classList.remove("hide");
        else p.classList.add("hide");
      }
      var btns = menu.querySelectorAll("[data-set]");
      for (var j = 0; j < btns.length; j++) {
        if (btns[j].getAttribute("data-set") === key) btns[j].classList.add("on");
        else btns[j].classList.remove("on");
      }
      if (key === "sms" && typeof window.loadSmsPanel === "function") window.loadSmsPanel();
      if (key === "staff" && typeof window.loadStaffCard === "function") window.loadStaffCard();
    }

    function openSettings(which) {
      if (!canOpen("settings")) { blocked(); return; }
      var key = which && canOpen(which) ? which : firstSettings();
      if (!key) { blocked(); return; }
      hidePanes(["status", "routers", "vouchers", "users", "pppoe", "vendos", "sales", "sms", "jobs", "map"]);
      view.classList.remove("hide");
      tab.classList.add("on");
      setMenuOpen(true);
      try { window.CUR_VIEW = "settings"; } catch (e) {}
      if (window.stopStatus) window.stopStatus();
      showPick(key);
    }

    tab.onclick = function (ev) {
      if (ev) ev.stopPropagation();
      if (view.classList.contains("hide")) openSettings("biz");
      else setMenuOpen(!menu.classList.contains("open"));
    };
    menu.onclick = function (ev) {
      var btn = ev.target && ev.target.closest ? ev.target.closest("[data-set]") : null;
      if (!btn) {
        var n = ev.target;
        while (n && n !== menu) {
          if (n.getAttribute && n.getAttribute("data-set")) { btn = n; break; }
          n = n.parentNode;
        }
      }
      if (!btn) return;
      if (ev) ev.stopPropagation();
      openSettings(btn.getAttribute("data-set"));
    };

    paintPerms();
    if (typeof window.applyPanelPerms === "function") {
      var origPerms = window.applyPanelPerms;
      window.applyPanelPerms = function () {
        origPerms.apply(this, arguments);
        paintPerms();
      };
    }

    var origGo = window.go;
    window.go = function (v) {
      if (v !== "settings" && v !== "sms") {
        view.classList.add("hide");
        tab.classList.remove("on");
        setMenuOpen(false);
        var btns = menu.querySelectorAll("[data-set]");
        for (var i = 0; i < btns.length; i++) btns[i].classList.remove("on");
      }
      if (v === "settings") {
        if (!canOpen("settings")) { blocked(); return; }
        openSettings(firstSettings());
        return;
      }
      if (v === "sms") {
        if (!canOpen("sms")) { blocked(); return; }
        openSettings("sms");
        return;
      }
      if (typeof origGo === "function") origGo(v);
    };
  });
})();
