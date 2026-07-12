#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

arch_plan="$("$repo_root"/scripts/install.sh --dry-run --platform=arch)"
grep -q 'platform family: arch' <<<"$arch_plan"
grep -q 'no files, packages, credentials, or services were changed' <<<"$arch_plan"

debian_plan="$("$repo_root"/scripts/install.sh --dry-run --platform=debian)"
grep -q 'platform family: debian' <<<"$debian_plan"

if "$repo_root/scripts/install.sh" --platform=debian >/dev/null 2>&1; then
  echo 'non-dry platform override unexpectedly succeeded' >&2
  exit 1
fi

if "$repo_root/scripts/uninstall.sh" --purge-state >/dev/null 2>&1; then
  echo 'unconfirmed state purge unexpectedly succeeded' >&2
  exit 1
fi

purge_plan="$("$repo_root"/scripts/uninstall.sh --dry-run --purge-state)"
grep -q 'permanently delete encrypted provider state' <<<"$purge_plan"

doctor_status=0
doctor_report="$("$repo_root"/scripts/doctor.sh --json 2>/dev/null)" || doctor_status=$?
jq -e '
  keys == ["node_supported", "required_commands", "service_active", "systemd_supported", "tailscale_ready", "values_suppressed"] and
  .values_suppressed == true and
  ([.node_supported,.required_commands,.service_active,.systemd_supported,.tailscale_ready] | all(type == "boolean"))
' <<<"$doctor_report" >/dev/null
if grep -Eq '(/home/|/Users/|100\.[0-9]|@|\.sqlite|\.log)' <<<"$doctor_report"; then
  echo 'Diagnostic Report exposed a sensitive value shape' >&2
  exit 1
fi
[[ "$doctor_status" == 0 || "$doctor_status" == 1 ]]

node "$repo_root/scripts/version-policy.mjs" at-least 24.18.0 24.18.0
node "$repo_root/scripts/version-policy.mjs" at-least 25.0.0 24.18.0
if node "$repo_root/scripts/version-policy.mjs" at-least 24.17.9 24.18.0 >/dev/null 2>&1; then
  echo 'unsupported Node.js version unexpectedly passed' >&2
  exit 1
fi
node "$repo_root/scripts/version-policy.mjs" upgrade 0.1.0 0.2.0
if node "$repo_root/scripts/version-policy.mjs" upgrade 0.2.0 0.1.0 >/dev/null 2>&1; then
  echo 'downgrade unexpectedly passed' >&2
  exit 1
fi

echo 'Lifecycle command behavior passed.'
