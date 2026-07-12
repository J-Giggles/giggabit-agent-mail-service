#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
"$repo_root/scripts/quickstart.sh"

if docker ps -a --filter 'name=giggabit-agent-mail-service-verify-' --format '{{.ID}}' | grep -q .; then
  echo 'synthetic quickstart left a verification container behind' >&2
  exit 1
fi
if docker network ls --filter label=com.docker.compose.project=giggabit-agent-mail-service-synthetic \
  --format '{{.ID}}' | grep -q .; then
  echo 'synthetic quickstart left a project network behind' >&2
  exit 1
fi

echo 'Synthetic quickstart integration and cleanup passed.'
