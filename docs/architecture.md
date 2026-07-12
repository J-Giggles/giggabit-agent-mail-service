# Architecture

The service is a host-level capability broker between local MCP clients and
operator-authorized mail providers.

## Components

1. A local launcher creates an ephemeral Ed25519 keypair and enrolls through a
   mode-0600 Unix socket.
2. The gateway issues a short-lived Agent Mail Identity bound to the key, run,
   and verified Tailscale node.
3. Every MCP request carries a signed proof, timestamp, nonce, and identity.
4. Provider adapters use credentials from the encrypted Credential Vault.
5. The gateway records metadata-only audit events and applies circuit breakers,
   idempotency, attachment quarantine, and content-trust labeling.

The tailnet HTTP listener cannot mint identities. The MCP client never receives
provider credentials, the vault key, host paths, or plaintext magic links.

## Durable and ephemeral state

- Provider credentials are encrypted in a mode-0600 SQLite vault.
- The master key is a systemd encrypted credential bound to TPM2 plus the host
  when available, or to the protected host key otherwise.
- Audit and circuit-breaker databases contain metadata, not message bodies.
- Agent proof keys, access tokens, and fetched bodies remain in memory.
- Attachments live in private per-run quarantine and expire after 24 hours.

## MCP tools

- `folders`: list folders.
- `messages`: search, read, move, and recoverably trash.
- `send`: draft, send, and reply with idempotency and volume controls.
- `attachments`: quarantine, scan, and inspect eligible text in a sandbox.
- `magic_link`: optional claim, release, and consume operations; absent unless
  operator policy enables it.

## Extension seams

Provider adapters implement the mailbox interface. MCP Client Integrations use
the local launcher and cannot replace identity or network verification. New
capabilities belong behind the same audit and policy boundary.

See [the threat model](threat-model.md) and [ADRs](adr/).
