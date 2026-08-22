import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SMS,
  normalizeVia,
  toLocal09,
  toE164,
  mergeSmsConfig,
  canSendSms,
  publicSmsConfig,
  assertPort,
  sendSemaphore,
  sendDongle,
  sendSms,
} from "../agent/sms-send.js";

test("PH numbers collapse to 09 and +63", () => {
  assert.equal(toLocal09("09171234567"), "09171234567");
  assert.equal(toLocal09("+639171234567"), "09171234567");
  assert.equal(toLocal09("639171234567"), "09171234567");
  assert.equal(toE164("09171234567"), "+639171234567");
  assert.equal(toLocal09("021234567"), "");
  assert.equal(toE164("not-a-phone"), "");
});

test("via is semaphore, dongle, or none", () => {
  assert.equal(normalizeVia("Semaphore"), "semaphore");
  assert.equal(normalizeVia("dongle"), "dongle");
  assert.equal(normalizeVia("usb"), "none");
  assert.equal(normalizeVia(""), "none");
});

test("merge keeps API key and PIN when the form sends blanks", () => {
  const saved = mergeSmsConfig(DEFAULT_SMS, {
    via: "semaphore",
    semaphore: { apikey: "sekret", sendername: "JEFFNET" },
    dongle: { port: "COM3", pin: "1234" },
  });
  const next = mergeSmsConfig(saved, {
    via: "semaphore",
    semaphore: { apikey: "", sendername: "JEFFNET" },
    dongle: { port: "COM3", pin: "" },
  });
  assert.equal(next.semaphore.apikey, "sekret");
  assert.equal(next.dongle.pin, "1234");
  assert.equal(next.semaphore.sendername, "JEFFNET");
});

test("public view never includes the API key or PIN", () => {
  const pub = publicSmsConfig({
    via: "semaphore",
    semaphore: { apikey: "sekret", sendername: "JEFFNET" },
    dongle: { port: "COM5", baud: 9600, pin: "0000" },
  });
  assert.equal(pub.canSend, true);
  assert.equal(pub.hasPermission, true);
  assert.equal(pub.semaphore.hasKey, true);
  assert.equal(pub.semaphore.sendername, "JEFFNET");
  assert.equal(JSON.stringify(pub).includes("sekret"), false);
  assert.equal(JSON.stringify(pub).includes("0000"), false);
  assert.equal(pub.sims[0].label, "Semaphore");
});

test("canSend needs a key for Semaphore and a port for the dongle", () => {
  assert.equal(canSendSms(DEFAULT_SMS), false);
  assert.equal(canSendSms({ via: "semaphore", semaphore: { apikey: "" }, dongle: {} }), false);
  assert.equal(canSendSms({ via: "semaphore", semaphore: { apikey: "k" }, dongle: {} }), true);
  assert.equal(canSendSms({ via: "dongle", semaphore: {}, dongle: { port: "COM3" } }), true);
  assert.equal(canSendSms({ via: "dongle", semaphore: {}, dongle: { port: "" } }), false);
});

test("COM and tty paths are the only serial ports accepted", () => {
  assert.equal(assertPort("com3", "win32"), "COM3");
  assert.equal(assertPort("/dev/ttyUSB0", "linux"), "/dev/ttyUSB0");
  assert.throws(() => assertPort("COM3", "linux"));
  assert.throws(() => assertPort("/etc/passwd", "linux"));
  assert.throws(() => assertPort("C:\\\\Windows\\\\notepad.exe", "win32"));
});

test("Semaphore posts apikey, 09 number, message and sender name", async () => {
  const calls = [];
  const fetchFn = async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify([{ message_id: 9, status: "Pending", recipient: "09171234567" }]),
    };
  };
  const r = await sendSemaphore({
    apikey: "k",
    sendername: "JEFFNET",
    number: "+639171234567",
    message: "Line down tonight.",
    fetchFn,
  });
  assert.equal(r.ok, true);
  assert.equal(calls[0].url, "https://api.semaphore.co/api/v4/messages");
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.apikey, "k");
  assert.equal(body.number, "09171234567");
  assert.equal(body.message, "Line down tonight.");
  assert.equal(body.sendername, "JEFFNET");
});

test("Semaphore surfaces API error text", async () => {
  const fetchFn = async () => ({
    ok: false,
    status: 401,
    text: async () => JSON.stringify({ message: "Invalid API key." }),
  });
  await assert.rejects(
    () => sendSemaphore({ apikey: "bad", number: "09171234567", message: "hi", fetchFn }),
    /Invalid API key/
  );
});

function fakeDongle(replies) {
  const writes = [];
  let acc = "";
  return {
    writes,
    async write(s) {
      writes.push(s);
      const key = String(s).replace(/\r|\n|\x1a/g, " ").trim();
      for (const [match, reply] of replies) {
        if (key.indexOf(match) >= 0 || (match === "CTRLZ" && String(s).includes("\x1a"))) {
          acc += reply;
        }
      }
    },
    async readUntil(pred) {
      if (pred(acc)) {
        const out = acc;
        acc = "";
        return out;
      }
      throw new Error("USB dongle timed out");
    },
    async close() {},
  };
}

test("dongle sends AT text-mode CMGS then Ctrl-Z", async () => {
  const serial = fakeDongle([
    ["AT", "\r\nOK\r\n"],
    ["AT+CMGF=1", "\r\nOK\r\n"],
    ["AT+CMGS", "\r\n> "],
    ["CTRLZ", "\r\n+CMGS: 3\r\nOK\r\n"],
  ]);
  const r = await sendDongle({
    port: "COM3",
    number: "09171234567",
    message: "Due today.",
    openSerial: async () => serial,
  });
  assert.equal(r.ok, true);
  assert.ok(serial.writes.some((w) => w === "AT\r"));
  assert.ok(serial.writes.some((w) => w === "AT+CMGF=1\r"));
  assert.ok(serial.writes.some((w) => w.includes('AT+CMGS="+639171234567"')));
  assert.ok(serial.writes.some((w) => w === "Due today.\x1A"));
});

test("sendSms refuses until a gateway is configured", async () => {
  await assert.rejects(
    () => sendSms(DEFAULT_SMS, { number: "09171234567", body: "hi" }),
    /Set Semaphore or a USB GSM dongle/
  );
});

test("sendSms routes to Semaphore when via is semaphore", async () => {
  const calls = [];
  const fetchFn = async (url, opts) => {
    calls.push(opts.body);
    return { ok: true, status: 200, text: async () => "[]" };
  };
  await sendSms(
    { via: "semaphore", semaphore: { apikey: "k", sendername: "" }, dongle: { port: "" } },
    { number: "09171234567", body: "PPPoE and IPoE notice", fetchFn }
  );
  assert.match(calls[0], /PPPoE and IPoE notice/);
});
