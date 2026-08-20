#!/bin/sh
# Official Linux install: Node, web UI, systemd unit with a real WorkingDirectory.
# Run from the clone, with sudo:
#   git clone https://github.com/str1k3rs13/mikcon.git
#   sudo sh mikcon/mikconPCserver/install-linux.sh
set -e

if [ "$(id -u)" -ne 0 ]; then
  echo "Run with sudo: sudo sh $0"
  exit 1
fi

HERE=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$HERE/.." && pwd)
WWW_SRC="$ROOT/juanfi-app/www"
WWW_DST="$HERE/app/www"
NODE_BIN=$(command -v node || true)
RUN_USER="${SUDO_USER:-}"
if [ -z "$RUN_USER" ] || [ "$RUN_USER" = "root" ]; then
  if id noobs >/dev/null 2>&1; then
    RUN_USER=noobs
  else
    RUN_USER=root
  fi
fi

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  node -e "var v=process.versions.node.split('.').map(Number); if (v[0]<22 || (v[0]===22 && v[1]<5)) process.exit(1)"
}

if ! node_ok; then
  if [ ! -f /etc/debian_version ]; then
    echo "Need Node.js 22.5+. Install it, then run this again."
    exit 1
  fi
  echo "Installing Node.js 22..."
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- https://deb.nodesource.com/setup_22.x | bash -
  else
    echo "Install curl or wget, then run this again."
    exit 1
  fi
  apt-get install -y nodejs
  NODE_BIN=$(command -v node)
fi
if ! node_ok; then
  echo "Node 22.5+ is still missing. node -v must print v22.5 or newer."
  exit 1
fi
NODE_BIN=$(command -v node)

if [ ! -f "$HERE/server.mjs" ]; then
  echo "server.mjs not found in $HERE"
  exit 1
fi
if [ ! -f "$WWW_SRC/index.html" ]; then
  echo "Web UI missing: $WWW_SRC/index.html"
  echo "Clone the full repo (juanfi-app/www must be next to mikconPCserver)."
  exit 1
fi

mkdir -p "$HERE/app"
rm -rf "$WWW_DST"
cp -a "$WWW_SRC" "$WWW_DST"

cd "$HERE"
if [ "$RUN_USER" != "root" ]; then
  chown -R "$RUN_USER:$RUN_USER" "$HERE"
  su -s /bin/sh -c "cd '$HERE' && npm install --omit=dev" "$RUN_USER"
else
  npm install --omit=dev
fi

cat > /etc/systemd/system/mikcon-pc-server.service <<EOF
[Unit]
Description=MikconPC Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$HERE
ExecStart=$NODE_BIN server.mjs
Restart=always
RestartSec=3
Environment=PORT=8787

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now mikcon-pc-server

if command -v ufw >/dev/null 2>&1; then
  ufw allow 8787/tcp || true
fi

if ! command -v tailscale >/dev/null 2>&1; then
  echo "Installing Tailscale..."
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL https://tailscale.com/install.sh | sh
  fi
fi
if command -v systemctl >/dev/null 2>&1; then
  systemctl enable --now tailscaled 2>/dev/null || true
fi

sleep 1
systemctl --no-pager --full status mikcon-pc-server | sed -n '1,18p' || true
echo
echo "Open  http://127.0.0.1:8787"
echo "First login  1234  then set a new password."
echo
echo "Always running after reboot: mikcon-pc-server is systemd enabled."
echo "  systemctl status mikcon-pc-server --no-pager"
echo "  systemctl is-enabled mikcon-pc-server    # must print: enabled"
echo "  systemctl is-active mikcon-pc-server     # must print: active"
echo
echo "Tailscale (optional, same account as your phone):"
echo "  sudo tailscale up"
echo "  sudo tailscale set --ssh"
echo "  sudo tailscale ip -4"
echo
echo "If you see status=200/CHDIR the WorkingDirectory in"
echo "/etc/systemd/system/mikcon-pc-server.service does not exist."
echo "This script sets it to: $HERE"
