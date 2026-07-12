import { describe, expect, it, vi } from "vitest";

import { ProviderVerificationHarness } from "./provider-verification.js";
import type { MailboxProvider } from "./provider.js";

describe("provider-safe verification harness", () => {
  it("fails closed before moving a search result whose ownership tag is absent", async () => {
    const move = vi.fn();
    const provider: MailboxProvider = {
      grant: { grantId: "synthetic", label: "Synthetic", provider: "fake" },
      ensureFolder: async () => undefined,
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
