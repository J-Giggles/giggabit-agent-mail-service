# Threat model

## Protected assets

- mailbox passwords and OAuth refresh/access tokens;
- the Credential Vault master key;
- message content, attachments, and passwordless bearer links;
- the ability to send, reply, move, or trash mail; and
- trustworthy attribution and audit records.

## Trusted boundary

One operator administers one Production Host and its Mailbox Grants. Enrolled
agent runs inside that Administrative Trust Domain may use connected grants.
The service does not provide per-agent grant authorization and is not
multi-tenant.

Trusted components are the root-owned installation, systemd, the local
enrollment socket, Tailscale node verification, the gateway, and operator-owned
provider configuration. Mail content, MCP arguments, provider responses, and
attachments are untrusted.

## Defenses

- Tailnet reachability and short-lived Agent Mail Identity are independent
  gates; every request also proves possession of an ephemeral private key.
- Identity enrollment is node-local and never exposed on HTTP.
- Credentials are encrypted at rest and never supplied through agent-visible
  arguments or environment variables.
- HTML is sanitized; remote content is not loaded; links are not opened
  automatically; attachments fail closed through ClamAV and bubblewrap.
- Sends and replies require idempotency keys and enforce recipient, rate, loop,
  bounce, and automatic-response controls.
- Deletion moves mail to provider trash; permanent deletion is unsupported.
- Logs and audit records exclude message content and credential material.
- The Magic-Link Capability is disabled by default and cannot exceed operator
  grant/sender/exact-host policy.

## Explicit non-goals

- public-internet exposure;
- hosted relay or control plane;
- mutually untrusted or multi-tenant users;
- protection from a fully compromised root account or provider account;
- provider availability, consent, quotas, or account recovery; and
- per-agent mailbox authorization in v0.1.0.

Operators needing stronger isolation use separate Production Hosts or OS-level
trust domains. Report boundary failures through [SECURITY.md](../SECURITY.md).
