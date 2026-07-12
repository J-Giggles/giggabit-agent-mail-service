#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
plan="$("$repo_root/scripts/quickstart.sh" --dry-run)"

grep -q 'greenmail/standalone:2.1.9' <<<"$plan"
grep -q './scripts/verify-integration.sh' <<<"$plan"
grep -q './scripts/quickstart.sh' "$repo_root/README.md"

echo 'Synthetic quickstart behavior passed.'
