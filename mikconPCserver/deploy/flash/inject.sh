#!/bin/sh
# Bake MIKCON into a Raspberry Pi OS or Armbian aarch64 .img (run on x86_64 with sudo).
# Usage: sudo ./inject.sh /path/to/disk.img
set -eu

IMG=${1:-}
if [ -z "$IMG" ] || [ ! -f "$IMG" ]; then
  echo "usage: sudo $0 image.img" >&2
  exit 1
fi

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
REPO=$(CDPATH= cd -- "$SCRIPT_DIR/../../.." && pwd)
SRC_SERVER="$REPO/mikconPCserver"
SRC_WWW="$REPO/juanfi-app/www"
if [ ! -f "$SRC_SERVER/server.mjs" ] || [ ! -f "$SRC_WWW/index.html" ]; then
  echo "inject: expected $SRC_SERVER/server.mjs and $SRC_WWW/index.html" >&2
  exit 1
fi

# Lite images are ~2 GB. Node 22 + Tailscale + MIKCON does not fit.
need=$((5 * 1024 * 1024 * 1024))
cur=$(stat -c%s "$IMG" 2>/dev/null || stat -f%z "$IMG")
if [ "$cur" -lt "$need" ]; then
  echo "inject: growing image to 5G ($cur -> $need)"
  truncate -s 5G "$IMG"
  # Armbian is GPT: the backup header must move to the new end before growpart.
  sgdisk -e "$IMG" >/dev/null 2>&1 || true
fi

LOOP=$(losetup -P -f --show "$IMG")
cleanup() {
  set +e
  umount "$ROOT/boot/firmware" 2>/dev/null
  umount "$ROOT/boot" 2>/dev/null
  umount "$ROOT/dev/pts" 2>/dev/null
  umount "$ROOT/dev" 2>/dev/null
  umount "$ROOT/proc" 2>/dev/null
  umount "$ROOT/sys" 2>/dev/null
  umount "$ROOT" 2>/dev/null
  losetup -d "$LOOP" 2>/dev/null
}
trap cleanup EXIT

ROOT=$(mktemp -d)
BOOTP=""
ROOTP=""
for n in p2 p1; do
  if [ -b "${LOOP}${n}" ]; then
    fstype=$(blkid -o value -s TYPE "${LOOP}${n}" 2>/dev/null || true)
    case "$fstype" in
      ext4|ext3|btrfs|xfs) ROOTP="${LOOP}${n}" ;;
      vfat|fat32|fat16|exfat) BOOTP="${LOOP}${n}" ;;
    esac
  fi
done
if [ -z "$ROOTP" ]; then
  echo "inject: no Linux root partition on $IMG" >&2
  exit 1
fi

pnum=${ROOTP##*p}
parted -s "$LOOP" resizepart "$pnum" 100% || true
growpart "$LOOP" "$pnum" 2>/dev/null || true
e2fsck -fy "$ROOTP" || true
resize2fs "$ROOTP" || true

mount "$ROOTP" "$ROOT"
if [ -n "$BOOTP" ]; then
  if [ -d "$ROOT/boot/firmware" ]; then
    mount "$BOOTP" "$ROOT/boot/firmware"
  else
    mkdir -p "$ROOT/boot"
    mount "$BOOTP" "$ROOT/boot"
  fi
fi

mkdir -p "$ROOT/opt/mikcon/juanfi-app" "$ROOT/opt/mikcon/mikconPCserver" "$ROOT/var/lib/mikcon-pc-server"
rm -rf "$ROOT/opt/mikcon/mikconPCserver"
cp -a "$SRC_SERVER" "$ROOT/opt/mikcon/mikconPCserver"
rm -rf "$ROOT/opt/mikcon/mikconPCserver/node_modules" "$ROOT/opt/mikcon/mikconPCserver/test"
# app/www is gitignored on the PC checkout, so bake the UI next to server.mjs
# (systemd runs `node server.mjs`, which serves app/www, not juanfi-app/www).
mkdir -p "$ROOT/opt/mikcon/mikconPCserver/app"
rm -rf "$ROOT/opt/mikcon/mikconPCserver/app/www"
cp -a "$SRC_WWW" "$ROOT/opt/mikcon/mikconPCserver/app/www"
cp -a "$SRC_WWW" "$ROOT/opt/mikcon/juanfi-app/www"

install -m 644 "$SCRIPT_DIR/mikcon.service" "$ROOT/etc/systemd/system/mikcon.service"
install -m 644 "$SCRIPT_DIR/mikcon-firstboot.service" "$ROOT/etc/systemd/system/mikcon-firstboot.service"
install -m 644 "$SCRIPT_DIR/mikcon-issue.service" "$ROOT/etc/systemd/system/mikcon-issue.service"
mkdir -p "$ROOT/etc/systemd/system/multi-user.target.wants"
ln -sf /etc/systemd/system/mikcon.service "$ROOT/etc/systemd/system/multi-user.target.wants/mikcon.service"
ln -sf /etc/systemd/system/mikcon-firstboot.service "$ROOT/etc/systemd/system/multi-user.target.wants/mikcon-firstboot.service"
ln -sf /etc/systemd/system/mikcon-issue.service "$ROOT/etc/systemd/system/multi-user.target.wants/mikcon-issue.service"

chmod +x "$ROOT/opt/mikcon/mikconPCserver/deploy/flash/first-boot.sh" "$ROOT/opt/mikcon/mikconPCserver/deploy/flash/issue.sh"

for boot in "$ROOT/boot/firmware" "$ROOT/boot"; do
  if [ -d "$boot" ]; then
    cp "$SCRIPT_DIR/mikcon-wifi.txt" "$boot/mikcon-wifi.txt"
    cp "$SCRIPT_DIR/mikcon-tailscale.txt" "$boot/mikcon-tailscale.txt"
  fi
done

if [ -d "$ROOT/boot/firmware" ]; then
  HASH=$(openssl passwd -6 '1234')
  printf "mikcon:%s\n" "$HASH" > "$ROOT/boot/firmware/userconf.txt"
fi

printf "uninitialized\n" > "$ROOT/etc/machine-id"
rm -f "$ROOT/var/lib/dbus/machine-id"
rm -f "$ROOT/root/.not_logged_in_yet"

# Install Node and Tailscale as arm64 binaries on the host. qemu-user apt/DNS
# fails on Armbian (getaddrinfo EBUSY) even when Pi OS chroot works.
if [ ! -x "$ROOT/usr/bin/node" ] && [ ! -x "$ROOT/usr/local/bin/node" ]; then
  echo "inject: installing Node 22 linux-arm64 into the image"
  mkdir -p /tmp/mikcon-flash "$ROOT/usr/local"
  sums=$(curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt)
  ntar=$(printf "%s\n" "$sums" | awk '/linux-arm64.tar.xz$/{print $2; exit}')
  [ -n "$ntar" ] || { echo "inject: could not resolve Node 22 arm64 tarball" >&2; exit 1; }
  curl -fL --retry 4 -o /tmp/mikcon-flash/node.tar.xz "https://nodejs.org/dist/latest-v22.x/$ntar"
  tar -xJf /tmp/mikcon-flash/node.tar.xz -C "$ROOT/usr/local" --strip-components=1
  ln -sf /usr/local/bin/node "$ROOT/usr/bin/node"
  ln -sf /usr/local/bin/npm "$ROOT/usr/bin/npm"
fi

if [ ! -x "$ROOT/usr/sbin/tailscaled" ] && [ ! -x "$ROOT/usr/bin/tailscaled" ]; then
  echo "inject: installing Tailscale arm64 into the image"
  mkdir -p /tmp/mikcon-flash/ts
  tsurl="https://pkgs.tailscale.com/stable/tailscale_latest_arm64.tgz"
  if ! curl -fL --retry 2 -o /tmp/mikcon-flash/tailscale.tgz "$tsurl"; then
    tsurl=$(curl -fsSL https://api.github.com/repos/tailscale/tailscale/releases/latest | sed -n 's/.*"browser_download_url": "\([^"]*arm64\.tgz\)".*/\1/p' | head -1)
    [ -n "$tsurl" ] && curl -fL --retry 4 -o /tmp/mikcon-flash/tailscale.tgz "$tsurl" || tsurl=""
  fi
  if [ -f /tmp/mikcon-flash/tailscale.tgz ]; then
    tar -xzf /tmp/mikcon-flash/tailscale.tgz -C /tmp/mikcon-flash/ts
    tsd=$(find /tmp/mikcon-flash/ts -type f -name tailscaled | head -1)
    tsc=$(find /tmp/mikcon-flash/ts -type f -name tailscale | head -1)
    [ -n "$tsd" ] && install -m 755 "$tsd" "$ROOT/usr/sbin/tailscaled"
    [ -n "$tsc" ] && install -m 755 "$tsc" "$ROOT/usr/bin/tailscale"
    mkdir -p "$ROOT/lib/systemd/system" "$ROOT/etc/systemd/system/multi-user.target.wants" "$ROOT/var/lib/tailscale"
    unit=$(find /tmp/mikcon-flash/ts -name tailscaled.service | head -1)
    if [ -n "$unit" ]; then
      install -m 644 "$unit" "$ROOT/lib/systemd/system/tailscaled.service"
    else
      cat > "$ROOT/lib/systemd/system/tailscaled.service" <<'UNIT'
[Unit]
Description=Tailscale node agent
After=network-pre.target
Wants=network-pre.target
[Service]
ExecStart=/usr/sbin/tailscaled --state=/var/lib/tailscale/tailscaled.state --socket=/run/tailscale/tailscaled.sock
Restart=on-failure
[Install]
WantedBy=multi-user.target
UNIT
    fi
    ln -sf /lib/systemd/system/tailscaled.service "$ROOT/etc/systemd/system/multi-user.target.wants/tailscaled.service"
  else
    echo "inject: Tailscale skipped (install later with curl | sh && sudo tailscale up)"
  fi
fi

echo "inject: baked $IMG"
