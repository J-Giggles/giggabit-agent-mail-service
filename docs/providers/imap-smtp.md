# TLS IMAP/SMTP provider setup

Use this path for providers that expose standards-compatible TLS IMAP and
SMTP. Obtain the server names, ports, username, and app-password requirements
from your provider.

```bash
giggabit-agent-mail-service-admin add-password \
  --mailbox-address owner@example.com \
  --grant-id primary-mail \
  --label "Primary mail" \
  --username owner@example.com \
  --imap-host mail.example.com --imap-port 993 --imap-secure yes \
  --smtp-host mail.example.com --smtp-port 465 --smtp-secure yes
```

The password or app password is requested afterward through an echo-disabled
prompt. There is intentionally no password flag or password environment
variable.

Prefer implicit TLS where the provider supports it. For submission on port
587, use the provider's STARTTLS requirements. Do not disable certificate
verification or use plaintext IMAP/SMTP. After onboarding, run the admin
verification command and restart the service.

Provider-specific passwords, app-password policy, quotas, and account recovery
remain the operator's responsibility.
