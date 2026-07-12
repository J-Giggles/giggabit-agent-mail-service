# Changelog

All notable changes are documented here. The project follows Semantic
Versioning once it reaches 1.0. Before then, breaking changes include migration
notes.

## Unreleased

- harden HTML entity decoding for the disabled-by-default Magic-Link
  Capability;
- make verification fail closed when required tools are missing;
- support releases after the sanitized root commit;
- make the public quickstart exercise strict synthetic integration; and
- group Bun-aware dependency updates and refresh GitHub Actions runtimes.

## 0.1.0 - 2026-07-12

Initial public preview:

- tailnet-only MCP mail gateway with short-lived agent identities;
- operator-owned Microsoft Entra, Google, and TLS IMAP/SMTP providers;
- encrypted credential storage, local metadata-only audit, circuit breakers,
  attachment quarantine, and recoverable deletion;
- guided systemd Linux installation and synthetic Docker environment;
- client-neutral MCP launcher and optional Codex plugin; and
- disabled-by-default, policy-constrained Magic-Link Capability.
