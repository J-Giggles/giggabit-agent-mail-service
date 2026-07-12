import { describe, expect, it } from "vitest";

import { ImapSmtpProvider } from "./imap-smtp-provider.js";
import { ProviderVerificationHarness } from "./provider-verification.js";

const host = process.env.TEST_MAIL_HOST;
const imapPort = Number(process.env.TEST_MAIL_IMAP_PORT);
const smtpPort = Number(process.env.TEST_MAIL_SMTP_PORT);
const enabled = host && Number.isSafeInteger(imapPort) && Number.isSafeInteger(smtpPort);

describe.skipIf(!enabled)("IMAP/SMTP provider adapter seam", () => {
  it("verifies every mail capability with owned synthetic messages through real protocols", async () => {
    const provider = new ImapSmtpProvider({
      grant: { grantId: "synthetic-mailbox", label: "Synthetic mailbox", provider: "imap-smtp" },
      connections: {
        async getConnection() {
          return {
            mailboxAddress: "test1@localhost",
            username: "test1",
            password: "pwd1",
            imap: { host: host!, port: imapPort, secure: false },
            smtp: { host: host!, port: smtpPort, secure: false },
          };
        },
      },
    });

    await expect(
      new ProviderVerificationHarness({ provider, testRecipient: "test1@localhost", pollIntervalMs: 50 }).run(),
    ).resolves.toMatchObject({ drafted: 1, replied: 1, moved: 2, trashed: 3 });
  }, 15_000);
});
