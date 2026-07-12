# Security policy

## Supported versions

The latest v0.x release receives security fixes. Preview releases may change
configuration and protocol details; security invariants do not weaken between
releases.

## Report a vulnerability

Use GitHub Private Vulnerability Reporting for this repository. Do not open a
public issue and do not include live credentials, mailbox content, bearer
links, attachments, databases, logs, recovery material, or provider identity
proof in a report.

Provide the affected version, a minimal synthetic reproduction, impact, and a
suggested mitigation when possible. The maintainer will coordinate disclosure
and attribution through the private report.

## Deployment boundary

The gateway is a single-operator service for one Administrative Trust Domain.
It must listen only on a Tailscale address and still requires short-lived,
node-bound agent identity. It is not safe to expose directly to the public
internet or to use as a multi-tenant service.

See [the threat model](docs/threat-model.md) for the complete boundary.
