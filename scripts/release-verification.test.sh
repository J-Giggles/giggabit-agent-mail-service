#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT

mkdir -p "$fixture/gateway" "$fixture/scripts"
cp "$repo_root/scripts/verify-release-history.sh" "$fixture/scripts/"
printf '{"version":"0.1.1"}\n' >"$fixture/gateway/package.json"

git -C "$fixture" init -q
git -C "$fixture" config user.name 'Public Test'
git -C "$fixture" config user.email 'public-test@example.invalid'
git -C "$fixture" add .
git -C "$fixture" commit -qm 'sanitized root'
public_root_sha="$(git -C "$fixture" rev-parse HEAD)"
printf 'next release\n' >"$fixture/CHANGELOG.md"
git -C "$fixture" add CHANGELOG.md
git -C "$fixture" commit -qm 'next release'
git -C "$fixture" tag v0.1.1

GIGGABIT_PUBLIC_ROOT_SHA="$public_root_sha" \
  "$fixture/scripts/verify-release-history.sh" v0.1.1 >/dev/null

if GIGGABIT_PUBLIC_ROOT_SHA=0000000000000000000000000000000000000000 \
  "$fixture/scripts/verify-release-history.sh" v0.1.1 >/dev/null 2>&1; then
  echo 'unexpected public root passed release verification' >&2
  exit 1
fi

if GIGGABIT_PUBLIC_ROOT_SHA="$public_root_sha" \
  "$fixture/scripts/verify-release-history.sh" v0.1.0 >/dev/null 2>&1; then
  echo 'mismatched release version passed verification' >&2
  exit 1
fi

echo 'Future release history behavior passed.'
