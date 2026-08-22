import test from "node:test";
import assert from "node:assert/strict";
import { openStore, SCHEMA_VERSION } from "../agent/store.js";
import { makeClientSiteStore, parseCoord, siteStatus } from "../agent/client-site.js";
import { replaceSessionLive } from "../agent/poller.js";

const clock = { today: () => "2026-08-22", now: () => new Date("2026-08-22T08:00:00") };

function seedCustomer(db, { key = "juan01", due = "2026-09-01", name = "Juan" } = {}) {
  db.prepare(`
    INSERT INTO customer (router_id,kind,key,raw_comment,last_seen,src,name,plan,due)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run("r1", "ppp", key, "[bill p=750]", "2026-08-22", "secret", name, "Fibre 20", due);
}

test("status is expired when due is past, else online or offline", () => {
  assert.equal(siteStatus({ online: true, due: "2026-09-01", today: "2026-08-22" }), "online");
  assert.equal(siteStatus({ online: false, due: "2026-09-01", today: "2026-08-22" }), "offline");
  assert.equal(siteStatus({ online: true, due: "2026-08-01", today: "2026-08-22" }), "expired");
  assert.equal(siteStatus({ online: false, due: "", today: "2026-08-22" }), "offline");
});

test("parseCoord rejects out of range and blank", () => {
  assert.equal(parseCoord("", -90, 90), null);
  assert.equal(parseCoord("14.5", -90, 90), 14.5);
  assert.equal(parseCoord("100", -90, 90), null);
  assert.equal(parseCoord("abc", -180, 180), null);
});

test("v9 adds client_site and session_live", () => {
  const db = openStore(":memory:");
  assert.equal(SCHEMA_VERSION, 9);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 9);
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  assert.ok(names.includes("client_site"));
  assert.ok(names.includes("session_live"));
  const cols = db.prepare("PRAGMA table_info(client_site)").all().map((c) => c.name);
  for (const c of ["router_id", "customer_key", "nap_name", "nap_port", "drop_port", "lat", "lng"]) {
    assert.ok(cols.includes(c), "missing " + c);
  }
  db.close();
});

test("save pin with NAP and drop port, then join live session as active", () => {
  const db = openStore(":memory:");
  seedCustomer(db);
  const sites = makeClientSiteStore({ db, clock });
  const saved = sites.save({
    router_id: "r1",
    customer_key: "juan01",
    name: "Juan",
    nap_name: "NAP-12",
    nap_port: "4",
    drop_port: "ONU-2",
    lat: 14.5995,
    lng: 120.9842,
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.row.status, "offline");
  replaceSessionLive(db, "r1", ["juan01"], "2026-08-22");
  const listed = sites.list("r1");
  assert.equal(listed.length, 1);
  assert.equal(listed[0].online, true);
  assert.equal(listed[0].status, "online");
  assert.equal(listed[0].nap_port, "4");
  assert.equal(listed[0].drop_port, "ONU-2");
  assert.equal(listed[0].plan, "Fibre 20");
  db.close();
});

test("expired billed client stays expired even if the session is up", () => {
  const db = openStore(":memory:");
  seedCustomer(db, { due: "2026-08-01" });
  const sites = makeClientSiteStore({ db, clock });
  sites.save({ router_id: "r1", customer_key: "juan01", nap_port: "1", drop_port: "2" });
  replaceSessionLive(db, "r1", ["juan01"], "2026-08-22");
  assert.equal(sites.get("r1", "juan01").status, "expired");
  db.close();
});

test("save refuses a blank client key and a bad latitude", () => {
  const db = openStore(":memory:");
  const sites = makeClientSiteStore({ db, clock });
  assert.equal(sites.save({ router_id: "r1" }).ok, false);
  const bad = sites.save({ router_id: "r1", customer_key: "x", lat: 200 });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Latitude/);
  db.close();
});

test("list imports billed PPPoE and IPoE so the map can choose them without typing", () => {
  const db = openStore(":memory:");
  seedCustomer(db, { key: "juan01", name: "Juan" });
  db.prepare(`
    INSERT INTO customer (router_id,kind,key,raw_comment,last_seen,src,name,plan,due)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run("r1", "ipoe", "AA:BB:CC:DD:EE:FF", "[bill p=500]", "2026-08-22", "lease", "Shop", "Home 10", "2026-09-01");
  const sites = makeClientSiteStore({ db, clock });
  const listed = sites.list("r1");
  assert.equal(listed.length, 2, "billed clients must appear on the map before a pin is saved");
  const keys = listed.map((r) => r.customer_key).sort();
  assert.deepEqual(keys, ["AA:BB:CC:DD:EE:FF", "juan01"]);
  const juan = listed.find((r) => r.customer_key === "juan01");
  assert.equal(juan.kind, "ppp");
  assert.equal(juan.mapped, false);
  assert.equal(juan.lat, null);
  const shop = listed.find((r) => r.customer_key === "AA:BB:CC:DD:EE:FF");
  assert.equal(shop.kind, "ipoe");
  sites.save({ router_id: "r1", customer_key: "juan01", lat: 14.5, lng: 121.0, nap_port: "4" });
  const after = sites.list("r1");
  assert.equal(after.length, 2);
  assert.equal(after.find((r) => r.customer_key === "juan01").mapped, true);
  assert.equal(after.find((r) => r.customer_key === "juan01").nap_port, "4");
  assert.equal(after.find((r) => r.customer_key === "AA:BB:CC:DD:EE:FF").mapped, false);
  db.close();
});

test("IPoE billed by lease MAC or queue IP shows active from session_live", () => {
  const db = openStore(":memory:");
  db.prepare(`
    INSERT INTO customer (router_id,kind,key,raw_comment,last_seen,src,name,plan,due)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run("r1", "ipoe", "10.0.0.7", "[bill p=500]", "2026-08-22", "queue", "Shop", "Home 10", "2026-09-01");
  replaceSessionLive(db, "r1", ["10.0.0.7", "AA:BB:CC:DD:EE:FF"], "2026-08-22");
  const sites = makeClientSiteStore({ db, clock });
  const shop = sites.list("r1").find((r) => r.customer_key === "10.0.0.7");
  assert.equal(shop.kind, "ipoe");
  assert.equal(shop.online, true);
  assert.equal(shop.status, "online");
  db.close();
});

test("remove deletes only that pin", () => {
  const db = openStore(":memory:");
  const sites = makeClientSiteStore({ db, clock });
  sites.save({ router_id: "r1", customer_key: "a", nap_port: "1" });
  sites.save({ router_id: "r1", customer_key: "b", nap_port: "2" });
  assert.equal(sites.remove("r1", "a").deleted, 1);
  assert.equal(sites.list("r1").length, 1);
  assert.equal(sites.list("r1")[0].customer_key, "b");
  db.close();
});
