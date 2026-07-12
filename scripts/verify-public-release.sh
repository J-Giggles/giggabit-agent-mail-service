#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

required_files=(
  LICENSE
  README.md
  SECURITY.md
  CONTRIBUTING.md
  CODE_OF_CONDUCT.md
  SUPPORT.md
  GOVERNANCE.md
  CHANGELOG.md
  AGENTS.md
  CONTEXT.md
  compose.yaml
  docs/architecture.md
  docs/threat-model.md
  docs/installation.md
  docs/operations.md
  docs/troubleshooting.md
  docs/mcp-clients.md
  docs/magic-links.md
  docs/providers/microsoft-entra.md
  docs/providers/google.md
  docs/providers/imap-smtp.md
  docs/agent-quickstart.md
  docs/release-checklist.md
  docs/dependencies.md
  scripts/install.sh
  scripts/quickstart.sh
  scripts/doctor.sh
  scripts/upgrade.sh
  scripts/uninstall.sh
  scripts/synthetic-environment.sh
  scripts/check-markdown-links.mjs
  scripts/verify-built-launcher.mjs
  scripts/check-licenses.mjs
  scripts/check-release-metadata.mjs
  scripts/require-commands.sh
  scripts/version-policy.mjs
  scripts/verify-release-history.sh
  .github/workflows/ci.yml
  .github/workflows/codeql.yml
  .github/workflows/release.yml
  .github/dependabot.yml
  .github/ISSUE_TEMPLATE/bug_report.yml
  .github/ISSUE_TEMPLATE/feature_request.yml
  .github/pull_request_template.md
)

failures=0
for file in "${required_files[@]}"; do
  if [[ ! -f "$file" ]]; then
    printf 'missing required public file: %s\n' "$file" >&2
    failures=$((failures + 1))
  fi
done

./scripts/require-commands.sh bash git jq node rg shellcheck
release_version="$(node ./scripts/check-release-metadata.mjs)"

disallowed_paths=(
  HANDOFF.md
  docs/ONBOARDING_STATUS.md
  docs/MIGRATION.md
  docs/verification
)
for file in "${disallowed_paths[@]}"; do
  if [[ -f "$file" ]]; then
    printf 'private operational file is still present: %s\n' "$file" >&2
    failures=$((failures + 1))
  fi
done

private_patterns=(
  '/home/[a-z_][a-z0-9_-]*/'
  '/Users/[^/]+/'
  '(Linear|Jira)[[:space:]]+(issue|ticket)?'
  'private (fleet|tailnet)'
  'personal marketplace'
)

for pattern in "${private_patterns[@]}"; do
  mapfile -t files < <(rg -l --hidden \
    -g '!.git' \
    -g '!.git/**' \
    -g '!gateway/node_modules/**' \
    -g '!gateway/dist/**' \
    -g '!scripts/verify-public-release.sh' \
    -e "$pattern" . 2>/dev/null || true)
  if ((${#files[@]})); then
    printf 'private identity/configuration pattern remains in:\n' >&2
    printf '  %s\n' "${files[@]}" >&2
    failures=$((failures + 1))
  fi
done

if ! jq -e --arg version "$release_version" '
  .name == "@giggabit/agent-mail-service" and
  .version == $version and
  .private == true and
  .license == "Apache-2.0" and
  .repository.url == "git+https://github.com/J-Giggles/giggabit-agent-mail-service.git" and
  .bugs.url == "https://github.com/J-Giggles/giggabit-agent-mail-service/issues" and
  .homepage == "https://github.com/J-Giggles/giggabit-agent-mail-service#readme"
' gateway/package.json >/dev/null; then
  echo 'package metadata is not public-release ready' >&2
  failures=$((failures + 1))
fi

if ! jq -e '
  ((.dependencies // {}) + (.devDependencies // {}) | keys |
    all(test("sentry|telemetry|analytics|opentelemetry|datadog|newrelic"; "i") | not))
' gateway/package.json >/dev/null; then
  echo 'telemetry dependency detected' >&2
  failures=$((failures + 1))
fi

mapfile -t provider_identifier_files < <(
  rg -l --hidden --glob '!*.test.ts' --glob '!gateway/node_modules/**' --glob '!gateway/dist/**' \
    '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}' \
    docs plugin gateway/src 2>/dev/null || true
)
if ((${#provider_identifier_files[@]})); then
  echo 'provider-registration-shaped identifier remains in public source:' >&2
  printf '  %s\n' "${provider_identifier_files[@]}" >&2
  failures=$((failures + 1))
fi

if ! jq -e --arg version "$release_version" '
  .name == "giggabit-agent-mail-service" and
  .version == $version and
  .author.name == "J-Giggles" and
  (.description | contains("private") | not)
' plugin/.codex-plugin/plugin.json >/dev/null; then
  echo 'plugin metadata is not public-release ready' >&2
  failures=$((failures + 1))
fi

if ((failures)); then
  printf 'public-release verification failed with %d category error(s)\n' "$failures" >&2
  exit 1
fi

for script in scripts/*.sh gateway/scripts/*.sh gateway/bin/*.in; do
  bash -n "$script"
done
./scripts/lifecycle.test.sh
node ./scripts/check-markdown-links.mjs
node ./scripts/check-licenses.mjs

shellcheck scripts/*.sh gateway/scripts/*.sh gateway/bin/*.in

if rg -n 'uses:\s+[^@]+@(?![0-9a-f]{40}(?:\s|$))' .github/workflows --pcre2; then
  echo 'GitHub Actions must be pinned to full commit SHAs' >&2
  exit 1
fi

echo 'Public-release files, metadata, and identity scrub passed.'
