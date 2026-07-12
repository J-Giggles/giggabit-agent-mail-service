#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$repo_root/scripts/synthetic-fixture.sh"
action="${1:-}"
case "$action" in
  up)
    docker compose -f "$repo_root/compose.yaml" up -d --wait
    echo 'Synthetic Environment is ready on loopback.'
    ;;
  down)
    docker compose -f "$repo_root/compose.yaml" down --volumes --remove-orphans
    ;;
  status)
    docker compose -f "$repo_root/compose.yaml" ps
    ;;
  *) echo 'usage: ./scripts/synthetic-environment.sh up|down|status' >&2; exit 2 ;;
esac
