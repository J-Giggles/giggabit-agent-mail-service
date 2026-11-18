import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImapFlow } from "imapflow";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MailCircuitBreaker, SqliteMailCircuitStateStore } from "./circuit-breaker.js";
import { HostMailGateway } from "./gateway.js";
import { ImapSmtpProvider } from "./imap-smtp-provider.js";
import { ProviderVerificationHarness } from "./provider-verification.js";
import type { MailFolder, MailboxProvider, SendMailInput } from "./provider.js";

const gmailFolders = [
  { path: "[Gmail]/Drafts", name: "Drafts", role: "drafts" },
  { path: "[Gmail]/Trash", name: "Trash", role: "trash" },
] satisfies MailFolder[];

function oauthProvider() {
  return {
    grant: { grantId: "synthetic", label: "Synthetic", provider: "google-oauth" },
    ensureFolder: vi.fn(async (folder: string) => folder),
    listFolders: async () => gmailFolders,
    search: async () => [],
    read: async () => { throw new Error("unexpected read"); },
    send: vi.fn(async () => { throw new Error("unexpected send"); }),
  } satisfies MailboxProvider;
}

afterEach(() => vi.restoreAllMocks());

describe("provider-safe verification harness", () => {
  it("verifies OAuth with Gmail special-use folders and only creates the test folder", async () => {
    const fixture = oauthProvider();
    const imapProvider = new ImapSmtpProvider({
      grant: fixture.grant,
      connections: { getConnection: async () => ({
        mailboxAddress: "test@example.invalid", username: "synthetic", password: "test-fixture",
        imap: { host: "127.0.0.1", port: 143, secure: false },
        smtp: { host: "127.0.0.1", port: 25, secure: false },
      }) },
    });
    vi.spyOn(ImapFlow.prototype, "connect").mockResolvedValue(undefined);
    vi.spyOn(ImapFlow.prototype, "logout").mockResolvedValue(undefined);
    const list = vi.spyOn(ImapFlow.prototype, "list").mockResolvedValue(gmailFolders.map(({ path, name, role }) => ({
      path, name, pathAsListed: path, delimiter: "/", parent: ["[Gmail]"], parentPath: "[Gmail]",
      flags: new Set([role === "drafts" ? "\\Drafts" : "\\Trash"]), listed: true, subscribed: false,
    })));

    let subject = "";
    const message = (folder: string, messageRef: string) => ({
      folder, messageRef, subject, from: "test@example.invalid", to: ["test@example.invalid"],
      receivedAt: "2026-07-11T10:00:00.000Z", snippet: "Synthetic", text: "Synthetic", attachments: [],
    });
    const provider = {
      ...fixture,
      listFolders: imapProvider.listFolders.bind(imapProvider),
      ensureFolder: vi.fn(async (folder: string) => {
        if (folder !== "Agent Gateway Test") throw new Error(`unexpected CREATE for ${folder}`);
        return folder;
      }),
      send: async (input: SendMailInput) => {
        subject = input.subject;
        return { messageId: "sent-1" };
      },
      search: async ({ folder }) => [message(folder, "message-1"), message(folder, "message-2")],
      read: async ({ folder, messageRef }) => message(folder, messageRef),
      createDraft: async () => ({ folder: "[Gmail]/Drafts", draftRef: "draft-1" }),
      reply: async () => ({ messageId: "reply-1" }),
      move: async ({ toFolder, messageRef }) => ({ folder: toFolder, messageRef }),
      trash: async ({ messageRef }) => ({ folder: "[Gmail]/Trash", messageRef }),
    } satisfies MailboxProvider;

    await expect(new ProviderVerificationHarness({
      provider, testRecipient: "test@example.invalid", pollAttempts: 1,
    }).run()).resolves.toMatchObject({ folderCreation: "verified", drafted: 1, moved: 2, trashed: 3 });
    expect(list).toHaveBeenCalledExactlyOnceWith({ listOnly: true });
    expect(provider.ensureFolder).toHaveBeenCalledExactlyOnceWith("Agent Gateway Test");
  });

  it("names the missing selectable Drafts role before OAuth verification writes anything", async () => {
    const provider = {
      ...oauthProvider(),
      listFolders: async (): Promise<MailFolder[]> => [
        { path: "Drafts", name: "Drafts" },
        { path: "[Gmail]/Trash", name: "Trash", role: "trash" },
      ],
    };
    await expect(new ProviderVerificationHarness({
      provider, testRecipient: "test@example.invalid", pollAttempts: 1,
    }).run()).rejects.toThrow("Set up a selectable Drafts folder with its IMAP special-use role");
    expect(provider.ensureFolder).not.toHaveBeenCalled();
    expect(provider.send).not.toHaveBeenCalled();
  });

  it("stops OAuth verification before the provider creates a folder when audit fails", async () => {
    const provider = oauthProvider();
    const verify = new ProviderVerificationHarness({
      provider,
      testRecipient: "test@example.invalid",
      audit: () => { throw new Error("audit unavailable"); },
    });

    await expect(verify.run()).rejects.toThrow("audit unavailable");
    expect(provider.ensureFolder).not.toHaveBeenCalled();
    expect(provider.send).not.toHaveBeenCalled();
  });

  it("charges OAuth verification against the service's persistent folder quota", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mail-verify-quota-"));
    const state = join(directory, "outbound-state.sqlite");
    const clock = () => ({ bootId: "test-boot", elapsedMs: 5_000 });
    const serviceStore = new SqliteMailCircuitStateStore(state, clock);
    const adminStore = new SqliteMailCircuitStateStore(state, clock);
    try {
      const provider = oauthProvider();
      const service = new HostMailGateway({
        providers: [provider],
        audit: () => undefined,
        circuitBreaker: new MailCircuitBreaker({ stateStore: serviceStore }),
      });
      const verify = new ProviderVerificationHarness({
        provider,
        testRecipient: "test@example.invalid",
        circuitBreaker: new MailCircuitBreaker({ stateStore: adminStore }),
      });
      const principal = { tokenId: "agent", runId: "run", nodeId: "node", expiresAt: "2026-11-19T00:00:00.000Z" };
      const create = (folder: string) => service.callTool(principal, "folders", {
        action: "create", grant_id: provider.grant.grantId, folder,
      });

      for (let index = 0; index < 9; index += 1) await create(`Archive/${index}`);
      provider.ensureFolder.mockClear();

      await expect(verify.run()).rejects.toThrow("unexpected send");
      await expect(verify.run()).rejects.toThrow("folder creation rate limit reached");
      expect(provider.ensureFolder).toHaveBeenCalledExactlyOnceWith("Agent Gateway Test");
      expect(provider.send).toHaveBeenCalledTimes(1);
      await expect(create("Archive/overflow")).rejects.toThrow("folder creation rate limit reached");
    } finally {
      adminStore.close();
      serviceStore.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed before moving a search result whose ownership tag is absent", async () => {
    const move = vi.fn();
    const provider: MailboxProvider = {
      grant: { grantId: "synthetic", label: "Synthetic", provider: "fake" },
      ensureFolder: async (folder) => folder,
      listFolders: async () => gmailFolders,
      search: async () => [
        {
          messageRef: "message-1",
          folder: "INBOX",
          subject: "Unrelated message",
          from: "sender@example.invalid",
          to: ["test@example.invalid"],
          receivedAt: "2026-07-11T10:00:00.000Z",
          snippet: "Unrelated",
        },
      ],
      read: async () => ({
        messageRef: "message-1",
        folder: "INBOX",
        subject: "Unrelated message",
        from: "sender@example.invalid",
        to: ["test@example.invalid"],
        receivedAt: "2026-07-11T10:00:00.000Z",
        text: "Unrelated",
        attachments: [],
      }),
      send: async () => ({ messageId: "sent-1" }),
      reply: async () => ({ messageId: "reply-1" }),
      createDraft: async () => ({ folder: "Drafts", draftRef: "draft-1" }),
      move,
      trash: async () => ({ folder: "Trash", messageRef: "trash-1" }),
    };

    await expect(
      new ProviderVerificationHarness({ provider, testRecipient: "test@example.invalid", pollAttempts: 1 }).run(),
    ).rejects.toThrow("did not arrive");
    expect(move).not.toHaveBeenCalled();
  });
});
