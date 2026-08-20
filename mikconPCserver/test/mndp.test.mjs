import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMndp } from "../main/mndp.js";

function tlv(type, valueBytes) {
  const h = Buffer.alloc(4);
  h.writeUInt16BE(type, 0);
  h.writeUInt16BE(valueBytes.length, 2);
  return Buffer.concat([h, Buffer.from(valueBytes)]);
}

test("parseMndp reads MAC + identity + board", () => {
  const pkt = Buffer.concat([
    Buffer.from([0, 0, 0, 0]),                                  // 4-byte header
    tlv(1, [0x00, 0x0c, 0x42, 0x11, 0x22, 0x33]),               // MAC-Address
    tlv(5, Buffer.from("Router1", "utf8")),                     // Identity
    tlv(12, Buffer.from("RB750", "utf8")),                      // Board name
  ]);
  const o = parseMndp(pkt, pkt.length);
  assert.equal(o.mac, "00:0C:42:11:22:33");
  assert.equal(o.identity, "Router1");
  assert.equal(o.board, "RB750");
});

test("parseMndp returns null when no MAC TLV is present", () => {
  const pkt = Buffer.concat([Buffer.from([0, 0, 0, 0]), tlv(5, Buffer.from("X", "utf8"))]);
  assert.equal(parseMndp(pkt, pkt.length), null);
});
