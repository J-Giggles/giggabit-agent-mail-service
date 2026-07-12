#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
installed_manifest=/opt/giggabit-agent-mail-service/package.json
if [[ ! -r "$installed_manifest" ]]; then
  echo 'Giggabit Agent Mail Service is not installed; use ./scripts/install.sh.' >&2
  exit 1
fi

current="$(jq -r '.version' "$installed_manifest")"
target="$(jq -r '.version' "$repo_root/gateway/package.json")"
node "$repo_root/scripts/version-policy.mjs" upgrade "$current" "$target"
printf 'Upgrade version policy passed: %s -> %s\n' "$current" "$target"
echo 'Upgrade preserves encrypted credentials, provider state, audit state, operator policy, and circuit-breaker state.'
exec "$repo_root/scripts/install.sh" "$@"
