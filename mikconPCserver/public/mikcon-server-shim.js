/* Capacitor bridge for the browser: talks to this PC's MikconPC Server over HTTP. ES5. */
(function () {
  function call(path, body) {
    return fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    }).then(function (r) {
      return r.json().then(function (j) {
        if (r.status === 401) { location.href = "/login"; throw new Error("Please sign in"); }
        if (!r.ok || (j && j.ok === false)) throw new Error((j && j.error) || ("HTTP " + r.status));
        return j;
      });
    });
  }
  function get(path) {
    return fetch(path, { credentials: "same-origin" }).then(function (r) {
      return r.json().then(function (j) {
        if (r.status === 401) { location.href = "/login"; throw new Error("Please sign in"); }
        if (!r.ok || (j && j.ok === false)) throw new Error((j && j.error) || ("HTTP " + r.status));
        return j;
      });
    });
  }
  var RouterApi = {
    exec: function (o) { return call("/api/bridge/router/exec", o || {}); },
    discover: function (o) { return call("/api/bridge/router/discover", o || {}).then(function (j) { return j.data; }); }
  };
  var AppTools = {
    secureGet: function (o) { return call("/api/bridge/secure/get", o || {}); },
    secureSet: function (o) { return call("/api/bridge/secure/set", o || {}).then(function () { return {}; }); },
    secureRemove: function (o) { return call("/api/bridge/secure/remove", o || {}).then(function () { return {}; }); },
    machineId: function () { return get("/api/bridge/machine-id"); },
    setMenuPanels: function () { return Promise.resolve({}); },
    openHtml: function (o) {
      var w = window.open("", "_blank");
      if (!w) return Promise.reject(new Error("popup blocked"));
      w.document.open();
      w.document.write(String((o && o.html) || ""));
      w.document.close();
      try { w.focus(); w.print(); } catch (e) {}
      return Promise.resolve({});
    },
    openUrl: function (o) {
      if (o && o.url) window.open(o.url, "_blank", "noopener,noreferrer");
      return Promise.resolve({});
    },
    dial: function (o) {
      if (o && o.number) location.href = "tel:" + String(o.number).replace(/[^0-9+]/g, "");
      return Promise.resolve({});
    },
    share: function () { return Promise.reject(new Error("share unavailable on desktop")); },
    installUpdate: function () { return Promise.reject(new Error("Use npm on this PC to update the server.")); },
    onUpdateProgress: function () {},
    smsInfo: function () { return get("/api/bridge/ops/sms/status"); },
    sendSms: function (o) { return call("/api/bridge/ops/sms/send", o || {}); },
    requestSmsPermission: function () {
      return get("/api/bridge/ops/sms/status").then(function (r) {
        return { hasPermission: !!(r && r.hasPermission), sims: (r && r.sims) || [] };
      });
    },
    smsReady: function () { return get("/api/bridge/ops/sms/status"); },
    getSmsConfig: function () { return get("/api/bridge/ops/sms/status"); },
    setSmsConfig: function (o) { return call("/api/bridge/ops/sms/config", o || {}); },
    listSmsPorts: function () { return get("/api/bridge/ops/sms/ports"); }
  };
  var CapacitorHttp = {
    request: function (o) { return call("/api/bridge/http", o || {}); }
  };
  var PayReminder = {
    getConfig: function () { return call("/api/bridge/pay/getConfig", {}); },
    setConfig: function (o) { return call("/api/bridge/pay/setConfig", o || {}); },
    listPending: function () { return call("/api/bridge/pay/listPending", {}); },
    decide: function (o) { return call("/api/bridge/pay/decide", o || {}); },
    listHistory: function () { return call("/api/bridge/pay/listHistory", {}); },
    clearHistory: function (o) { return call("/api/bridge/pay/clearHistory", o || {}); },
    listSales: function (o) { return call("/api/bridge/pay/listSales", o || {}); },
    getGateway: function () { return call("/api/bridge/pay/getGateway", {}); },
    setGateway: function (o) { return call("/api/bridge/pay/setGateway", o || {}); },
    listReceipts: function () { return call("/api/bridge/ops/receipts", {}); },
    dayClose: function (o) { return call("/api/bridge/ops/day", o || {}); },
    closeDay: function (o) { return call("/api/bridge/ops/closeDay", o || {}); },
    listRemit: function (o) { return call("/api/bridge/ops/remit", o || {}); },
    listJobs: function () { return get("/api/bridge/ops/jobs"); },
    createJob: function (o) { return call("/api/bridge/ops/jobs", o || {}); },
    advanceJob: function (o) { return call("/api/bridge/ops/jobAdvance", o || {}); },
    closeJob: function (o) { return call("/api/bridge/ops/jobClose", o || {}); },
    getWatchdog: function () { return get("/api/bridge/ops/watchdog"); },
    listReminders: function () { return get("/api/bridge/ops/reminders"); },
    listSites: function (o) {
      var q = (o && o.router_id) ? ("?router_id=" + encodeURIComponent(o.router_id)) : "";
      return get("/api/bridge/ops/sites" + q);
    },
    saveSite: function (o) { return call("/api/bridge/ops/sites", o || {}); },
    deleteSite: function (o) { return call("/api/bridge/ops/sites/delete", o || {}); }
  };
  window.Capacitor = {
    isNativePlatform: function () { return true; },
    getPlatform: function () { return "electron"; },
    Plugins: { RouterApi: RouterApi, AppTools: AppTools, CapacitorHttp: CapacitorHttp, PayReminder: PayReminder }
  };
  // Extra tabs are not in the original VIEWS list, so staff records never named them.
  // Owner (or anyone who can open Routers) sees all of them. Cashier with SMS sees
  // Settings → SMS only. Technician with Clients sees Jobs and Map.
  window.pcCanOpen = function (view) {
    var session = null;
    try { session = window._session; } catch (e) {}
    if (!session) return true;
    var role = String(session.role || "").toLowerCase();
    if (role === "owner") role = "admin";
    if (role === "admin") return true;
    var panels = session.panels || [];
    function has(id) {
      for (var i = 0; i < panels.length; i++) {
        if (String(panels[i]) === id) return true;
      }
      return false;
    }
    if (has("routers")) return true;
    var v = String(view || "");
    if (v === "jobs" || v === "map") return has("pppoe");
    if (v === "sms" || v === "settings") return has("sms");
    if (v === "biz" || v === "pair" || v === "staff") return false;
    return false;
  };
})();
