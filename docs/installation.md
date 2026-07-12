# Installation

## Supported Production Hosts

- Arch or a Debian-family Linux distribution;
- systemd 250 or newer on persistent storage;
- Tailscale connected and authenticated;
- Bun 1.3+, a root-owned Node.js 24.18+ installation, jq, OpenSSL, ClamAV,
  bubblewrap, and `file`; and
- an interactive local terminal with `pkexec` or root access.

The installer detects the package family, validates prerequisites, and prints
its plan before requesting privilege.

```bash
git clone https://github.com/J-Giggles/giggabit-agent-mail-service.git
cd giggabit-agent-mail-service
./scripts/install.sh --dry-run
./scripts/install.sh
./scripts/doctor.sh
```

Installation builds as the invoking user, installs root-owned code under
`/opt/giggabit-agent-mail-service`, creates protected state and runtime
directories, encrypts a generated vault key with systemd credentials, and
binds the service to the host's Tailscale IPv4 address.

If TPM2 is available, systemd binds the credential to both TPM2 and the host.
Without TPM2 it uses the root-only host key on persistent storage. Installation
fails if systemd cannot provide a protected key mode.

## Provider setup

Create and control your own Provider Registration or connection, then use the
visible local admin command:

```bash
giggabit-agent-mail-service-admin add-microsoft
giggabit-agent-mail-service-admin add-google
giggabit-agent-mail-service-admin add-password
giggabit-agent-mail-service-admin verify
```

Follow the relevant guide under [`docs/providers/`](providers/). Password and
app-password input is echo-disabled. OAuth consent and MFA remain in the
provider page. Never paste those values into chat, issues, logs, or config.

## Validate

```bash
./scripts/doctor.sh
systemctl --no-pager --full status giggabit-agent-mail-service.service
```

Do not continue if `doctor` reports a failed security prerequisite.
