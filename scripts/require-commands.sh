#!/usr/bin/env bash
set -euo pipefail

missing=()
for command_name in "$@"; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    missing+=("$command_name")
  fi
done

if ((${#missing[@]})); then
  printf 'missing required verification command: %s\n' "${missing[@]}" >&2
  exit 1
fi
