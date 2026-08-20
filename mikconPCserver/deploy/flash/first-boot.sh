#!/bin/sh
# Runs once-ish on every boot: apply /boot/mikcon-wifi.txt, keep a unique machine-id.
set -e

wifi_file=""
for f in /boot/firmware/mikcon-wifi.txt /boot/mikcon-wifi.txt; do
  if [ -f "$f" ]; then wifi_file="$f"; break; fi
done

apply_wifi() {
  ssid=""
  psk=""
  country="PH"
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      \#*|"");;
      country=*) country=${line#country=} ;;
      ssid=*) ssid=${line#ssid=} ;;
      psk=*) psk=${line#psk=} ;;
    esac
  done < "$1"
  ssid=$(printf "%s" "$ssid" | tr -d "\r")
  psk=$(printf "%s" "$psk" | tr -d "\r")
  country=$(printf "%s" "$country" | tr -d "\r")
  [ -n "$ssid" ] || return 0
  if command -v nmcli >/dev/null 2>&1; then
    nmcli radio wifi on 2>/dev/null || true
    nmcli connection delete mikcon-wifi >/dev/null 2>&1 || true
    if ! nmcli device wifi connect "$ssid" password "$psk" name mikcon-wifi; then
      nmcli connection add type wifi con-name mikcon-wifi ssid "$ssid" wifi-sec.key-mgmt wpa-psk wifi-sec.psk "$psk" || true
      nmcli connection up mikcon-wifi || true
    fi
    return 0
  fi
  if [ -d /etc/wpa_supplicant ]; then
    cat > /etc/wpa_supplicant/wpa_supplicant.conf <<EOF
country=${country}
ctrl_interface=DIR=/var/run/wpa_supplicant GROUP=netdev
update_config=1
network={
    ssid="${ssid}"
    psk="${psk}"
}
EOF
    systemctl restart wpa_supplicant 2>/dev/null || true
  fi
}

if [ -n "$wifi_file" ]; then
  apply_wifi "$wifi_file" || true
fi

if [ -f /etc/machine-id ]; then
  id=$(tr -d " \n\r" < /etc/machine-id)
  if [ "$id" = "uninitialized" ] || [ -z "$id" ]; then
    rm -f /etc/machine-id /var/lib/dbus/machine-id
    if command -v systemd-machine-id-setup >/dev/null 2>&1; then
      systemd-machine-id-setup
    fi
  fi
fi

hostnamectl set-hostname mikcon 2>/dev/null || true

mkdir -p /var/lib/mikcon-pc-server
exit 0
