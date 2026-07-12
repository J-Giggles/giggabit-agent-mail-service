# Operations

## Health and diagnostics

Run `./scripts/doctor.sh` for a human summary or
`./scripts/doctor.sh --json` for a local value-suppressed Diagnostic Report.
The report is never uploaded.

## Upgrade

Review `CHANGELOG.md` and migration notes, check out the desired signed tag,
then run:

```bash
./scripts/upgrade.sh --dry-run
./scripts/upgrade.sh
./scripts/doctor.sh
```

Upgrade reuses the idempotent installer and preserves protected state.

## Revocation and recovery

Use `giggabit-agent-mail-service-admin revoke` to remove a Mailbox Grant and
invoke provider revocation when supported. Revoke the Provider Registration in
Microsoft or Google when local revocation cannot be confirmed. Reset an
outbound freeze only after investigating its cause.

## Backup

Do not export plaintext credentials. Back up the encrypted state only as part
of an operator-controlled, access-restricted system backup that also accounts
for the systemd credential binding. A backup that cannot restore its key is
intentionally unreadable.

## Uninstall

```bash
./scripts/uninstall.sh --dry-run
./scripts/uninstall.sh
```

The default preserves encrypted state. Permanent purge requires the explicit
`--purge-state --confirm-purge` pair and cannot be undone. Revoke provider
access separately.

## Retention

Audit and encrypted provider state remain local until the operator removes
them. Per-run attachments are removed at run end with a 24-hour fallback.
Fetched bodies and access tokens are not durable.
