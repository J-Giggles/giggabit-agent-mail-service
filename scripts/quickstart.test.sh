#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$repo_root/scripts/synthetic-fixture.sh"
plan="$("$repo_root/scripts/quickstart.sh" --dry-run)"

[[ "$SYNTHETIC_MAIL_IMAGE" =~ ^greenmail/standalone:2\.1\.9@sha256:[0-9a-f]{64}$ ]]
grep -q "$SYNTHETIC_MAIL_IMAGE" <<<"$plan"
grep -q './scripts/verify-integration.sh' <<<"$plan"
grep -q './scripts/quickstart.sh' "$repo_root/README.md"

echo 'Synthetic quickstart behavior passed.'
