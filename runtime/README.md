# Protected runtime state

This directory is documentation-only. Runtime state is deliberately separate
from source control.

The installed service uses system-managed locations such as:

- `/opt/giggabit-agent-mail-service` for the root-owned installed program;
- `/var/lib/giggabit-agent-mail-service` for encrypted vault and service state;
- `/run/credentials/giggabit-agent-mail-service.service` for ephemeral systemd
  credentials; and
- `/run/giggabit-agent-mail-service` for private sockets and transient files.

The encrypted credential source is named
`/etc/credstore.encrypted/giggabit-agent-mail-service-vault-master`. Its
decrypted value is exposed only inside the service credential directory.
systemd binds it to TPM2 plus the host when TPM2 is available, or to the
root-only host key otherwise. It must never be inspected or copied.

Do not copy those locations into this repository. Do not inspect or export the
vault, OAuth tokens, passwords, audit databases, messages, attachments,
sessions, logs, or credential material during normal development or migration.
