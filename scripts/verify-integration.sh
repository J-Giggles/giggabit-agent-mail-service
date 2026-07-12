#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$repo_root/scripts/synthetic-fixture.sh"
container="giggabit-agent-mail-service-verify-$$"
installed_service=no
case "${1:-}" in
  '') ;;
  --installed-service) installed_service=yes ;;
  *) echo 'usage: ./scripts/verify-integration.sh [--installed-service]' >&2; exit 2 ;;
esac

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM

if ! docker image inspect "$SYNTHETIC_MAIL_IMAGE" >/dev/null 2>&1; then
  echo "Missing pinned synthetic mail image: $SYNTHETIC_MAIL_IMAGE" >&2
  echo "Install it explicitly with: docker pull $SYNTHETIC_MAIL_IMAGE" >&2
  exit 1
fi

docker run -d --rm --name "$container" \
  -e 'GREENMAIL_OPTS=-Dgreenmail.setup.test.smtp -Dgreenmail.setup.test.imap -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.users=test1:pwd1@localhost' \
  -p 127.0.0.1::3025 \
  -p 127.0.0.1::3143 \
  "$SYNTHETIC_MAIL_IMAGE" >/dev/null

smtp_address="$(docker port "$container" 3025/tcp)"
imap_address="$(docker port "$container" 3143/tcp)"
smtp_port="${smtp_address##*:}"
imap_port="${imap_address##*:}"

ready=no
for _ in {1..50}; do
  if timeout 1 bash -c "</dev/tcp/127.0.0.1/$smtp_port" >/dev/null 2>&1 && \
    timeout 1 bash -c "</dev/tcp/127.0.0.1/$imap_port" >/dev/null 2>&1; then
    ready=yes
    break
  fi
  sleep 0.1
done

if [ "$ready" != yes ]; then
  echo "Synthetic SMTP/IMAP fixture did not become ready." >&2
  exit 1
fi

TEST_MAIL_HOST=127.0.0.1 \
TEST_MAIL_SMTP_PORT="$smtp_port" \
TEST_MAIL_IMAP_PORT="$imap_port" \
  "$repo_root/scripts/verify.sh"

node "$repo_root/scripts/verify-built-launcher.mjs"

if [[ "$installed_service" == yes ]]; then
  node "$repo_root/scripts/verify-mcp-initialize.mjs"
fi

echo 'Synthetic provider, built launcher, and protected MCP seams passed with zero skipped tests.'
