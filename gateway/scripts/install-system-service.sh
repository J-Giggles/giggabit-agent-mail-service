#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this installer through pkexec." >&2
  exit 1
fi

SOURCE_DIR=${1:?source package directory is required}
RUNTIME_USER=${2:?runtime user is required}
TAILSCALE_IP=${3:?Tailscale IPv4 address is required}
case "$TAILSCALE_IP" in
  100.*) ;;
  *) echo "A Tailscale IPv4 address is required." >&2; exit 1 ;;
esac

RUNTIME_GROUP=$(id -gn "$RUNTIME_USER")
SERVICE_NAME=giggabit-agent-mail-service
INSTALL_DIR=/opt/$SERVICE_NAME
STATE_DIR=/var/lib/$SERVICE_NAME
CREDENTIAL=/etc/credstore.encrypted/$SERVICE_NAME-vault-master
CONFIG_DIR=/etc/$SERVICE_NAME
OPERATOR_CONFIG=$CONFIG_DIR/operator.json

systemd_version=$(systemd-creds --version | awk 'NR == 1 { print $2 }')
case "$systemd_version" in
  ''|*[!0-9]*) echo "Could not determine the systemd version." >&2; exit 1 ;;
esac
if [ "$systemd_version" -lt 250 ]; then
  echo "systemd 250 or newer is required." >&2
  exit 1
fi

if command -v pacman >/dev/null 2>&1; then
  pacman -S --needed --noconfirm bubblewrap clamav file polkit
elif command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends bubblewrap clamav file policykit-1
else
  echo "A supported Arch or Debian-family package manager is required." >&2
  exit 1
fi

for command in node openssl systemd-creds tailscale bwrap clamscan file; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "A required runtime command is unavailable: $command" >&2
    exit 1
  }
done
NODE_BIN=$(command -v node)
NODE_BIN=$(readlink -f "$NODE_BIN")
NODE_WRITES=$(stat -c %A "$NODE_BIN" | cut -c6,9)
if [ "$(stat -c %U "$NODE_BIN")" != root ] || printf '%s' "$NODE_WRITES" | grep -q w; then
  echo "The production Node.js executable must be root-owned and not writable by the invoking user." >&2
  exit 1
fi
node "$SOURCE_DIR/../scripts/version-policy.mjs" at-least "$(node -p 'process.versions.node')" 24.18.0

freshclam --stdout

install -d -m 755 "$INSTALL_DIR" "$INSTALL_DIR/bin" /usr/local/libexec
systemctl stop "$SERVICE_NAME.service" >/dev/null 2>&1 || true
rm -rf "$INSTALL_DIR/dist" "$INSTALL_DIR/node_modules"
cp -R "$SOURCE_DIR/dist" "$SOURCE_DIR/node_modules" "$INSTALL_DIR/"
install -m 644 "$SOURCE_DIR/package.json" "$SOURCE_DIR/bun.lock" "$SOURCE_DIR/README.md" "$INSTALL_DIR/"
sed "s#@NODE_BIN@#$NODE_BIN#g" "$SOURCE_DIR/bin/giggabit-agent-mail-service.in" \
  > "$INSTALL_DIR/bin/giggabit-agent-mail-service"
chmod 755 "$INSTALL_DIR/bin/giggabit-agent-mail-service"
sed -e "s/@TAILSCALE_IP@/$TAILSCALE_IP/g" -e "s#@NODE_BIN@#$NODE_BIN#g" \
  "$SOURCE_DIR/bin/giggabit-agent-mail-service-agent.in" \
  > /usr/local/bin/giggabit-agent-mail-service-agent
sed -e "s/@RUNTIME_USER@/$RUNTIME_USER/g" -e "s/@RUNTIME_GROUP@/$RUNTIME_GROUP/g" \
  -e "s#@NODE_BIN@#$NODE_BIN#g" \
  "$SOURCE_DIR/bin/giggabit-agent-mail-service-admin-root.in" \
  > /usr/local/libexec/giggabit-agent-mail-service-admin-root
install -m 755 "$SOURCE_DIR/bin/giggabit-agent-mail-service-admin.in" \
  /usr/local/bin/giggabit-agent-mail-service-admin
chmod 755 /usr/local/bin/giggabit-agent-mail-service-agent \
  /usr/local/libexec/giggabit-agent-mail-service-admin-root
chown -R root:root "$INSTALL_DIR"

install -d -m 700 /etc/credstore.encrypted
if [ ! -e "$CREDENTIAL" ]; then
  plaintext=$(mktemp --tmpdir=/run)
  trap 'rm -f "$plaintext"' EXIT HUP INT TERM
  chmod 600 "$plaintext"
  openssl rand 32 > "$plaintext"
  systemd-creds encrypt --with-key=auto --name=mail-vault-master "$plaintext" "$CREDENTIAL"
  rm -f "$plaintext"
  trap - EXIT HUP INT TERM
fi
chmod 600 "$CREDENTIAL"

install -d -m 750 -o root -g "$RUNTIME_GROUP" "$CONFIG_DIR"
if [ ! -e "$OPERATOR_CONFIG" ]; then
  printf '%s\n' '{"magic_link":{"enabled":false}}' > "$OPERATOR_CONFIG"
fi
chown root:"$RUNTIME_GROUP" "$OPERATOR_CONFIG"
chmod 640 "$OPERATOR_CONFIG"

install -d -o "$RUNTIME_USER" -g "$RUNTIME_GROUP" -m 700 "$STATE_DIR"

sed -e "s/@TAILSCALE_IP@/$TAILSCALE_IP/g" -e "s/@RUNTIME_USER@/$RUNTIME_USER/g" \
  -e "s/@RUNTIME_GROUP@/$RUNTIME_GROUP/g" "$SOURCE_DIR/systemd/giggabit-agent-mail-service.service.in" \
  > "/etc/systemd/system/$SERVICE_NAME.service"
chmod 644 "/etc/systemd/system/$SERVICE_NAME.service"
systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME.service"
systemctl is-active --quiet "$SERVICE_NAME.service"
systemctl --no-pager --full status "$SERVICE_NAME.service"
