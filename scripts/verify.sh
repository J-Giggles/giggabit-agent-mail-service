#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

required_files=(
  "gateway/package.json"
  "gateway/bun.lock"
  "gateway/src/service-main.ts"
  "gateway/src/magic-link-staging-main.ts"
  "gateway/src/admin-main.ts"
  "gateway/bin/giggabit-agent-mail-service.in"
  "gateway/bin/giggabit-agent-mail-service-agent.in"
  "gateway/bin/giggabit-agent-mail-service-admin.in"
  "gateway/bin/giggabit-agent-mail-service-admin-root.in"
  "gateway/systemd/giggabit-agent-mail-service.service.in"
  "gateway/scripts/install-system-service.sh"
  "gateway/scripts/uninstall-system-service.sh"
  "plugin/.codex-plugin/plugin.json"
  "plugin/.mcp.json"
  "plugin/skills/complete-magic-link-auth/SKILL.md"
  "plugin/skills/onboard-mailboxes/SKILL.md"
  "scripts/install.sh"
  "scripts/doctor.sh"
  "scripts/upgrade.sh"
  "scripts/uninstall.sh"
  "scripts/lifecycle.test.sh"
  "scripts/verify-integration.sh"
  "scripts/verify-mcp-initialize.mjs"
  "scripts/verify-built-launcher.mjs"
)

for file in "${required_files[@]}"; do
  test -f "$repo_root/$file" || {
    echo "Missing required portable source: $file" >&2
    exit 1
  }
done

if find "$repo_root" -type f \( \
  -name '*.sqlite' -o -name '*.sqlite-*' -o -name '*.db' -o -name '*.db-*' -o \
  -name '*.pem' -o -name '*.key' -o -name '.env' -o -name '.env.local' -o \
  -name '*token*.json' -o -name '*credentials*.json' \
\) -print -quit | grep -q .; then
  echo "Protected runtime or credential-like files are present in the source tree." >&2
  exit 1
fi

if rg -n --hidden \
  -g '!.git/**' \
  -g '!gateway/node_modules/**' \
  -g '!gateway/dist/**' \
  -e '-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----' \
  -e 'AKIA[0-9A-Z]{16}' \
  -e 'GOCSPX-[A-Za-z0-9_-]{20,}' \
  -e 'gh[pousr]_[A-Za-z0-9]{30,}' \
  -e 'sk-(proj-)?[A-Za-z0-9_-]{20,}' \
  -e 'xox[baprs]-[A-Za-z0-9-]{10,}' \
  "$repo_root"; then
  echo "A credential-shaped value was found in portable source." >&2
  exit 1
fi

jq -e '
  .name == "giggabit-agent-mail-service" and
  (.version | type == "string") and
  .skills == "./skills/" and
  .mcpServers == "./.mcp.json"
' "$repo_root/plugin/.codex-plugin/plugin.json" >/dev/null

jq -e '
  .mcpServers["giggabit-agent-mail-service"].command == "/usr/local/bin/giggabit-agent-mail-service-agent"
' "$repo_root/plugin/.mcp.json" >/dev/null

jq -e '
  .name == "@giggabit/agent-mail-service" and
  .bin["giggabit-agent-mail-service"] == "dist/service-main.js" and
  .bin["giggabit-agent-mail-service-agent"] == "dist/launcher-main.js" and
  .bin["giggabit-agent-mail-service-admin"] == "dist/admin-main.js"
' "$repo_root/gateway/package.json" >/dev/null

grep -q '^Description=Giggabit Agent Mail Service$' \
  "$repo_root/gateway/systemd/giggabit-agent-mail-service.service.in"
grep -q '^StateDirectory=giggabit-agent-mail-service$' \
  "$repo_root/gateway/systemd/giggabit-agent-mail-service.service.in"
grep -q '^RuntimeDirectory=giggabit-agent-mail-service$' \
  "$repo_root/gateway/systemd/giggabit-agent-mail-service.service.in"

sh -n "$repo_root/gateway/scripts/install-system-service.sh"
sh -n "$repo_root/gateway/scripts/uninstall-system-service.sh"
for template in "$repo_root"/gateway/bin/*.in; do
  sh -n "$template"
done

grep -q '^name: onboard-mailboxes$' \
  "$repo_root/plugin/skills/onboard-mailboxes/SKILL.md"
grep -q '^name: complete-magic-link-auth$' \
  "$repo_root/plugin/skills/complete-magic-link-auth/SKILL.md"

"$repo_root/scripts/lifecycle.test.sh"

cd "$repo_root/gateway"
bun install --frozen-lockfile
bun run check
bun run build

echo "Portable source, lifecycle checks, gateway checks, build, plugin structure, and secret scan passed."
