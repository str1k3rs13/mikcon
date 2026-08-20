#!/bin/sh
set -e
ip=""
if command -v ip >/dev/null 2>&1; then
  ip=$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -n 1)
fi
if [ -z "$ip" ]; then
  ip=$(hostname -I 2>/dev/null | awk '{print $1}')
fi
if [ -z "$ip" ]; then ip="THE-PI-LAN-IP"; fi

ts=""
if command -v tailscale >/dev/null 2>&1; then
  ts=$(tailscale ip -4 2>/dev/null | head -n 1)
fi

text="
MIKCON is running.
Open:  http://${ip}:8787
First login:  1234
Then type your new password on that page.
"
if [ -n "$ts" ]; then
  text="${text}Tailscale:  http://${ts}:8787

"
fi
mkdir -p /etc/issue.d
printf "%s" "$text" > /etc/issue.d/mikcon.issue
printf "%s" "$text" > /etc/motd
exit 0
