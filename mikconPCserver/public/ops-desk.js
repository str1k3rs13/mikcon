/* PC-server only. Router watchdog, due reminders, install/repair jobs. ES5. */
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
  function actor() {
    if (typeof window.staffActor === "function") return window.staffActor();
    return { name: "Admin", role: "admin" };
  }
  function isAdmin() {
    var r = String(actor().role || "");
    return r === "admin" || r === "owner";
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function peso(n) {
    return "₱" + (Math.round((Number(n) || 0) * 100) / 100).toLocaleString("en-PH");
  }
  function toast(msg, kind) {
    if (window.toast) window.toast(msg, kind || "ok");
  }
  function activeRouterId() {
    try {
      if (window.activeId) return String(window.activeId);
    } catch (e) {}
    return "";
  }

  onReady(function () {
    var nav = document.querySelector("nav.tabs");
    var main = document.querySelector("main");
    if (!nav || !main) return;

    function paint(el) {
      if (typeof window.paintIcons === "function") window.paintIcons(el);
    }

    var tab = document.createElement("button");
    tab.id = "tab-jobs";
    tab.innerHTML = '<span class="i" data-icon="wrench" data-icon-size="20"></span>Jobs';
    tab.onclick = function () { window.go("jobs"); };
    nav.appendChild(tab);
    paint(tab);

    function canOpen(view) {
      if (typeof window.pcCanOpen !== "function") return true;
      return !!window.pcCanOpen(view);
    }
    function paintPerms() {
      tab.classList.toggle("hide", !canOpen("jobs"));
    }
    paintPerms();
    if (typeof window.applyPanelPerms === "function") {
      var origPerms = window.applyPanelPerms;
      window.applyPanelPerms = function () {
        origPerms.apply(this, arguments);
        paintPerms();
      };
    }

    var view = document.createElement("section");
    view.id = "view-jobs";
    view.className = "hide";
    view.innerHTML =
      '<div class="card">' +
        '<h2><span data-icon="wrench"></span>Install / repair</h2>' +
        '<div class="sub">Close an install only after the PPPoE or IPoE client exists on the plan.</div>' +
        '<label>Type</label><select id="job-kind"><option value="install">Install</option><option value="repair">Repair (24h SLA)</option></select>' +
        '<label>Name</label><input id="job-name" placeholder="Household name">' +
        '<label>Phone</label><input id="job-phone" placeholder="09…">' +
        '<label>Address</label><input id="job-addr" placeholder="Purok / street">' +
        '<label>Plan</label><input id="job-plan" placeholder="Same name as the router plan">' +
        '<label>Note</label><input id="job-note" placeholder="Optional">' +
        '<button id="job-add" type="button" style="width:100%;margin-top:10px"><span data-icon="plus" data-icon-size="15"></span>Open ticket</button>' +
        '<div id="job-err" class="muted" style="color:var(--bad);margin-top:8px"></div>' +
      "</div>" +
      '<div class="card"><h2><span data-icon="wrench"></span>Open jobs</h2><div id="job-list"></div></div>';
    main.appendChild(view);
    paint(view);

    var status = $("view-status");
    if (status) {
      var rem = document.createElement("div");
      rem.className = "card";
      rem.id = "ops-remind-card";
      rem.innerHTML = '<h2><span data-icon="phone"></span>Due reminders</h2><div class="sub">SMS to the client 3 days before, 1 day before, and on the due date when Semaphore or a USB dongle is set. The owner still gets Telegram. Stops after they pay. Cut-off still handles overdue.</div><div id="ops-remind"></div>';
      status.insertBefore(rem, status.firstChild);
      var w = document.createElement("div");
      w.className = "card";
      w.id = "ops-watch-card";
      w.innerHTML = '<h2><span data-icon="activity"></span>Router watchdog</h2><div class="sub">One Telegram when a router goes down, cut-off is wrong, or the clock is bad. Nightly backup is saved on this PC.</div><div id="ops-watch"></div>';
      status.insertBefore(w, rem.nextSibling);
      paint(status);
    }

    function stageLabel(s) {
      if (s === "d3") return "in 3 days";
      if (s === "d1") return "tomorrow";
      if (s === "due") return "today";
      return s || "";
    }
    function loadRemind() {
      var p = api();
      if (!p || !p.listReminders || !$("ops-remind")) return;
      p.listReminders().then(function (j) {
        var rows = (j && j.rows) || [];
        $("ops-remind").innerHTML = rows.map(function (r) {
          return "<div class=\"item\" style=\"padding:8px 0;border-bottom:1px solid var(--line)\">" +
            "<b>" + esc(r.name || r.customer_key) + "</b> " + peso(r.amount) +
            "<div class=\"muted\">Due " + esc(stageLabel(r.stage)) +
            (r.due ? " (" + esc(r.due) + ")" : "") +
            (r.at ? " · sent " + esc(r.at) : "") + "</div></div>";
        }).join("") || "<div class=\"muted\">No reminders sent yet. They go out on the next poll when a bill is 3 days, 1 day, or due today.</div>";
      }).catch(function () {});
    }
    function loadWatch() {
      var p = api();
      if (!p || !p.getWatchdog || !$("ops-watch")) return;
      p.getWatchdog().then(function (j) {
        var rows = (j && j.routers) || [];
        if (!j.clockSane) {
          $("ops-watch").innerHTML = "<div class=\"muted\" style=\"color:var(--bad)\">This PC clock is wrong. Backups and cut-off checks are paused.</div>";
          return;
        }
        $("ops-watch").innerHTML = rows.map(function (r) {
          var ok = r.reachable === "ok" && (!r.cutoff || r.cutoff === "ok");
          return "<div class=\"item\" style=\"padding:8px 0;border-bottom:1px solid var(--line)\">" +
            "<b>" + esc(r.name || r.router_id) + "</b> · " + (ok ? "ok" : esc(r.reachable === "down" ? "down" : r.cutoff || r.reachable)) +
            "<div class=\"muted\">last look " + esc(r.checked_at || "") +
            (r.last_export ? " · backup " + esc(r.last_export) : "") + "</div></div>";
        }).join("") || "<div class=\"muted\">No routers checked yet. Wait for the next poll.</div>";
      }).catch(function () {});
    }

    function renderJobs(rows) {
      $("job-list").innerHTML = (rows || []).map(function (t) {
        var late = t.overdue && t.status !== "closed" && t.status !== "cancelled";
        return "<div class=\"item\" style=\"padding:10px 0;border-bottom:1px solid var(--line)\">" +
          "<b>" + esc(t.name) + "</b> · " + esc(t.kind) + " · " + esc(t.status) +
          (late ? " · <span style=\"color:var(--bad)\">SLA</span>" : "") +
          "<div class=\"muted\">" + esc(t.plan || "") + (t.assigned_to ? " · " + esc(t.assigned_to) : "") +
          (t.due_by ? " · due " + esc(t.due_by) : "") + "</div>" +
          (t.status === "closed" || t.status === "cancelled" ? "" :
            "<div class=\"row\" style=\"gap:6px;margin-top:6px;flex-wrap:wrap\">" +
              (t.status === "open" && t.kind === "install" ? "<button class=\"ghost sm\" type=\"button\" data-act=\"survey\" data-id=\"" + t.id + "\">Surveyed</button>" : "") +
              "<button class=\"ghost sm\" type=\"button\" data-act=\"assign\" data-id=\"" + t.id + "\">Assign me</button>" +
              "<button class=\"sm\" type=\"button\" data-act=\"close\" data-id=\"" + t.id + "\">Close / activate</button>" +
              (isAdmin() ? "<button class=\"ghost sm\" type=\"button\" data-act=\"cancel\" data-id=\"" + t.id + "\">Cancel</button>" : "") +
            "</div>") +
          "</div>";
      }).join("") || "<div class=\"muted\">No tickets.</div>";
    }

    function loadJobs() {
      var p = api();
      if (!p || !p.listJobs) return;
      p.listJobs().then(renderJobs).catch(function (e) {
        $("job-err").textContent = (e && e.message) || "Could not load jobs.";
      });
    }

    if ($("job-add")) {
      $("job-add").onclick = function () {
        var p = api();
        if (!p || !p.createJob) return;
        $("job-err").textContent = "";
        p.createJob({
          router_id: activeRouterId(),
          kind: $("job-kind").value,
          name: $("job-name").value,
          phone: $("job-phone").value,
          address: $("job-addr").value,
          plan: $("job-plan").value,
          note: $("job-note").value
        }).then(function () {
          $("job-name").value = "";
          $("job-phone").value = "";
          $("job-addr").value = "";
          $("job-note").value = "";
          toast("Ticket opened.", "ok");
          loadJobs();
        }).catch(function (e) {
          $("job-err").textContent = (e && e.message) || "Could not open ticket.";
        });
      };
    }
    if ($("job-list")) {
      $("job-list").onclick = function (ev) {
        var btn = ev.target && ev.target.closest ? ev.target.closest("[data-act]") : null;
        if (!btn) return;
        var p = api();
        if (!p) return;
        var id = btn.getAttribute("data-id");
        var act = btn.getAttribute("data-act");
        var who = actor();
        if (act === "close") {
          var key = window.prompt("PPPoE username or IPoE MAC / IP on the router", "");
          p.closeJob({ id: id, customer_key: key }).then(function (r) {
            if (!r.ok) { toast(r.error || "Could not close.", "bad"); return; }
            toast("Ticket closed.", "ok");
            loadJobs();
          }).catch(function (e) { toast((e && e.message) || "Could not close.", "bad"); });
          return;
        }
        p.advanceJob({
          id: id, action: act,
          assigned_to: act === "assign" ? who.name : undefined
        }).then(function () { loadJobs(); })
          .catch(function (e) { toast((e && e.message) || "Could not update.", "bad"); });
      };
    }
    var origGo = window.go;
    window.go = function (v) {
      view.classList.add("hide");
      tab.classList.remove("on");
      if (v === "jobs") {
        if (!canOpen("jobs")) {
          if (typeof window.toast === "function") window.toast("Your account cannot open that screen.", "bad");
          return;
        }
        ["status", "routers", "vouchers", "users", "pppoe", "vendos", "sales", "sms", "map", "settings"].forEach(function (x) {
          var pane = $("view-" + x);
          var t = $("tab-" + x);
          if (pane) pane.classList.add("hide");
          if (t) t.classList.remove("on");
        });
        view.classList.remove("hide");
        tab.classList.add("on");
        try { window.CUR_VIEW = "jobs"; } catch (e) {}
        if (window.stopStatus) window.stopStatus();
        loadJobs();
        return;
      }
      if (typeof origGo === "function") origGo(v);
      if (v === "status") { loadWatch(); loadRemind(); }
    };
  });
})();
