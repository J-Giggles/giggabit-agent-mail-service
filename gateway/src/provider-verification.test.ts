import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { MailCircuitBreaker, SqliteMailCircuitStateStore } from "./circuit-breaker.js";
import { HostMailGateway } from "./gateway.js";
import { ProviderVerificationHarness } from "./provider-verification.js";
import type { MailboxProvider } from "./provider.js";

function oauthProvider() {
  return {
    grant: { grantId: "synthetic", label: "Synthetic", provider: "google-oauth" },
    ensureFolder: vi.fn(async (folder: string) => folder),
    listFolders: async () => [],
    search: async () => [],
    read: async () => { throw new Error("unexpected read"); },
    send: vi.fn(async () => { throw new Error("unexpected send"); }),
  } satisfies MailboxProvider;
}

describe("provider-safe verification harness", () => {
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

      for (let index = 0; index < 8; index += 1) await create(`Archive/${index}`);
      provider.ensureFolder.mockClear();

      await expect(verify.run()).rejects.toThrow("folder creation rate limit reached");
      expect(provider.ensureFolder.mock.calls).toEqual([["Agent Gateway Test"], ["Drafts"]]);
      expect(provider.send).not.toHaveBeenCalled();
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
      listFolders: async () => [],
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
