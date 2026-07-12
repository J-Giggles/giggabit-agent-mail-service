# Troubleshooting

Start with `./scripts/doctor.sh`. It reports only prerequisite and service
status, never secret values, host addresses, or mailbox data.

## Installation refuses the host

- Confirm systemd is version 250 or newer.
- Confirm `/var/lib/systemd` is persistent.
- Authenticate Tailscale and confirm it has an IPv4 address.
- Install `pkexec`, or run the displayed privileged step in a local terminal.

## Provider onboarding fails

- Confirm you created your own Provider Registration.
- Re-check redirect type, delegated permissions, public-client setting, and
  tenant selector against the provider guide.
- Complete consent, MFA, or account recovery directly with the provider.
- For IMAP/SMTP, confirm TLS ports and whether the provider requires an app
  password. Never put the password in a command argument.

## Mail operation fails

- Run the admin verification command from a local terminal.
- Check whether the provider revoked consent or changed folder behavior.
- Check for an outbound circuit-breaker freeze before resetting it.
- Reproduce against the Synthetic Environment before filing an issue.

## Safe issue reports

Include versions, the failing command name, and a synthetic reproduction.
Exclude addresses, provider identifiers, message references, subjects, bodies,
attachments, tokens, hostnames, IPs, and raw logs. Use private vulnerability
reporting for security impact.
