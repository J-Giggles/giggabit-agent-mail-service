# Disable the Magic-Link Capability by default

The public gateway will retain its encrypted, single-use Magic-Link Capability
and loopback staging harness, but it will not advertise or execute that
capability unless an operator explicitly enables it. Enablement requires an
operator-controlled allowlist of Mailbox Grants, expected senders, and exact
HTTPS hostnames; agent input may narrow but never expand that policy. Claims
remain bound to one run, expire after five minutes, never expose the bearer URL
as plaintext to the MCP client, and consume or release the correlated message
through the existing fail-closed flow. This preserves useful passwordless-auth
automation without making a high-impact capability part of ordinary mail
access or trusting an agent-supplied destination by itself.
