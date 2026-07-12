#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dry_run=no
purge=no
confirmed=no
for argument in "$@"; do
  case "$argument" in
    --dry-run) dry_run=yes ;;
    --purge-state) purge=yes ;;
    --confirm-purge) confirmed=yes ;;
    -h|--help)
      echo 'usage: ./scripts/uninstall.sh [--dry-run] [--purge-state --confirm-purge]'
      exit 0
      ;;
    *) printf 'unknown uninstall option: %s\n' "$argument" >&2; exit 2 ;;
  esac
done

if [[ "$confirmed" == yes && "$purge" != yes ]]; then
  echo '--confirm-purge requires --purge-state' >&2
  exit 2
fi
if [[ "$purge" == yes && "$confirmed" != yes && "$dry_run" != yes ]]; then
  echo 'permanent state deletion requires --purge-state --confirm-purge' >&2
  exit 2
fi

echo 'Uninstall plan'
echo '- stop and disable giggabit-agent-mail-service.service'
echo '- remove installed program files, launchers, and service unit'
if [[ "$purge" == yes ]]; then
  echo '- permanently delete encrypted provider state, audit state, and the encrypted vault credential'
else
  echo '- preserve encrypted provider state, audit state, and the encrypted vault credential'
fi

if [[ "$dry_run" == yes ]]; then
  echo 'Dry run complete; no files, credentials, or services were changed.'
  exit 0
fi

command -v pkexec >/dev/null 2>&1 || { echo 'pkexec is required' >&2; exit 1; }
mode=preserve
[[ "$purge" == yes ]] && mode=purge
exec pkexec "$repo_root/gateway/scripts/uninstall-system-service.sh" "$mode"
