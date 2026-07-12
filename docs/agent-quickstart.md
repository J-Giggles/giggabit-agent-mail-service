# Agent quickstart

Use this path to understand, verify, or modify the repository without touching
a live mailbox.

1. Read `AGENTS.md`, `CONTEXT.md`, `docs/threat-model.md`, and relevant ADRs.
2. Confirm the working tree contains no runtime state or credential-like files.
3. Start the Synthetic Environment with
   `./scripts/synthetic-environment.sh up`.
4. Run `./scripts/verify.sh` and `./scripts/verify-public-release.sh`.
5. Make changes through public seams with red-before-green tests.
6. Run focused tests and typechecking during work.
7. Run the full gates and stop the Synthetic Environment before handoff.

Never inspect host runtime directories, live service logs, mailboxes, provider
pages, or credential stores. If a task requires provider identity proof, MFA,
or destructive publication, stop at that human boundary.

## Useful entry points

- Gateway assembly: `gateway/src/service-main.ts`
- MCP boundary: `gateway/src/mcp-handler.ts`
- Mail capabilities: `gateway/src/gateway.ts`
- Provider onboarding: `gateway/src/admin-main.ts`
- System install: `scripts/install.sh`
- Public release gate: `scripts/verify-public-release.sh`

The optional Codex plugin is an integration, not the core trust boundary.
