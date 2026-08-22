/* PC-server only. WISP client map: imported PPPoE/IPoE, pin or type coords. ES5. */
(function () {
  var PH_LAT = 12.8797;
  var PH_LNG = 121.7740;

  function onReady(fn) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn);
    else fn();
  }
  function $(id) { return document.getElementById(id); }
  function api() {
    try { return window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.PayReminder; }
    catch (e) { return null; }
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function toast(msg, kind) {
    if (window.toast) window.toast(msg, kind || "ok");
  }
  function activeRouterId() {
    try { if (window.activeId) return String(window.activeId); } catch (e) {}
    return "";
  }
  function statusLabel(s) {
    if (s === "online") return "Active";
    if (s === "expired") return "Expired";
    return "Inactive";
  }
  function tokenColor(name, fallback) {
    try {
      var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      if (v) return v;
    } catch (e) {}
    return fallback;
  }
  function statusColor(s) {
    if (s === "online") return tokenColor("--ok", "#0f7a30");
    if (s === "expired") return tokenColor("--bad", "#c4303c");
    return tokenColor("--warn", "#8a5d00");
  }
  function hidePanes(ids) {
    for (var i = 0; i < ids.length; i++) {
      var pane = $("view-" + ids[i]);
      var t = $("tab-" + ids[i]);
      if (pane) pane.classList.add("hide");
      if (t) t.classList.remove("on");
    }
  }
  function loadLeaflet(cb) {
    if (window.L) { cb(true); return; }
    var css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "/leaflet/leaflet.css";
    document.head.appendChild(css);
    var s = document.createElement("script");
    s.src = "/leaflet/leaflet.js";
    s.onload = function () { cb(!!window.L); };
    s.onerror = function () { cb(false); };
    document.head.appendChild(s);
  }

  onReady(function () {
    var nav = document.querySelector("nav.tabs");
    var main = document.querySelector("main");
    if (!nav || !main) return;

    function paint(el) {
      if (typeof window.paintIcons === "function") window.paintIcons(el);
    }

    var tab = document.createElement("button");
    tab.id = "tab-map";
    tab.innerHTML = '<span class="i" data-icon="activity" data-icon-size="20"></span>Map';
    tab.onclick = function () { window.go("map"); };
    nav.appendChild(tab);
    paint(tab);

    function canOpen(view) {
      if (typeof window.pcCanOpen !== "function") return true;
      return !!window.pcCanOpen(view);
    }
    function paintPerms() {
      tab.classList.toggle("hide", !canOpen("map"));
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
    view.id = "view-map";
    view.className = "hide";
    view.innerHTML =
      '<style>' +
        '#view-map{min-width:0;overflow:hidden}' +
        '#view-map .plant-wrap{display:grid;grid-template-columns:1fr;gap:12px;align-items:stretch;min-width:0}' +
        '#view-map .plant-side{min-width:0;max-width:100%;overflow:auto}' +
        '#view-map .plant-side .card{overflow:hidden}' +
        '#view-map .plant-side,#view-map .plant-side input,#view-map .plant-side select,#view-map .plant-side button,#view-map .plant-side textarea{' +
          'font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
          'font-size:15px;line-height:1.45;color:var(--text)}' +
        '#view-map .plant-side input,#view-map .plant-side select,#view-map .plant-side textarea{' +
          'display:block;width:100%;max-width:100%;background:var(--inset);border:1px solid var(--edge);' +
          'color:var(--text);border-radius:10px;padding:10px 12px;margin:0 0 8px;min-height:42px;box-sizing:border-box}' +
        '#view-map .plant-side input:focus,#view-map .plant-side select:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--soft)}' +
        '#view-map .plant-side label{display:block;font-size:11px;font-weight:600;color:var(--muted);' +
          'text-transform:uppercase;letter-spacing:.7px;margin:8px 0 4px;line-height:1.3}' +
        '#view-map .plant-side .sub{font-size:13px;line-height:1.4;color:var(--muted);margin:0 0 10px}' +
        '#view-map .plant-side h2{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
        '#view-map .coord-row,#view-map .btn-row,#view-map .pin-actions{display:flex;gap:8px;align-items:flex-end}' +
        '#view-map .coord-row>div{flex:1;min-width:0}' +
        '#view-map .btn-row{flex-wrap:wrap;margin-top:8px;align-items:stretch}' +
        '#view-map .btn-row button,#view-map .pin-actions button{flex:1 1 0;min-width:0;margin:0}' +
        '#view-map .pin-actions{margin:4px 0 8px}' +
        '#view-map .pin-actions button.on{outline:2px solid var(--accent)}' +
        '#view-map .filters{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0}' +
        '#view-map .filters button.on{outline:2px solid var(--accent)}' +
        '#view-map .dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;vertical-align:middle}' +
        '#plant-map-list{max-height:36vh;overflow:auto}' +
        '#plant-map-list .item{cursor:pointer;min-width:0}' +
        '#plant-map-list b,#plant-map-list .muted{word-break:break-word}' +
        '#plant-map-canvas{position:relative;isolation:isolate;z-index:0;min-width:0;min-height:280px;height:50vh;' +
          'border:1px solid var(--line);border-radius:14px;background:var(--inset);overflow:hidden}' +
        '#plant-map-canvas.leaflet-container{width:100%;height:100%;font-size:12px;line-height:1.4}' +
        '#plant-map-canvas img{max-width:none!important;width:auto!important;height:auto!important;padding:0!important;margin:0!important;border:0!important;border-radius:0!important;min-height:0!important}' +
        '#plant-map-hint{padding:16px;color:var(--muted);font-size:15px}' +
        '@media (min-width:900px){' +
          '#view-map{height:calc(100vh - 100px);max-height:calc(100vh - 100px)}' +
          '#view-map .plant-wrap{grid-template-columns:300px minmax(0,1fr);height:100%;overflow:hidden}' +
          '#view-map .plant-side{height:100%;overflow:auto;padding-right:2px}' +
          '#plant-map-canvas{height:100%;min-height:0}' +
          '#plant-map-list{max-height:none}' +
        '}' +
      '</style>' +
      '<div class="plant-wrap">' +
        '<div class="plant-side">' +
          '<div class="card">' +
            '<h2><span data-icon="activity"></span>Pin a house</h2>' +
            '<div class="sub">Choose a billed client, then pin the house on the map or type the numbers.</div>' +
            '<label for="site-find">Find client</label>' +
            '<input id="site-find" type="search" placeholder="Name or account" autocomplete="off">' +
            '<label for="site-key">Billed client</label>' +
            '<select id="site-key"><option value="">Choose a client</option></select>' +
            '<label for="site-name">Household name</label>' +
            '<input id="site-name" placeholder="How you know this house">' +
            '<label for="site-nap">Fiber box</label>' +
            '<input id="site-nap" placeholder="Box name, e.g. Street 12">' +
            '<label for="site-nap-port">Port on the box</label>' +
            '<input id="site-nap-port" placeholder="e.g. 4">' +
            '<label for="site-drop">Port at the house</label>' +
            '<input id="site-drop" placeholder="e.g. 1">' +
            '<label for="site-note">Landmark</label>' +
            '<input id="site-note" placeholder="Gate, floor, color of house">' +
            '<div class="pin-actions">' +
              '<button id="site-pin" class="ghost" type="button">Pin on map</button>' +
              '<button id="site-manual" class="ghost" type="button">Type numbers</button>' +
            '</div>' +
            '<div class="coord-row">' +
              '<div><label for="site-lat">North / south</label><input id="site-lat" inputmode="decimal" placeholder="14.599500"></div>' +
              '<div><label for="site-lng">East / west</label><input id="site-lng" inputmode="decimal" placeholder="120.984200"></div>' +
            '</div>' +
            '<div class="btn-row">' +
              '<button id="site-save" type="button" disabled>Save pin</button>' +
              '<button id="site-geo" class="ghost" type="button">My location</button>' +
              '<button id="site-del" class="ghost" type="button">Remove pin</button>' +
            '</div>' +
            '<div id="site-err" class="muted" style="color:var(--bad);margin-top:8px"></div>' +
          '</div>' +
          '<div class="card">' +
            '<h2>Clients</h2>' +
            '<div id="plant-map-counts" class="muted" style="margin-top:6px"></div>' +
            '<div class="filters">' +
              '<button class="ghost sm on" type="button" data-filter="all">All</button>' +
              '<button class="ghost sm" type="button" data-filter="online">Active</button>' +
              '<button class="ghost sm" type="button" data-filter="offline">Inactive</button>' +
              '<button class="ghost sm" type="button" data-filter="expired">Expired</button>' +
            '</div>' +
            '<div id="plant-map-list"></div>' +
          '</div>' +
        '</div>' +
        '<div id="plant-map-canvas"><div id="plant-map-hint">Loading map...</div></div>' +
      '</div>';
    main.appendChild(view);
    paint(view);

    var map = null;
    var markers = [];
    var rows = [];
    var filter = "all";
    var pinWait = false;
    var leafletTried = false;

    function queryText() {
      return String(($("site-find") && $("site-find").value) || "").trim().toLowerCase();
    }
    function matchesQuery(r, q) {
      if (!q) return true;
      var blob = ((r.name || "") + " " + (r.customer_key || "") + " " + (r.nap_name || "")).toLowerCase();
      return blob.indexOf(q) >= 0;
    }
    function visibleRows() {
      var q = queryText();
      var out = [];
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        if (filter !== "all" && r.status !== filter) continue;
        if (!matchesQuery(r, q)) continue;
        out.push(r);
      }
      return out;
    }
    function setSaveEnabled() {
      var btn = $("site-save");
      if (!btn) return;
      btn.disabled = !$("site-key") || !$("site-key").value;
    }
    function fillSelect(selected) {
      var sel = $("site-key");
      if (!sel) return;
      var q = queryText();
      var html = '<option value="">Choose a client</option>';
      var seen = {};
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        var k = String(r.customer_key || "");
        if (!k || seen[k]) continue;
        seen[k] = true;
        if (!matchesQuery(r, q)) continue;
        html += '<option value="' + esc(k) + '"' + (k === selected ? " selected" : "") + ">" +
          esc((r.name || k) + " - " + k) + "</option>";
      }
      sel.innerHTML = html;
      if (selected) sel.value = selected;
      setSaveEnabled();
    }
    function formValues() {
      return {
        router_id: activeRouterId(),
        customer_key: $("site-key").value,
        name: $("site-name").value,
        nap_name: $("site-nap").value,
        nap_port: $("site-nap-port").value,
        drop_port: $("site-drop").value,
        lat: $("site-lat").value,
        lng: $("site-lng").value,
        note: $("site-note").value
      };
    }
    function fillForm(r) {
      if (!r) return;
      $("site-key").value = r.customer_key || "";
      $("site-name").value = r.name || "";
      $("site-nap").value = r.nap_name || "";
      $("site-nap-port").value = r.nap_port || "";
      $("site-drop").value = r.drop_port || "";
      $("site-lat").value = r.lat == null ? "" : r.lat;
      $("site-lng").value = r.lng == null ? "" : r.lng;
      $("site-note").value = r.note || "";
      $("site-err").textContent = "";
      setSaveEnabled();
    }
    function clearMarkers() {
      for (var i = 0; i < markers.length; i++) {
        try { map.removeLayer(markers[i]); } catch (e) {}
      }
      markers = [];
    }
    function popupHtml(r) {
      return "<b>" + esc(r.name || r.customer_key) + "</b><br>" +
        statusLabel(r.status) +
        (r.nap_name || r.nap_port ? "<br>Box " + esc(r.nap_name || "") + (r.nap_port ? " port " + esc(r.nap_port) : "") : "") +
        (r.drop_port ? "<br>House port " + esc(r.drop_port) : "") +
        (r.plan ? "<br>" + esc(r.plan) : "") +
        (r.due ? "<br>Due " + esc(r.due) : "");
    }
    function addMarker(r) {
      if (!map || !window.L || !r.mapped) return;
      var color = statusColor(r.status);
      var m = window.L.circleMarker([Number(r.lat), Number(r.lng)], {
        radius: 8,
        color: color,
        fillColor: color,
        fillOpacity: 0.9,
        weight: 2
      }).addTo(map);
      m.bindPopup(popupHtml(r));
      m.on("click", function () { fillForm(r); });
      markers.push(m);
    }
    function fitMap() {
      if (!map || !window.L) return;
      var pts = [];
      for (var i = 0; i < markers.length; i++) pts.push(markers[i].getLatLng());
      if (pts.length === 1) map.setView(pts[0], 16);
      else if (pts.length > 1) map.fitBounds(window.L.latLngBounds(pts).pad(0.2));
      else map.setView([PH_LAT, PH_LNG], 6);
    }
    function paintMap() {
      if (!map) return;
      clearMarkers();
      var vis = visibleRows();
      for (var i = 0; i < vis.length; i++) addMarker(vis[i]);
      fitMap();
    }
    function renderList() {
      var vis = visibleRows();
      var html = "";
      for (var i = 0; i < vis.length; i++) {
        var r = vis[i];
        var color = statusColor(r.status);
        var line = r.mapped
          ? ("Box " + (r.nap_name || "-") + " · port " + (r.nap_port || "-") + " · house " + (r.drop_port || "-"))
          : "Not on map";
        html += '<div class="item" style="margin:0 0 8px" data-key="' + esc(r.customer_key) + '">' +
          '<span class="dot" style="background:' + color + '"></span><b>' + esc(r.name || r.customer_key) + "</b> · " + statusLabel(r.status) +
          '<div class="muted">' + esc(line) + "</div></div>";
      }
      $("plant-map-list").innerHTML = html || '<div class="muted">No billed clients yet. Open the router so PPPoE and IPoE accounts import here.</div>';
    }
    function renderCounts() {
      var n = { online: 0, offline: 0, expired: 0 };
      for (var i = 0; i < rows.length; i++) {
        if (n[rows[i].status] != null) n[rows[i].status] += 1;
      }
      $("plant-map-counts").innerHTML =
        '<span class="dot" style="background:' + statusColor("online") + '"></span>' + n.online + " active · " +
        '<span class="dot" style="background:' + statusColor("offline") + '"></span>' + n.offline + " inactive · " +
        '<span class="dot" style="background:' + statusColor("expired") + '"></span>' + n.expired + " expired";
    }
    function setPinWait(on) {
      pinWait = !!on;
      if ($("site-pin")) {
        if (pinWait) $("site-pin").classList.add("on");
        else $("site-pin").classList.remove("on");
      }
      if (map && map.getContainer) {
        try { map.getContainer().style.cursor = pinWait ? "crosshair" : ""; } catch (e) {}
      }
      var hint = $("plant-map-hint");
      if (hint && pinWait) hint.textContent = "Click the map to drop the pin.";
    }
    function applyTypedCoords() {
      if (!map || !window.L) return;
      var lat = Number($("site-lat").value);
      var lng = Number($("site-lng").value);
      if (!isFinite(lat) || !isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return;
      map.setView([lat, lng], 17);
    }
    function sizeMap() {
      if (!map) return;
      try {
        var el = map.getContainer();
        if (el) {
          el.style.width = "100%";
          el.style.height = "100%";
        }
        map.invalidateSize(true);
      } catch (e) {}
    }
    function ensureMap(cb) {
      if (map) { if (cb) cb(true); return; }
      if (leafletTried && !window.L) { if (cb) cb(false); return; }
      leafletTried = true;
      loadLeaflet(function (ok) {
        var canvas = $("plant-map-canvas");
        if (!ok || !window.L || !canvas) {
          if ($("plant-map-hint")) $("plant-map-hint").textContent = "Map could not load. You can still type the numbers and save.";
          if (cb) cb(false);
          return;
        }
        canvas.innerHTML = "";
        map = window.L.map(canvas).setView([PH_LAT, PH_LNG], 6);
        if (window.L.Icon && window.L.Icon.Default) window.L.Icon.Default.imagePath = "/leaflet/images/";
        window.L.tileLayer("/map-tiles/{z}/{x}/{y}.png", {
          maxZoom: 19,
          attribution: "OpenStreetMap"
        }).addTo(map);
        map.on("click", function (ev) {
          if (!ev || !ev.latlng) return;
          if (!pinWait && $("site-lat").value && $("site-lng").value) return;
          $("site-lat").value = ev.latlng.lat.toFixed(6);
          $("site-lng").value = ev.latlng.lng.toFixed(6);
          setPinWait(false);
        });
        sizeMap();
        setTimeout(sizeMap, 80);
        setTimeout(sizeMap, 300);
        if (cb) cb(true);
      });
    }
    function loadSites() {
      var p = api();
      if (!p || !p.listSites) {
        if ($("site-err")) $("site-err").textContent = "Open MikconPC Server in the browser on this PC. Map needs the server bridge.";
        return;
      }
      $("site-err").textContent = "";
      var keep = $("site-key") && $("site-key").value;
      p.listSites({ router_id: activeRouterId() }).then(function (j) {
        rows = (j && j.rows) || [];
        fillSelect(keep);
        renderCounts();
        renderList();
        ensureMap(function (ok) { if (ok) paintMap(); });
      }).catch(function (e) {
        $("site-err").textContent = (e && e.message) || "Could not load map.";
      });
    }

    if ($("site-save")) {
      $("site-save").onclick = function () {
        var p = api();
        if (!p || !p.saveSite || !$("site-key").value) return;
        $("site-err").textContent = "";
        p.saveSite(formValues()).then(function () {
          toast("Client pin saved.", "ok");
          loadSites();
        }).catch(function (e) {
          $("site-err").textContent = (e && e.message) || "Could not save.";
        });
      };
    }
    if ($("site-del")) {
      $("site-del").onclick = function () {
        var p = api();
        var key = $("site-key").value;
        if (!p || !p.deleteSite || !key) return;
        p.deleteSite({ router_id: activeRouterId(), customer_key: key }).then(function () {
          toast("Pin removed.", "ok");
          $("site-lat").value = "";
          $("site-lng").value = "";
          $("site-nap").value = "";
          $("site-nap-port").value = "";
          $("site-drop").value = "";
          $("site-note").value = "";
          loadSites();
        }).catch(function (e) {
          $("site-err").textContent = (e && e.message) || "Could not remove.";
        });
      };
    }
    if ($("site-geo")) {
      $("site-geo").onclick = function () {
        if (!navigator.geolocation) { toast("Location is not available on this device.", "bad"); return; }
        navigator.geolocation.getCurrentPosition(function (pos) {
          $("site-lat").value = pos.coords.latitude.toFixed(6);
          $("site-lng").value = pos.coords.longitude.toFixed(6);
          if (map) map.setView([pos.coords.latitude, pos.coords.longitude], 17);
        }, function () { toast("Could not read location.", "bad"); }, { enableHighAccuracy: true, timeout: 8000 });
      };
    }
    if ($("site-pin")) {
      $("site-pin").onclick = function () { setPinWait(true); };
    }
    if ($("site-manual")) {
      $("site-manual").onclick = function () {
        setPinWait(false);
        if ($("site-lat")) $("site-lat").focus();
      };
    }
    if ($("site-key")) {
      $("site-key").onchange = function () {
        setSaveEnabled();
        var key = $("site-key").value;
        var hit = null;
        for (var i = 0; i < rows.length; i++) if (rows[i].customer_key === key) { hit = rows[i]; break; }
        if (hit) {
          fillForm(hit);
          if (map && hit.mapped) map.setView([Number(hit.lat), Number(hit.lng)], 17);
        }
      };
    }
    if ($("site-find")) {
      $("site-find").oninput = function () {
        fillSelect($("site-key").value);
        renderList();
        paintMap();
      };
    }
    if ($("site-lat")) $("site-lat").onchange = applyTypedCoords;
    if ($("site-lng")) $("site-lng").onchange = applyTypedCoords;
    if ($("plant-map-list")) {
      $("plant-map-list").onclick = function (ev) {
        var item = ev.target && ev.target.closest ? ev.target.closest("[data-key]") : null;
        if (!item) return;
        var key = item.getAttribute("data-key");
        var hit = null;
        for (var i = 0; i < rows.length; i++) if (rows[i].customer_key === key) { hit = rows[i]; break; }
        if (!hit) return;
        fillSelect(hit.customer_key);
        fillForm(hit);
        if (map && hit.mapped) map.setView([Number(hit.lat), Number(hit.lng)], 17);
      };
    }
    view.addEventListener("click", function (ev) {
      var btn = ev.target && ev.target.closest ? ev.target.closest("[data-filter]") : null;
      if (!btn) return;
      filter = btn.getAttribute("data-filter") || "all";
      var btns = view.querySelectorAll("[data-filter]");
      for (var i = 0; i < btns.length; i++) {
        if (btns[i] === btn) btns[i].classList.add("on");
        else btns[i].classList.remove("on");
      }
      renderList();
      paintMap();
    });

    if (!window.__mikconMapResize) {
      window.__mikconMapResize = true;
      window.addEventListener("resize", function () { setTimeout(sizeMap, 50); });
    }
    var origGo = window.go;
    window.go = function (v) {
      view.classList.add("hide");
      tab.classList.remove("on");
      if (v === "map") {
        if (!canOpen("map")) {
          if (typeof window.toast === "function") window.toast("Your account cannot open that screen.", "bad");
          return;
        }
        hidePanes(["status", "routers", "vouchers", "users", "pppoe", "vendos", "sales", "sms", "jobs", "settings"]);
        view.classList.remove("hide");
        tab.classList.add("on");
        try { window.CUR_VIEW = "map"; } catch (e) {}
        if (window.stopStatus) window.stopStatus();
        loadSites();
        setTimeout(sizeMap, 80);
        setTimeout(sizeMap, 300);
        return;
      }
      if (typeof origGo === "function") origGo(v);
    };
  });
})();
