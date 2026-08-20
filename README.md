# MIKCON

Always-on controller for your WISP. One PC or Pi runs the server. Phones and browsers are only a screen.

Works on **Windows**, **Linux**, **Raspberry Pi**, and **Orange Pi**.

| File | What it is |
|---|---|
| [MIKCON-3.16.13.apk](releases/MIKCON-3.16.13.apk) | Android app |
| Windows `.exe` | PC installer — on the [Releases](https://github.com/str1k3rs13/mikcon/releases) page |

---

## Android

1. Download **[MIKCON-3.16.13.apk](releases/MIKCON-3.16.13.apk)** on the phone.
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

## Raspberry Pi and Orange Pi (Balena Etcher)

Flash, boot, set the password. That is the whole install.

1. Download the image from **[Releases](https://github.com/str1k3rs13/mikcon/releases)**
   - Raspberry Pi 3 / 4 / 5: **mikcon-raspberrypi-arm64.img.xz**
   - Orange Pi 5: **mikcon-orangepi5-arm64.img.xz**
2. Open [Balena Etcher](https://etcher.balena.io) and flash it to an 8 GB+ microSD
3. Optional Wi-Fi: plug the card back into the PC, edit `mikcon-wifi.txt` on the boot drive (`ssid=` and `psk=`)
4. Optional Tailscale: on that same boot drive edit `mikcon-tailscale.txt` and set `auth-key=` to a reusable key from https://login.tailscale.com/admin/settings/keys
5. Eject, boot the board
6. On a phone on the same Wi-Fi open **http://mikcon.local:8787** or **http://BOARD-IP:8787**
7. Login **1234**, then type your new password

Tailscale is already installed on the image. With an auth key it logs in by itself; the server is also on **http://100.x.x.x:8787**. Without a key, on HDMI/SSH run `sudo tailscale up`.

HDMI shows the same URL. Each flash is a new machine for the license — do not clone a running card.

Other Orange Pi boards: use the Linux command below, or flash Armbian for that board and bake MIKCON with `sudo sh mikconPCserver/deploy/flash/inject.sh image.img`.

## Linux (any PC or other Pi)

64-bit OS. Skip Pi Zero / Pi 1. **Install and keep it running after reboot** (Node 22, web UI, systemd). Do not copy the `.service` file and leave `WorkingDirectory` as a missing folder — that is `status=200/CHDIR`.

```bash
git clone https://github.com/str1k3rs13/mikcon.git
sudo sh mikcon/mikconPCserver/install-linux.sh
```

Open `http://127.0.0.1:8787` or `http://LAN-IP:8787`. First login **1234**, then set a new password.

Foreground only (no systemd):

```bash
git clone https://github.com/str1k3rs13/mikcon.git && sh mikcon/mikconPCserver/start.sh
```

Firewall:

```bash
sudo ufw allow 8787/tcp
```

If `systemctl status mikcon-pc-server` shows **status=200/CHDIR**, the unit's `WorkingDirectory` does not exist. Run `install-linux.sh` again, or set that line to the real `mikconPCserver` folder (for a clone that is `/opt/mikcon/mikconPCserver` or `…/mikcon/mikconPCserver`).

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

**Tailscale** (install-linux.sh already installs the package):

```bash
sudo tailscale up
sudo tailscale set --ssh
sudo tailscale ip -4
```

`tailscale up` prints a browser link. Open it while logged into the same Tailscale account as your phone/PC. Then open `http://100.x.x.x:8787` or `tailscale ssh USER@HOSTNAME`.

**Cloudflare** (needs [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) already installed):

```bash
npm start -- --cloudflare
```

Foreground with Tailscale:

```bash
npm start -- --tailscale
```

---

## Data folders

- Windows: `%APPDATA%\MikconPC Server`
- Linux / Pi: `~/.mikcon-pc-server`

---

## Need help

Default port is **8787**. `node --version` must print **v22.5** or newer.

`mikcon-pc-server.service` **status=200/CHDIR** means systemd cannot `cd` into `WorkingDirectory`. The stock unit uses `/opt/mikcon/mikconPCserver`. Either clone there:

```bash
sudo git clone https://github.com/str1k3rs13/mikcon.git /opt/mikcon
sudo sh /opt/mikcon/mikconPCserver/install-linux.sh
```

or run `install-linux.sh` from whatever folder you cloned into (it rewrites the unit).
