# Flash with Balena Etcher

One image per board family. Raspberry Pi and Orange Pi cannot share a boot file (different chips). After flash, MIKCON starts by itself. You only type a new password in the browser.

Images are built on GitHub Actions and attached to [Releases](https://github.com/str1k3rs13/mikcon/releases).

## Raspberry Pi 3 / 4 / 5 (64-bit)

1. Download **mikcon-raspberrypi-arm64.img.xz**
2. Open [Balena Etcher](https://etcher.balena.io)
3. Flash it to a 8 GB+ microSD
4. Optional Wi-Fi: put the card back in the PC, edit `mikcon-wifi.txt` on the boot drive (`ssid=` and `psk=`), eject
5. Boot the Pi with ethernet or that Wi-Fi
6. On a phone on the same network open **http://mikcon.local:8787** or **http://PI-IP:8787**
7. Login **1234**, then type your new password

HDMI shows the same URL if you plug in a screen.

## Orange Pi 5

Same steps with **mikcon-orangepi5-arm64.img.xz**.

Other Orange Pi boards: flash [Armbian](https://www.armbian.com) for *your* board in Etcher, copy that card’s Linux root onto a machine, and run `sudo deploy/flash/inject.sh` against a cloned image — or use the one-line git install in the main README.

## Password

First login is always **1234**. The page then asks for a new password. That is the only typing.

Each flash gets a new `/etc/machine-id`, so the MIKCON license is per board. Do not clone a running card to another board; flash a fresh image instead.
