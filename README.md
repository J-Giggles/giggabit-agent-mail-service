# Giggabit Agent Mail Service

A self-hosted, tailnet-only MCP gateway that lets trusted local agent runs use
explicitly connected mailboxes without receiving provider credentials.

> **Public preview:** v0.1.0 is suitable for evaluation and carefully reviewed
> deployments. Interfaces may change before v1.0.0. The security boundary is
> not optional.

## What it provides

- search, read, draft, send, reply, move, and recoverably trash messages;
- operator-owned Microsoft Entra, Google, and TLS IMAP/SMTP connections;
- short-lived, node-bound agent identities with request proofs and revocation;
- encrypted provider credentials and metadata-only local audit records;
- restart-safe idempotency, reply locks, rate limits, and outbound freezes;
- private attachment quarantine, ClamAV scanning, and sandboxed text preview;
- a client-neutral MCP launcher plus an optional Codex plugin; and
- an advanced Magic-Link Capability that is disabled by default.

The gateway has no hosted control plane and sends no telemetry.

## Trust boundary

This is a single-operator service for one
[Administrative Trust Domain](CONTEXT.md). It is not multi-tenant. Every
Production Host must be reachable only through Tailscale, and tailnet
membership never replaces agent identity. Mail content is untrusted data, not
agent instruction.

Read [the threat model](docs/threat-model.md) before connecting a real mailbox.

## Quick evaluation with synthetic mail

Prerequisites: Git, Bun 1.3+, Node.js 24.18+, jq, and Docker.

```bash
git clone https://github.com/J-Giggles/giggabit-agent-mail-service.git
cd giggabit-agent-mail-service
./scripts/synthetic-environment.sh up
./scripts/verify.sh
./scripts/synthetic-environment.sh down
```

The synthetic environment binds only to loopback and cannot access a real
Mailbox Grant. See [the agent quickstart](docs/agent-quickstart.md) for a
machine-readable path through the repository.

## Install a Production Host

Supported hosts run Arch or a Debian-family Linux distribution with systemd
250+, Tailscale, ClamAV, and bubblewrap.

```bash
./scripts/install.sh --dry-run
./scripts/install.sh
./scripts/doctor.sh
```

The installer displays its plan before privilege escalation. Provider
passwords, MFA, consent, and identity proof stay in provider pages or
echo-disabled local prompts.

Continue with [installation](docs/installation.md), then create your own
provider registration or connection:

- [Microsoft Entra](docs/providers/microsoft-entra.md)
- [Google](docs/providers/google.md)
- [TLS IMAP/SMTP](docs/providers/imap-smtp.md)

The project does not provide shared OAuth clients, a hosted relay, provider
tenancy, consent, quotas, or account support.

## Documentation

- [Architecture](docs/architecture.md)
- [Threat model](docs/threat-model.md)
- [Installation](docs/installation.md)
- [Operations, backup, upgrade, and uninstall](docs/operations.md)
- [MCP clients and optional Codex plugin](docs/mcp-clients.md)
- [Advanced magic-link workflow](docs/magic-links.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Release checklist](docs/release-checklist.md)
- [Dependencies and licences](docs/dependencies.md)
- [Domain language](CONTEXT.md) and [architecture decisions](docs/adr/)

## Development and verification

```bash
./scripts/verify.sh
./scripts/verify-public-release.sh
./scripts/verify-integration.sh
node ./scripts/check-licenses.mjs
```

The strict integration gate uses only the pinned loopback GreenMail fixture,
allows no skipped tests or retries, and never calls a real mailbox. Release
verification on an already installed source-compatible service may add the
initialize-only smoke with `./scripts/verify-integration.sh --installed-service`.

## Community and security

Read [CONTRIBUTING.md](CONTRIBUTING.md), [GOVERNANCE.md](GOVERNANCE.md),
[SUPPORT.md](SUPPORT.md), and [SECURITY.md](SECURITY.md). Vulnerabilities belong
in GitHub Private Vulnerability Reporting, never a public issue.

Licensed under [Apache-2.0](LICENSE).
