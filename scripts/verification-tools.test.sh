#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT

ln -s "$(command -v jq)" "$fixture/jq"
PATH="$fixture" /bin/bash "$repo_root/scripts/require-commands.sh" jq >/dev/null

status=0
output="$(PATH="$fixture" /bin/bash "$repo_root/scripts/require-commands.sh" jq rg 2>&1)" || status=$?
if [[ "$status" == 0 || "$output" != *"rg"* ]]; then
  echo 'missing ripgrep did not fail closed with an actionable error' >&2
  exit 1
fi

echo 'Verification tool requirements passed.'
