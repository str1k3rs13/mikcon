# MikconPC Server

Always-on **web** controller. No popup window. You start it with Node, it prints the address and port, and you open that in a browser. Works on **Windows and Linux**.

Needs **Node 22.5 or newer** (`node:sqlite`).

Full install steps (Windows and Linux): **[INSTALL.md](INSTALL.md)**.

## Run

Windows (CMD):

```bat
cd mikconPCserver
npm install
npm start
```

Linux:

```bash
# copy the whole mikrotik-ai-panel folder so juanfi-app/www is next to this folder
cd mikconPCserver
npm install --omit=dev
npm start
```

Customers pay or add credit (no login) at `/payment` — last name, then GCash reference.

Then open the printed URL, for example:

- `http://127.0.0.1:8787` on this PC
- `http://192.168.x.x:8787` from a phone on the same Wi-Fi
- Tailscale / Cloudflare URLs if you turned those on

First start: sign in with **1234**, then set a new password (confirm and save). Reset later with:

```
npm start -- --reset-password
```

Linux keep-alive (after `npm start` has synced `app/www` once):

```bash
sudo cp deploy/mikcon-pc-server.service /etc/systemd/system/
# edit WorkingDirectory to this folder
sudo systemctl daemon-reload
sudo systemctl enable --now mikcon-pc-server
```

Open TCP **8787** in the Linux firewall (`ufw allow 8787/tcp` or the equivalent).

The license is bound to this **machine** (Windows MachineGuid, Linux `/etc/machine-id`). Browsers are only a remote screen.

## Tunnels (optional)

```
npm start -- --tailscale
npm start -- --cloudflare
npm start -- --port 8787 --cloudflare --tailscale
```

- **Tailscale:** install the Tailscale app, log in, then `--tailscale` (uses `tailscale serve`). Even without the flag, a Tailscale IP is printed if Tailscale is already up.
- **Cloudflare:** install [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/), then `--cloudflare`. A `https://….trycloudflare.com` link is printed.

Sign in with the server password. Shared UI still comes from `juanfi-app/www` via `npm run sync`.
