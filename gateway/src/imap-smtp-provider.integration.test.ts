import { randomUUID } from "node:crypto";
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
          attributes: [[[{ value: namespace.prefix }, { value: namespace.delimiter }]], null, null],
        });
        return { next: () => undefined };
      },
    });
  });
}

afterEach(() => vi.restoreAllMocks());

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

    await expect(provider.ensureFolder("Namespace Probe")).rejects.toThrow("Unsupported IMAP personal namespace");
    supplyGreenMailNamespace();

    await expect(
      new ProviderVerificationHarness({ provider, testRecipient: "test1@localhost", pollIntervalMs: 50 }).run(),
    ).resolves.toMatchObject({ drafted: 1, replied: 1, moved: 2, trashed: 3 });

    const parent = `Synthetic-${randomUUID()}`;
    const path = `${parent}/Receipts`;
    await Promise.all([provider.ensureFolder(path), provider.ensureFolder(path)]);
    await provider.ensureFolder(path);
    const folders = await provider.listFolders();
    expect(folders.filter((folder) => folder.path.includes(parent) && folder.name === "Receipts")).toHaveLength(1);
  }, 15_000);
});
