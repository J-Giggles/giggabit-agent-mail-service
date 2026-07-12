#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$repo_root/scripts/synthetic-fixture.sh"

case "${1:-}" in
  '') ;;
  --dry-run)
    cat <<PLAN
Synthetic quickstart plan (no changes made):
  docker pull $SYNTHETIC_MAIL_IMAGE
  ./scripts/verify-integration.sh
The verification container is loopback-only and removed automatically.
PLAN
    exit 0
    ;;
  *) echo 'usage: ./scripts/quickstart.sh [--dry-run]' >&2; exit 2 ;;
esac

"$repo_root/scripts/require-commands.sh" docker
docker pull "$SYNTHETIC_MAIL_IMAGE"
cd "$repo_root"
exec ./scripts/verify-integration.sh
