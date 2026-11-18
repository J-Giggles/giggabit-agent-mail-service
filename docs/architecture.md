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

- `folders`: list folders or create a folder for a connected mailbox grant.
  For creation, pass a namespace-relative name in `folder`, such as
  `Finance/Receipts`. Use `/` only to separate segments. Each segment starts
  with an ASCII letter or digit, has at most 63 characters, and can contain
  ASCII letters, digits, spaces, underscores, periods, and hyphens. A segment
  cannot end in a space, spell `NIL`, or contain the server's hierarchy
  delimiter. Repeating an exact create succeeds and returns the
  native path for other mailbox operations. Each mailbox grant allows up to
  10 creation requests per elapsed minute across service restarts.
  The server must match the namespace pin below. If an exact create cannot be
  confirmed and LIST shows different casing, use the listed path for subsequent
  mailbox operations.
- `messages`: search, read, move, and recoverably trash.
- `send`: draft, send, and reply with idempotency and volume controls.
- `attachments`: quarantine, scan, and inspect eligible text in a sandbox.
- `magic_link`: optional claim, release, and consume operations; absent unless
  operator policy enables it.

## Folder creation namespace pins

| Provider | Personal prefix | Hierarchy delimiter | Revision | Other-user and shared namespaces |
| --- | --- | --- | --- | --- |
| Google OAuth | Empty | `/` | IMAP4rev1 | Absent |
| Microsoft OAuth | Empty | `/` | IMAP4rev1 | Absent |

On 2026-11-18, signed folder LIST succeeded on two Google and three Microsoft
grants. Both Google results and two Microsoft results showed slash hierarchy.
The third Microsoft result showed root paths only. The public endpoints advertised
`IMAP4rev1` and `NAMESPACE` before authentication. Google's IMAP examples
show root-relative LIST names with a slash delimiter. Microsoft documents
IMAP OAuth access, and the live LIST results supply the delimiter evidence.
[Google IMAP extensions](https://developers.google.com/workspace/gmail/imap/imap-extensions) ·
[Microsoft IMAP authentication](https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth)

LIST cannot confirm the absence of other-user or shared namespaces. The first
live create checks the authenticated `NAMESPACE` reply before its folder LIST
or CREATE. An unsupported-namespace response calls for reviewing the pin.
The three hosted IMAP grants refused the read-only probe, so folder creation
has no hosted IMAP pin.

## Extension seams

Provider adapters implement the mailbox interface. MCP Client Integrations use
the local launcher and cannot replace identity or network verification. New
capabilities belong behind the same audit and policy boundary.

See [the threat model](threat-model.md) and [ADRs](adr/).
