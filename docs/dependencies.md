# Dependencies and licences

The gateway locks every JavaScript dependency in `gateway/bun.lock`. Direct
runtime foundations include the MIT-licensed MCP SDK, ImapFlow, mailparser,
and Zod, plus MIT-0-licensed Nodemailer. TypeScript is Apache-2.0. Development
and transitive dependencies use the allowlisted OSI-approved licences checked
by `scripts/check-licenses.mjs`.

Run:

```bash
./scripts/verify.sh
node ./scripts/check-licenses.mjs
cd gateway && bun audit
```

Installed packages retain their own package metadata and licence files. The
project does not relicense third-party dependencies. Dependabot uses its Bun
ecosystem so an update must include `gateway/bun.lock`; grouped updates are
reviewed through the frozen lockfile, vulnerability audit, licence check, and
CI.
