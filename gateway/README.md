# Giggabit Agent Mail Service

This is a tailnet-only MCP gateway for explicitly connected mailbox grants. Agent processes receive short-lived, node-bound run identities; they never receive mailbox passwords, OAuth refresh tokens, or the vault key.

## Owner commands

Run these in a real terminal. Secret prompts disable terminal echo and values are written only to the encrypted local vault.

```bash
giggabit-agent-mail-service-admin list
giggabit-agent-mail-service-admin add-microsoft
giggabit-agent-mail-service-admin add-google
giggabit-agent-mail-service-admin add-password
giggabit-agent-mail-service-admin revoke
giggabit-agent-mail-service-admin verify
giggabit-agent-mail-service-admin reset-circuit
```

For repeatable hosted-mail onboarding, non-secret connection metadata may be
prefilled while the password remains an echo-disabled prompt:

```bash
giggabit-agent-mail-service-admin add-password \
  --mailbox-address owner@example.com \
  --grant-id hosted-owner \
  --label "Hosted owner" \
  --username owner@example.com \
  --imap-host mail.example.com --imap-port 993 --imap-secure yes \
  --smtp-host mail.example.com --smtp-port 465 --smtp-secure yes
```

There is intentionally no password command-line option or environment-variable
path. Passwords and app passwords must be entered only at the hidden prompt.

Microsoft personal accounts use the `consumers` tenant by default. An
organizational account may select its tenant domain or tenant ID without
accepting an arbitrary endpoint:

```bash
giggabit-agent-mail-service-admin add-microsoft \
  --microsoft-tenant example.com \
  --mailbox-address owner@example.com \
  --grant-id organization-owner \
  --label "Organization owner"
```

Microsoft onboarding requires an operator-owned public/native application
registration with delegated IMAP and SMTP permissions and public-client flows
enabled. Google onboarding requires an operator-owned Desktop OAuth client.
Both flows store refresh tokens encrypted at rest and keep access tokens in
memory only. The project provides no shared client identifiers.

Agent MCP configuration uses the stdio launcher:

```json
{
  "command": "giggabit-agent-mail-service-agent"
}
```

The launcher generates a fresh run ID and Ed25519 key each time it starts. The gateway binds the resulting identity to the locally verified Tailscale node for at most eight hours.
Enrollment itself is available only through the private node-local Unix socket;
the tailnet HTTP listener cannot mint identities.

Permanent deletion is not implemented. Outbound sends require idempotency keys and are protected by recipient and rolling rate limits. Attachments are quarantined with private permissions, scanned by ClamAV, and removed when the run ends or after 24 hours. Host paths are withheld from MCP results; eligible text inspection runs inside a networkless, read-only bubblewrap sandbox.

## System installation

Build and test as the unprivileged owner, then run the system installer from a
local desktop terminal so polkit can collect system authentication directly:

```bash
cd gateway
bun run check
bun run build
pkexec ./scripts/install-system-service.sh "$PWD" "$USER" "$(tailscale ip -4 | head -n 1)"
```

The guided top-level installer supports Arch and Debian-family Production
Hosts. It installs ClamAV and bubblewrap, creates a systemd credential bound to
TPM2 plus the host when available or the protected host key otherwise, installs
root-owned runtime code under `/opt`, and runs the service as the non-root
operator account.
