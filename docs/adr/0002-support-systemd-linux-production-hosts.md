# Support systemd Linux production hosts

Public v1 will support production installation on Arch and Debian-family Linux
hosts that provide systemd 250 or newer, Tailscale, ClamAV, and bubblewrap.
Credential encryption will bind to both TPM2 and the system installation when
TPM2 is available, and will use systemd's root-only host-bound encryption on
hosts without TPM2; installation must fail when neither protected mode is
available. Docker-capable platforms may run the synthetic development and
verification environment, but that environment must never connect to real
Mailbox Grants. This broadens adoption beyond the original Arch/TPM-only host
without weakening encryption or presenting the portable fixture as a
production deployment.
