# Google provider setup

Each operator creates and controls a Google OAuth Desktop application. The
project supplies no shared client ID, secret, consent screen, or verification.

1. Create or select a Google Cloud project.
2. Configure the OAuth consent screen for your intended users.
3. Enable the Gmail API as required by Google Cloud policy.
4. Create a Desktop OAuth client.
5. Run `giggabit-agent-mail-service-admin add-google` in a visible local
   terminal.
6. Enter your client ID and enter the client secret only at the echo-disabled
   prompt. Complete consent and MFA in the browser.

The gateway starts a temporary loopback callback, uses PKCE, requests offline
access, and stores provider credentials only in the encrypted vault. It does
not accept the client secret or refresh token through command arguments or
environment variables.

Google consent-screen publication, test-user limits, verification, quotas,
account recovery, and service availability are operator and provider
responsibilities.
