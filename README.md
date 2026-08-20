# MIKCON

Always-on controller for your WISP. One PC or Pi runs the server. Phones and browsers are only a screen.

Works on **Windows**, **Linux**, **Raspberry Pi**, and **Orange Pi**.

| File | What it is |
|---|---|
| [MIKCON-3.16.12.apk](releases/MIKCON-3.16.12.apk) | Android app |
| Windows `.exe` | PC installer — on the [Releases](https://github.com/str1k3rs13/mikcon/releases) page |

---

## Android

1. Download **[MIKCON-3.16.12.apk](releases/MIKCON-3.16.12.apk)** on the phone.
2. Open it and allow install from that source.
3. Sign in. Owner pack is **1 Android + 1 Windows**. Existing paid keys stay valid.

The phone can talk to the PC server on the same Wi-Fi, Tailscale, or Cloudflare.

---

## Windows

### A. Installer (easiest)

1. Open **[Releases](https://github.com/str1k3rs13/mikcon/releases)** and download the `.exe`.
2. Run it. Windows may say it is unrecognized — choose **More info → Run anyway**.
3. Open the printed URL, or `http://127.0.0.1:8787`.

### B. One command (CMD or PowerShell)

Install [Node.js 22 LTS](https://nodejs.org) first (22.5 or newer). Open a **new** terminal after installing Node.

**CMD**

```bat
git clone https://github.com/str1k3rs13/mikcon.git & cd mikcon\mikconPCserver & npm run up
```

**PowerShell**

```powershell
git clone https://github.com/str1k3rs13/mikcon.git; Set-Location mikcon\mikconPCserver; npm run up
```

Leave that window open. Open the printed URL.

---

## Linux, Raspberry Pi, Orange Pi

64-bit Raspberry Pi OS or Ubuntu on the Pi / Orange Pi. Skip Pi Zero / Pi 1.

**One command** (installs Node 22 if needed, then starts):

```bash
git clone https://github.com/str1k3rs13/mikcon.git && sh mikcon/mikconPCserver/start.sh
```

Leave it running. Open `http://127.0.0.1:8787` on that machine, or `http://PI-LAN-IP:8787` from a phone on the same Wi-Fi.

Open the firewall:

```bash
sudo ufw allow 8787/tcp
```

Keep it running after reboot:

```bash
sudo cp mikcon/mikconPCserver/deploy/mikcon-pc-server.service /etc/systemd/system/
sudo nano /etc/systemd/system/mikcon-pc-server.service
```

Set `WorkingDirectory` to the real `mikconPCserver` folder and `ExecStart=/usr/bin/node server.mjs`, then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now mikcon-pc-server
```

---

## First sign-in

1. Open the printed URL.
2. Password is **1234** on first boot.
3. Set a new password and confirm it.

Customers pay (no login) at **`/payment`** — last name, first name, and last 4 of the cellphone.

To reset the server password:

```bash
npm start -- --reset-password
```

---

## License

The license is bound to **this machine**, not the phone.

- Windows: MachineGuid
- Linux / Pi: `/etc/machine-id`

Do not copy a Windows data folder onto Linux, or Linux data onto Windows. Each OS is a new machine.

---

## Remote access (optional)

```bash
npm start -- --tailscale
npm start -- --cloudflare
```

Needs [Tailscale](https://tailscale.com) or [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) already installed.

---

## Data folders

- Windows: `%APPDATA%\MikconPC Server`
- Linux / Pi: `~/.mikcon-pc-server`

---

## Need help

Default port is **8787**. `node --version` must print **v22.5** or newer.
