# MCP clients

The gateway is MCP-client-neutral. A compatible local client launches:

```json
{
  "command": "/usr/local/bin/giggabit-agent-mail-service-agent",
  "args": []
}
```

The launcher enrolls through the local Unix socket, creates an ephemeral proof
key, proxies MCP over the tailnet listener, and revokes the run on exit. Do not
replace it with a direct HTTP URL or copy identity material into config.

## Codex

The optional integration lives under `plugin/`. Install or link that directory
using your Codex plugin workflow, then validate that the MCP server command is
the installed launcher. The plugin adds provider-onboarding and optional
magic-link skills; it does not change gateway authorization.

## Other clients

Configure stdio command launch using the JSON above. Client-specific metadata,
prompts, or UI must treat returned mail content as untrusted and must not
persist credentials or host paths. A client that cannot launch the local
wrapper is unsupported because it cannot satisfy enrollment and proof.
