#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lifecycle-common.sh
source "$repo_root/scripts/lifecycle-common.sh"

dry_run=no
platform_override=''
for argument in "$@"; do
  case "$argument" in
    --dry-run) dry_run=yes ;;
    --platform=arch) platform_override=arch ;;
    --platform=debian) platform_override=debian ;;
    -h|--help)
      echo 'usage: ./scripts/install.sh [--dry-run] [--platform=arch|--platform=debian]'
      exit 0
      ;;
    *) printf 'unknown install option: %s\n' "$argument" >&2; exit 2 ;;
  esac
done

if [[ -n "$platform_override" && "$dry_run" != yes ]]; then
  echo '--platform is accepted only with --dry-run' >&2
  exit 2
fi

platform="$(detect_platform "$platform_override")"
cat <<EOF
Installation plan
- platform family: $platform
- build and test as the invoking user
- install required OS packages using the native package manager
- install root-owned service code and launchers
- create or preserve the encrypted vault credential and protected state
- bind the service only to this host's Tailscale IPv4 address
- enable and start giggabit-agent-mail-service.service
EOF

if [[ "$dry_run" == yes ]]; then
  echo 'Dry run complete; no files, packages, credentials, or services were changed.'
  exit 0
fi

for command in bun node jq openssl tailscale systemd-creds pkexec; do
  require_command "$command"
done
node "$repo_root/scripts/version-policy.mjs" at-least "$(node -p 'process.versions.node')" 24.18.0
node "$repo_root/scripts/version-policy.mjs" at-least "$(bun --version)" 1.3.0

systemd_version="$(systemd_major_version)"
if [[ ! "$systemd_version" =~ ^[0-9]+$ ]] || ((systemd_version < 250)); then
  echo 'systemd 250 or newer is required' >&2
  exit 1
fi

cd "$repo_root/gateway"
bun install --frozen-lockfile
bun run check
bun run build

tailscale_ip="$(tailscale ip -4 2>/dev/null | head -n 1)"
if [[ ! "$tailscale_ip" =~ ^100\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]]; then
  echo 'an authenticated Tailscale IPv4 address is required' >&2
  exit 1
fi

runtime_user="$(id -un)"
exec pkexec "$repo_root/gateway/scripts/install-system-service.sh" "$repo_root/gateway" "$runtime_user" "$tailscale_ip"
