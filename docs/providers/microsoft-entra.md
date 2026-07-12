# Microsoft Entra provider setup

Each operator creates and controls a public-client application registration.
The project supplies no shared client ID.

1. Create an Entra application registration for your own tenant requirements.
2. Enable public client flows and device-code authentication.
3. Add delegated Exchange Online permissions for IMAP access and SMTP send,
   plus offline access.
4. Grant consent according to your tenant policy.
5. Run `giggabit-agent-mail-service-admin add-microsoft` in a visible local
   terminal and enter your application ID when prompted.

Personal Microsoft accounts use the `consumers` tenant by default. For an
organization, pass its verified tenant domain or tenant ID:

```bash
giggabit-agent-mail-service-admin add-microsoft \
  --microsoft-tenant example.onmicrosoft.com
```

The device-code page owns password, MFA, conditional access, and consent. The
gateway stores only the resulting refresh token and connection metadata in its
encrypted vault. Revoke both the Mailbox Grant and the provider grant when
decommissioning access.

Microsoft may require tenant administration, publisher verification, or policy
changes. Those are operator and provider responsibilities.
