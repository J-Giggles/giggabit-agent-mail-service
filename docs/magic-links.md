# Advanced Magic-Link Capability

The Magic-Link Capability handles an expected passwordless-authentication
message without exposing its bearer URL as plaintext to the MCP client. It is
disabled by default.

Enable it only for a dedicated non-primary mailbox and staging/test
application. Operator Configuration must allowlist the Mailbox Grant, expected
sender, and exact HTTPS hostname. Agent arguments may narrow but cannot expand
that policy.

Edit `/etc/giggabit-agent-mail-service/operator.json` as root, using only your
own non-secret policy identifiers:

```json
{
  "magic_link": {
    "enabled": true,
    "rules": [
      {
        "grant_id": "staging-mail",
        "expected_senders": ["login@example.invalid"],
        "expected_hostnames": ["staging.example.invalid"]
      }
    ]
  }
}
```

Restart the service after policy changes. Keep `enabled` false when the
capability is not required.

Claims are correlated by request time, recipient alias, sender, and exact
hostname; bound to one agent run; encrypted to a caller-supplied public key;
single-use; and limited to five minutes. Consumption moves the correlated
message to provider trash. Release abandons the claim without disclosing the
link.

Never use ordinary message search/read to obtain a magic link, never copy it
into model context, and never let mail content choose a destination. The
included loopback staging harness is synthetic test infrastructure, not a
production web application.
