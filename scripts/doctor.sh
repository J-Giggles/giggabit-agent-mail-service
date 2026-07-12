#!/usr/bin/env bash
set -euo pipefail

json=no
case "${1:-}" in
  '') ;;
  --json) json=yes ;;
  -h|--help) echo 'usage: ./scripts/doctor.sh [--json]'; exit 0 ;;
  *) printf 'unknown doctor option: %s\n' "$1" >&2; exit 2 ;;
esac

has() { command -v "$1" >/dev/null 2>&1; }
version=0
has systemd-creds && version="$(systemd-creds --version 2>/dev/null | awk 'NR == 1 { print $2 }')"
[[ "$version" =~ ^[0-9]+$ ]] || version=0
service_active=false
if has systemctl && systemctl is-active --quiet giggabit-agent-mail-service.service 2>/dev/null; then
  service_active=true
fi
tailscale_ready=false
if has tailscale && tailscale ip -4 2>/dev/null | head -n 1 | grep -Eq '^100\.'; then
  tailscale_ready=true
fi

required_ok=true
for command in node jq openssl tailscale systemd-creds clamscan bwrap file; do
  has "$command" || required_ok=false
done
systemd_ok=false
((version >= 250)) && systemd_ok=true
node_ok=false
if has node && node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/version-policy.mjs" \
  at-least "$(node -p 'process.versions.node')" 24.18.0 >/dev/null 2>&1; then
  node_ok=true
fi

if [[ "$json" == yes ]]; then
  jq -n \
    --argjson required_commands "$required_ok" \
    --argjson systemd_supported "$systemd_ok" \
    --argjson node_supported "$node_ok" \
    --argjson tailscale_ready "$tailscale_ready" \
    --argjson service_active "$service_active" \
    '{required_commands:$required_commands,node_supported:$node_supported,systemd_supported:$systemd_supported,tailscale_ready:$tailscale_ready,service_active:$service_active,values_suppressed:true}'
else
  printf 'required commands: %s\n' "$required_ok"
  printf 'systemd supported: %s\n' "$systemd_ok"
  printf 'Node.js supported: %s\n' "$node_ok"
  printf 'tailscale ready: %s\n' "$tailscale_ready"
  printf 'service active: %s\n' "$service_active"
  echo 'No addresses, identifiers, paths, mailbox data, credentials, or logs were collected.'
fi

[[ "$required_ok" == true && "$node_ok" == true && "$systemd_ok" == true && "$tailscale_ready" == true && "$service_active" == true ]]
