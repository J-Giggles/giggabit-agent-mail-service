#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this uninstaller through pkexec." >&2
  exit 1
fi

MODE=${1:-preserve}
case "$MODE" in
  preserve|purge) ;;
  *) echo "uninstall mode must be preserve or purge" >&2; exit 2 ;;
esac

SERVICE_NAME=giggabit-agent-mail-service
INSTALL_DIR=/opt/$SERVICE_NAME
STATE_DIR=/var/lib/$SERVICE_NAME
CREDENTIAL=/etc/credstore.encrypted/$SERVICE_NAME-vault-master
CONFIG_DIR=/etc/$SERVICE_NAME

systemctl disable --now "$SERVICE_NAME.service" >/dev/null 2>&1 || true
rm -f "/etc/systemd/system/$SERVICE_NAME.service"
rm -f /usr/local/bin/giggabit-agent-mail-service-agent
rm -f /usr/local/bin/giggabit-agent-mail-service-admin
rm -f /usr/local/libexec/giggabit-agent-mail-service-admin-root
rm -rf "$INSTALL_DIR"
systemctl daemon-reload
systemctl reset-failed "$SERVICE_NAME.service" >/dev/null 2>&1 || true

if [ "$MODE" = purge ]; then
  rm -rf "$STATE_DIR" "/run/$SERVICE_NAME"
  rm -f "$CREDENTIAL"
  rm -rf "$CONFIG_DIR"
fi

echo "Giggabit Agent Mail Service uninstalled; state mode=$MODE"
