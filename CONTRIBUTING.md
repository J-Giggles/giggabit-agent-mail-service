# Contributing

Thank you for improving the project. Start with an issue for behavior or
security-boundary changes. Small documentation and test fixes may go directly
to a pull request.

## Development

1. Install Bun 1.3 or newer, Node.js 24.18 or newer, jq, and Docker.
2. Run `./scripts/synthetic-environment.sh up`.
3. Run `./scripts/verify.sh`.
4. Run `./scripts/verify-public-release.sh`.
5. Run `./scripts/synthetic-environment.sh down` when finished.

Tests use only synthetic fixtures. Never use a real mailbox, provider token,
message, attachment, runtime database, or host diagnostic as a fixture.

## Pull requests

- Describe the user-visible behavior and security impact.
- Add red and green test evidence for behavior changes.
- Update documentation and `CHANGELOG.md`.
- Keep commits free of generated dependencies, runtime state, and secrets.
- Accept that intentionally submitted contributions are licensed under
  Apache-2.0 unless explicitly stated otherwise.

See [AGENTS.md](AGENTS.md) for the same workflow in agent-actionable form.
