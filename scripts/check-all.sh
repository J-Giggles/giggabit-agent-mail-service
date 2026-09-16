#!/usr/bin/env bash
# Run all CI checks locally before pushing
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

echo "=== Running all CI checks locally ==="
echo

echo "1/5 Verifying portable source (typecheck, tests, build)..."
./scripts/verify.sh
echo "✓ Portable source verification passed"
echo

echo "2/5 Verifying public release surface (shellcheck, metadata)..."
./scripts/verify-public-release.sh
echo "✓ Public release verification passed"
echo

echo "3/5 Checking licenses..."
node ./scripts/check-licenses.mjs
echo "✓ License check passed"
echo

echo "4/5 Auditing dependencies..."
cd gateway
bun audit
cd ..
echo "✓ Dependency audit passed"
echo

echo "5/5 Running integration tests (Docker required)..."
if command -v docker &> /dev/null; then
  ./scripts/quickstart.integration.test.sh
  echo "✓ Integration tests passed"
else
  echo "⚠ Docker not found, skipping integration tests"
  echo "  Install Docker to run: ./scripts/quickstart.integration.test.sh"
fi
echo

echo "=== All checks passed! ==="
echo "Your changes are ready to push."
