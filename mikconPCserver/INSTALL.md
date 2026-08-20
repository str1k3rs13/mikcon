# MikconPC Server — installation

Always-on web controller. You start it with Node. It prints a URL. You open that URL in a browser. There is no popup app.

Works on **Windows** and **Linux**. The license is bound to **this machine**, not to the phone or browser that opens the page.

## 1. What you need

- The **whole** `mikrotik-ai-panel` folder. `juanfi-app/www` must sit next to `mikconPCserver`. Do not copy `mikconPCserver` alone.
- **Node.js 22.5 or newer.** Check with:

```
node --version
```

If that prints `v22.4` or older, or `node` is not found, install Node 22 LTS or 24 from https://nodejs.org then open a **new** terminal and check again.

- A free TCP port. Default is **8787**.

## 2. Windows

Open Command Prompt:

```bat
cd C:\path\to\mikrotik-ai-panel\mikconPCserver
npm install
npm start
```

Leave that window open. The server prints addresses, for example:

```
Local      http://127.0.0.1:8787
LAN        http://192.168.x.x:8787
Port       8787
First login  1234
Then set a new password in the browser (confirm and save).
```

- On this PC: open the **Local** URL.
- From a phone on the same Wi-Fi: open the **LAN** URL.
- Customers pay a bill or add credit (no login) at **`/payment`** — last name, first name, and last 4 of the cellphone if you have their number on the bill.
- First start: sign in with **1234**, then set a new password and confirm it.

Data and the password hash are stored in:

```
%APPDATA%\MikconPC Server
```

To reset the login password:

```bat
npm start -- --reset-password
```

## 3. Linux

### 3.1 Put the files on the machine

Copy the whole `mikrotik-ai-panel` folder. A typical place:

```bash
sudo mkdir -p /opt
sudo cp -a mikrotik-ai-panel /opt/
```

`juanfi-app` and `mikconPCserver` must both be under that folder.

### 3.2 Install Node 22.5+

Debian / Ubuntu example (NodeSource 22.x):

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version
```

Any other distro is fine as long as `node --version` is **v22.5.0 or higher**.

### 3.3 Install and start once

```bash
cd /opt/mikrotik-ai-panel/mikconPCserver
npm install --omit=dev
npm start
```

`--omit=dev` skips Electron. Linux does not need it.

First start copies the web UI and prints:

```
Local      http://127.0.0.1:8787
LAN        http://192.168.x.x:8787
Port       8787
First login  1234
Then set a new password in the browser (confirm and save).
```

Sign in with **1234**, then set a new password. Data lives in:

```
~/.mikcon-pc-server
```

To use a fixed data folder instead:

```bash
export MIKCON_DATA=/var/lib/mikcon-pc-server
mkdir -p "$MIKCON_DATA"
npm start
```

### 3.4 Open the firewall

```bash
sudo ufw allow 8787/tcp
sudo ufw reload
```

If you do not use ufw, open TCP **8787** in whatever firewall that host has.

### 3.5 Keep it running after reboot

From the repo root (do not hand-edit a missing WorkingDirectory — that is **status=200/CHDIR**):

```bash
sudo sh mikconPCserver/install-linux.sh
```

That copies `juanfi-app/www` into `mikconPCserver/app/www`, writes a unit whose `WorkingDirectory` is this folder, and enables the service.

Check it is running and will start on reboot:

```bash
systemctl status mikcon-pc-server --no-pager
systemctl is-enabled mikcon-pc-server
systemctl is-active mikcon-pc-server
```

`status` must show **active (running)**. `is-enabled` must print **enabled**.

Logs:

```bash
journalctl -u mikcon-pc-server -f
```

If status is **200/CHDIR**, `/etc/systemd/system/mikcon-pc-server.service` points at a folder that is not on disk. Run `install-linux.sh` again.

Do **not** use `npm start` under systemd. `npm start` re-copies the UI every time. systemd should run `node server.mjs`.

## 4. Sign in and license

1. Open a printed URL in a browser.
2. Sign in with **1234** on first boot, then set a new password and confirm it.
3. Activate the MIKCON license **on this machine**.

The license follows:

- Windows: MachineGuid
- Linux: `/etc/machine-id`

Phones and other PCs are only a remote screen. They use the server password, not their own license.

Do **not** copy a Windows data folder onto Linux, or Linux data onto Windows. Each OS is a new machine: new password, new Machine ID, new license.

## 5. Remote access (optional)

Same Wi-Fi is enough for LAN. For outside the site:

**Tailscale** — install Tailscale, log in, then:

```
npm start -- --tailscale
```

If Tailscale is already up, `npm start` still prints a `100.x.x.x` URL without the flag.

**Cloudflare** — install [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/), then:

```
npm start -- --cloudflare
```

A `https://….trycloudflare.com` link is printed.

Both:

```
npm start -- --port 8787 --cloudflare --tailscale
```

Under systemd, put the same flags on `ExecStart`, for example:

```
ExecStart=/usr/bin/node server.mjs --cloudflare
```

## 6. Useful commands

| What | Command |
|---|---|
| Start (copies UI, then serves) | `npm start` |
| Serve only (after UI is already copied) | `node server.mjs` |
| Other port | `npm start -- --port 8787` |
| New login password | `npm start -- --reset-password` |
| Help | `node server.mjs --help` |

## 7. If it does not start

| Symptom | What to check |
|---|---|
| `node:sqlite` / DatabaseSync error | Node is older than 22.5. Upgrade Node. |
| `sync-web: source not found` | You copied only `mikconPCserver`. Copy the whole `mikrotik-ai-panel` folder so `juanfi-app/www` exists. |
| Browser cannot open the LAN URL | Firewall, and confirm `npm start` printed a LAN address. |
| Login page, then “Wrong password” | First boot is **1234**, then your new password. Reset with `--reset-password` (back to 1234). |
| License does not match | You moved the install to another PC or OS. Activate again on the new machine. |
| Port already in use | Another process has 8787. Use `--port` or stop the other process. |

On Linux, `systemctl status mikcon-pc-server` and `journalctl -u mikcon-pc-server -e` show why a service failed.
