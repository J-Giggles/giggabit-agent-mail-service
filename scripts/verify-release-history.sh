#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

tag="${1:-}"
expected_tag="v$(jq -r '.version' gateway/package.json)"
if [[ "$tag" != "$expected_tag" ]]; then
  printf 'release tag must match package version: expected %s\n' "$expected_tag" >&2
  exit 1
fi
if [[ "$(git rev-list --count HEAD)" != 1 ]]; then
  echo 'public release history must contain exactly one commit' >&2
  exit 1
fi
if [[ "$(git rev-list --parents -n 1 HEAD | wc -w)" != 1 ]]; then
  echo 'public release commit must be a root commit' >&2
  exit 1
fi
if [[ -n "$(git status --porcelain)" ]]; then
  echo 'public release worktree must be clean' >&2
  exit 1
fi
if git rev-parse --verify --quiet "refs/tags/$tag" >/dev/null && \
  [[ "$(git rev-parse "$tag^{commit}")" != "$(git rev-parse HEAD)" ]]; then
  echo 'release tag does not point to the exact candidate commit' >&2
  exit 1
fi

echo "Single-root public history and release version passed for $tag."
