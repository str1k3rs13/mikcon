// juanfi-app/www/vendo-status.js
// Pure, DOM-free helpers for the NodeMCU Active/Inactive status badge (Phase 1).
// Kept in its own file so the reachability decision + bounded-concurrency runner
// are unit-testable in Node (node --test) with zero dependencies. index.html loads
// it as a plain <script> (exposes window.VendoStatus); the Node tests import it as
// a CommonJS module (module.exports).
(function () {
  // Decide "is the board reachable?" from a RouterOS /ping API reply.
  // /ping streams one !re row per attempt; a successful reply carries a round-trip
  // "time" and the cumulative "received" counter climbs above 0. Either signal => up.
  function pingRepliesOnline(rows) {
    if (!rows || !rows.length) return false;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i] || {};
      if (Number(r.received || 0) > 0) return true;
      if (r.time != null && String(r.time) !== "") return true;
    }
    return false;
  }

  // Run async fn over items with at most `limit` in flight; resolve to results in
  // input order. Bounds how many simultaneous ping sockets we open to the router.
  function mapLimit(items, limit, fn) {
    return new Promise(function (resolve, reject) {
      var results = new Array(items.length);
      if (!items.length) return resolve(results);
      var cap = Math.max(1, Math.min(limit, items.length));
      var next = 0, done = 0, running = 0;
      function pump() {
        while (running < cap && next < items.length) {
          (function (idx) {
            running++;
            try {
              Promise.resolve(fn(items[idx], idx)).then(function (r) {
                results[idx] = r; running--; done++;
                if (done === items.length) resolve(results); else pump();
              }, reject);
            } catch (e) { reject(e); }
          })(next++);
        }
      }
      pump();
    });
  }

  var api = { pingRepliesOnline: pingRepliesOnline, mapLimit: mapLimit };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.VendoStatus = api;
})();
