import { ImapFlow } from "imapflow";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ImapSmtpProvider } from "./imap-smtp-provider.js";
import { ProviderVerificationHarness } from "./provider-verification.js";

const host = process.env.TEST_MAIL_HOST;
const imapPort = Number(process.env.TEST_MAIL_IMAP_PORT);
const smtpPort = Number(process.env.TEST_MAIL_SMTP_PORT);
const enabled = host && Number.isSafeInteger(imapPort) && Number.isSafeInteger(smtpPort);

// GreenMail lacks NAMESPACE. Supply its root namespace at that command boundary and send other commands over IMAP.
function supplyGreenMailNamespace() {
  const connect = ImapFlow.prototype.connect;
  vi.spyOn(ImapFlow.prototype, "connect").mockImplementation(async function (this: ImapFlow) {
    await connect.call(this);
    const namespace = "namespace" in this ? this.namespace : undefined;
    const exec = "exec" in this ? this.exec : undefined;
    if (!namespace || typeof namespace !== "object" || !("prefix" in namespace) ||
      !("delimiter" in namespace) || typeof exec !== "function") {
      throw new Error("GreenMail did not expose its root namespace");
    }
    this.capabilities.set("NAMESPACE", true);
    Object.assign(this, {
      exec: async (command: string, attributes: unknown, options?: {
        untagged?: { NAMESPACE?: (reply: unknown) => Promise<void> };
      }) => {
        if (command !== "NAMESPACE") return exec.call(this, command, attributes, options);
        await options?.untagged?.NAMESPACE?.({
          attributes: [[[
            { type: "STRING", value: namespace.prefix },
            { type: "STRING", value: namespace.delimiter },
          ]], null, null],
        });
        return { next: () => undefined };
      },
    });
  });
}

afterEach(() => vi.restoreAllMocks());

describe.skipIf(!enabled)("IMAP/SMTP provider adapter seam", () => {
  const connection = {
    mailboxAddress: "test1@localhost",
    username: "test1",
    password: "pwd1",
    imap: { host: host!, port: imapPort, secure: false },
    smtp: { host: host!, port: smtpPort, secure: false },
  };

  it("refuses off-pin GreenMail folder creation", async () => {
    const provider = new ImapSmtpProvider({
      grant: { grantId: "synthetic-mailbox", label: "Synthetic mailbox", provider: "google-oauth" },
      connections: { getConnection: async () => connection },
    });

    await expect(provider.ensureFolder("Namespace Probe")).rejects.toThrow("Unsupported IMAP personal namespace");
    supplyGreenMailNamespace();
    await expect(provider.ensureFolder("Namespace Probe")).rejects.toThrow("Unsupported IMAP personal namespace");
  });

  it("verifies a password grant in provisioned folders without creating any", async () => {
    const client = new ImapFlow({
      ...connection.imap,
      doSTARTTLS: false,
      auth: { user: connection.username, pass: connection.password },
      logger: false,
    });
    await client.connect();
    try {
      for (const folder of ["Agent Gateway Test", "Drafts", "Trash"]) {
        await client.mailboxCreate(folder);
      }
    } finally {
      await client.logout();
    }

    const provider = new ImapSmtpProvider({
      grant: { grantId: "synthetic-password", label: "Synthetic password mailbox", provider: "imap-smtp" },
      connections: { getConnection: async () => connection },
    });
    const create = vi.spyOn(ImapFlow.prototype, "mailboxCreate");
    await expect(
      new ProviderVerificationHarness({ provider, testRecipient: "test1@localhost", pollIntervalMs: 50 }).run(),
    ).resolves.toMatchObject({
      folderCreation: "unsupported (unpinned namespace)", drafted: 1, replied: 1, moved: 2, trashed: 3,
    });
    expect(create).not.toHaveBeenCalled();
  }, 15_000);
});
