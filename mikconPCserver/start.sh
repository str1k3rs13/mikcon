#!/bin/sh
set -e
cd "$(dirname "$0")"

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  node -e "var v=process.versions.node.split('.').map(Number); if (v[0]<22 || (v[0]===22 && v[1]<5)) process.exit(1)"
}

install_node() {
  if [ ! -f /etc/debian_version ]; then
    echo "Need Node.js 22.5+. Install it, then run this again."
    exit 1
  fi
  echo "Installing Node.js 22 (needs sudo)..."
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- https://deb.nodesource.com/setup_22.x | sudo -E bash -
  else
    echo "Install curl or wget, then run this again."
    exit 1
  fi
  sudo apt-get install -y nodejs
}

if ! node_ok; then
  install_node
  if ! node_ok; then
    echo "Node 22.5+ is still missing. node -v must print v22.5 or newer."
    exit 1
  fi
fi

if ! command -v tailscale >/dev/null 2>&1; then
  echo "Installing Tailscale (needs sudo)..."
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL https://tailscale.com/install.sh | sudo sh
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- https://tailscale.com/install.sh | sudo sh
  fi
fi
if command -v systemctl >/dev/null 2>&1; then
  sudo systemctl enable --now tailscaled 2>/dev/null || true
fi

npm install --omit=dev
node scripts/sync-web.mjs
exec node server.mjs --tailscale
