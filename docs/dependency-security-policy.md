# Dependency Security Policy

This document explains the dependency management and security audit policies for the Giggabit Agent Mail Service.

## Security Auditing

All dependencies are audited for known security vulnerabilities using `bun audit` as part of the CI pipeline.

**CI Requirement**: The `verify` job must pass with zero vulnerabilities. PRs with failing audits will be blocked.

## Dependency Update Strategy

### Direct Dependencies

Direct dependencies are updated based on:
- **Security fixes**: Applied immediately when vulnerabilities are disclosed
- **Minor/patch updates**: Applied via dependabot when safe
- **Major updates**: Evaluated individually for breaking changes

Current direct dependencies and their security requirements:
- `@modelcontextprotocol/sdk`: MCP protocol implementation
- `imapflow`: IMAP client library
- `mailparser`: Email parsing library
- `nodemailer`: SMTP client library
- `zod`: Runtime validation

### Transitive Dependencies

Transitive dependencies (dependencies of dependencies) may contain vulnerabilities that cannot be fixed by updating direct dependencies alone.

**Resolution Strategy**: Use `package.json` `overrides` field to force safe versions of transitive dependencies.

## Current Override Policy

The following overrides are applied to fix security vulnerabilities in transitive dependencies:

```json
{
  "@hono/node-server": ">=1.19.15",  // Fixes GHSA-frvp-7c67-39w9 (path traversal)
  "fast-uri": ">=3.1.6",              // Fixes multiple SSRF vulnerabilities
  "hono": ">=4.13.5",                 // Fixes ReDoS, SSR disclosure, DoS issues
  "ip-address": ">=10.3.1",           // Fixes SSRF and trust-boundary bypass
  "nanoid": ">=3.3.18",               // Fixes indefinite loop vulnerabilities
  "nodemailer": "9.1.1",              // Fixes DoS and domain validation bypass
  "postcss": ">=8.5.23",              // Fixes path traversal in source maps
  "qs": ">=6.16.0"                    // Fixes DoS and array-limit bypass
}
```

### Override Rationale

**Why exact version for nodemailer?**
The `mailparser` package pins `nodemailer@9.0.6`, which has known vulnerabilities. We override to `9.1.1` (exact) to ensure consistency while fixing CVEs:
- GHSA-8m3c-c648-2xjj (moderate)
- GHSA-wmmp-3585-3rmp (moderate)
- GHSA-2x7j-588g-ccc2 (high - DoS via crafted addresses)
- GHSA-cc9r-2j5m-2m83 (moderate)

**Why range versions for others?**
Using `>=` allows patch and minor updates while ensuring we stay above the vulnerable versions. This provides ongoing security fixes without manual intervention.

## Verification Process

Before merging any PR:

1. **Local audit check**:
   ```bash
   cd gateway
   bun install
   bun audit
   ```
   Must return: `No vulnerabilities found`

2. **CI audit check**:
   The `verify` job runs `bun audit` and must pass (exit code 0)

3. **Tests and build**:
   All tests and builds must pass with updated dependencies

## Maintenance

### When to Update Overrides

Update override versions when:
- New vulnerabilities are disclosed in overridden packages
- Upstream packages (e.g., `@modelcontextprotocol/sdk`) update their dependencies
- Quarterly dependency review identifies outdated overrides

### Removing Overrides

An override can be removed when:
- The parent package updates to a safe version naturally
- The dependency is no longer used in the project

### Review Schedule

- **Monthly**: Review dependabot PRs and security advisories
- **Quarterly**: Full dependency audit and override cleanup
- **On-demand**: When new CVEs are disclosed

## Security Contacts

Report security vulnerabilities via:
- GitHub Private Vulnerability Reporting
- See [SECURITY.md](../SECURITY.md) for full disclosure policy

## Related Documentation

- [Dependencies and licenses](dependencies.md)
- [Development verification](../README.md#development-and-verification)
- [Security policy](../SECURITY.md)
