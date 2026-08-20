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
  fi
done

if [ -d "$ROOT/boot/firmware" ]; then
  HASH=$(openssl passwd -6 '1234')
  printf "mikcon:%s\n" "$HASH" > "$ROOT/boot/firmware/userconf.txt"
fi

printf "uninitialized\n" > "$ROOT/etc/machine-id"
rm -f "$ROOT/var/lib/dbus/machine-id"
rm -f "$ROOT/root/.not_logged_in_yet"

cp /usr/bin/qemu-aarch64-static "$ROOT/usr/bin/qemu-aarch64-static"
mount -t proc proc "$ROOT/proc"
mount -t sysfs sys "$ROOT/sys"
mount --bind /dev "$ROOT/dev"
mkdir -p "$ROOT/dev/pts"
mount --bind /dev/pts "$ROOT/dev/pts" 2>/dev/null || true

chroot "$ROOT" /usr/bin/qemu-aarch64-static /bin/sh -s <<'CHROOT'
set -e
export DEBIAN_FRONTEND=noninteractive
if ! command -v curl >/dev/null 2>&1; then
  apt-get update -y
  apt-get install -y --no-install-recommends curl ca-certificates
fi
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
apt-get install -y --no-install-recommends avahi-daemon openssl
if id root >/dev/null 2>&1; then
  echo "root:1234" | chpasswd || true
fi
cd /opt/mikcon/mikconPCserver
node scripts/sync-web.mjs || true
node -e "var v=process.versions.node.split('.').map(Number); if (v[0]<22 || (v[0]===22 && v[1]<5)) process.exit(1)"
CHROOT

rm -f "$ROOT/usr/bin/qemu-aarch64-static"
echo "inject: baked $IMG"
