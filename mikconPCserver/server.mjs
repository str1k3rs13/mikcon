// MikconPC Server — no Electron window. `npm start` prints the browser URL and port.
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startHttpServer } from "./main/web-server.js";
import { listenUrls, formatListenBanner } from "./main/web-urls.js";
import { loadOrCreatePassword, makeSessionStore, readPasswordRecord } from "./main/web-auth.js";
import { tailscaleIPv4s, startCloudflareTunnel, startTailscaleServe } from "./main/web-tunnels.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const a = { port: Number(process.env.PORT) || 8787, host: "0.0.0.0", cloudflare: false, tailscale: false, resetPassword: false };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--port") a.port = Number(argv[++i]) || a.port;
    else if (t === "--host") a.host = String(argv[++i] || a.host);
    else if (t === "--cloudflare") a.cloudflare = true;
    else if (t === "--tailscale") a.tailscale = true;
    else if (t === "--reset-password") a.resetPassword = true;
    else if (t === "--help" || t === "-h") a.help = true;
  }
  return a;
}

function dataDir() {
  if (process.env.MIKCON_DATA) return process.env.MIKCON_DATA;
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "MikconPC Server");
  }
  return path.join(os.homedir(), ".mikcon-pc-server");
}

const HELP = `
MikconPC Server — open in a web browser. No popup app.

  npm start
  npm start -- --port 8787
  npm start -- --cloudflare
  npm start -- --tailscale
  npm start -- --reset-password

  --port N            listen port (default 8787, or PORT env)
  --cloudflare        start a Cloudflare quick tunnel (needs cloudflared)
  --tailscale         advertise via Tailscale Serve (needs tailscale)
  --reset-password    make a new login password and print it once
`;

const args = parseArgs(process.argv);
if (args.help) {
  process.stdout.write(HELP);
  process.exit(0);
}

const dir = dataDir();
const pass = loadOrCreatePassword(dir, {
  reset: args.resetPassword,
  fromEnv: process.env.MIKCON_PASSWORD || "",
});
const passwordRecord = pass.rec || readPasswordRecord(dir);
const extra = [];
let tunnelNote = "";

if (args.tailscale) {
  try {
    const served = await startTailscaleServe({ port: args.port });
    if (served.url) extra.push(served.url);
    else tunnelNote = "Tailscale Serve did not start. Install Tailscale, then run: tailscale serve --bg " + args.port;
  } catch {
    tunnelNote = "Tailscale CLI not found. Install Tailscale to use --tailscale.";
  }
} else {
  try {
    for (const ip of await tailscaleIPv4s()) extra.push("http://" + ip + ":" + args.port);
  } catch {}
}

const server = await startHttpServer({
  host: args.host,
  port: args.port,
  wwwDir: path.join(here, "app", "www"),
  publicDir: path.join(here, "public"),
  dataDir: dir,
  sessions: makeSessionStore(),
  passwordRecord,
});

const info = listenUrls({ port: args.port, extra });
process.stdout.write(formatListenBanner(info, {
  firstLogin: !!pass.mustChange,
  password: pass.mustChange ? "" : pass.password,
  tunnelNote: tunnelNote || (args.cloudflare ? "Starting Cloudflare tunnel…" : ""),
}));

let cfChild = null;
if (args.cloudflare) {
  cfChild = startCloudflareTunnel({
    port: args.port,
    onUrl: (url) => {
      if (url) process.stdout.write("\n    Cloudflare  " + url + "\n\n");
      else process.stdout.write("\n    Cloudflare  cloudflared not found. Install it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/\n\n");
    },
  });
  cfChild.on("error", () => {
    process.stdout.write("\n    Cloudflare  cloudflared is not installed.\n\n");
  });
}

function shutdown() {
  try { server.close(); } catch {}
  try { if (cfChild) cfChild.kill(); } catch {}
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
