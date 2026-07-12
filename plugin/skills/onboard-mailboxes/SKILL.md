---
name: onboard-mailboxes
description: Connect, verify, reconnect, or revoke an operator-owned Microsoft, Google, or TLS IMAP/SMTP mailbox without exposing credentials or bypassing provider identity proof.
---

# Onboard Mailboxes

Guide one Mailbox Grant at a time through operator-owned provider setup and
secret-free verification.

## Safety boundary

- Never request, read, copy, log, or enter passwords, client secrets, recovery
  codes, MFA values, security keys, refresh tokens, or provider approvals.
- The operator creates and controls every Provider Registration. Do not supply
  a shared Microsoft or Google client identity.
- Keep password, MFA, consent, and account selection in the provider page or an
  echo-disabled local terminal prompt.
- Run only non-secret setup steps. Do not overlap interactive OAuth flows.
- Verify with folder metadata only; never print folder names, addresses,
  message content, attachments, or provider identifiers.

## Workflow

1. Ask the operator to run `./scripts/doctor.sh` and resolve failed security
   prerequisites.
2. Select the relevant guide under `docs/providers/` and confirm the operator
   has prepared their own registration or server settings.
3. Choose a stable non-secret grant ID and local label.
4. Start the matching admin command in a visible local terminal.
5. Enter non-secret fields only. Pause when a hidden prompt or provider page
   requests identity proof, password, MFA, consent, or account selection.
6. After the command succeeds, restart the service and run the admin
   verification command.
7. Report only provider type, grant ID, success/failure, and a redacted blocker
   category.
8. On a wrong-account or ambiguous grant, revoke it before retrying.

## Provider commands

- Microsoft: `giggabit-agent-mail-service-admin add-microsoft`
- Google: `giggabit-agent-mail-service-admin add-google`
- TLS IMAP/SMTP: `giggabit-agent-mail-service-admin add-password`
- Verification: `giggabit-agent-mail-service-admin verify`
- Revocation: `giggabit-agent-mail-service-admin revoke`

Provider tenancy, application approval, quotas, account recovery, and service
availability are not project responsibilities.
