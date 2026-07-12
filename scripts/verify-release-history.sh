#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

tag="${1:-}"
expected_tag="v$(jq -r '.version' gateway/package.json)"
public_root_sha="${GIGGABIT_PUBLIC_ROOT_SHA:-3ec8cfacc1d06fb216743fab746264b188db02ce}"
if [[ "$tag" != "$expected_tag" ]]; then
  printf 'release tag must match package version: expected %s\n' "$expected_tag" >&2
  exit 1
fi
mapfile -t root_commits < <(git rev-list --max-parents=0 HEAD)
if [[ "${#root_commits[@]}" != 1 || "${root_commits[0]}" != "$public_root_sha" ]]; then
  echo 'public release history must descend from the exact sanitized root' >&2
  exit 1
fi
if ! git merge-base --is-ancestor "$public_root_sha" HEAD; then
  echo 'sanitized public root is not an ancestor of the release candidate' >&2
  exit 1
fi
if [[ -n "$(git status --porcelain)" ]]; then
  echo 'public release worktree must be clean' >&2
  exit 1
fi
if ! git rev-parse --verify --quiet "refs/tags/$tag" >/dev/null; then
  echo 'release tag does not exist in the candidate history' >&2
  exit 1
fi
if [[ "$(git rev-parse "$tag^{commit}")" != "$(git rev-parse HEAD)" ]]; then
  echo 'release tag does not point to the exact candidate commit' >&2
  exit 1
fi

echo "Sanitized-root ancestry and release version passed for $tag."
