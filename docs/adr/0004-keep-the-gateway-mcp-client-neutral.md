# Keep the gateway MCP-client-neutral

The gateway and its local launcher will implement the standard MCP boundary
without depending on Codex or any client-specific runtime. The Codex
plugin remains a supported optional MCP Client Integration, and public docs
will include client-neutral configuration examples. Every integration must use
the same node-local enrollment, short-lived identity, tailnet source check,
and request-proof controls; client-specific configuration cannot bypass or
move those controls into the client. This keeps the security boundary in one
place while allowing any compatible local MCP client to use the service.
