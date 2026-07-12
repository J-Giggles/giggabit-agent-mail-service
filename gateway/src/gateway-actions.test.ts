import { describe, expect, it, vi } from "vitest";

import { HostMailGateway } from "./gateway.js";
import type { MailboxProvider } from "./provider.js";

describe("Gateway mailbox write seam", () => {
  it("creates drafts, moves messages, and exposes recoverable trash without permanent deletion", async () => {
    const createDraft = vi.fn(async () => ({ draftRef: "Drafts:1:7", folder: "Drafts" }));
    const move = vi.fn(async () => ({ messageRef: "Archive:1:9", folder: "Archive" }));
    const trash = vi.fn(async () => ({ messageRef: "Trash:1:10", folder: "Trash" }));
    const provider: MailboxProvider = {
      grant: { grantId: "mailbox-1", label: "Personal mailbox", provider: "fake" },
      listFolders: async () => [],
      search: async () => [],
      read: async () => {
        throw new Error("not used");
      },
      createDraft,
      move,
      trash,
    };
    const gateway = new HostMailGateway({ providers: [provider], audit: () => undefined });
    const principal = { tokenId: "token-1", runId: "run-1", nodeId: "node-1", expiresAt: "2026-07-11T18:00:00.000Z" };

    await expect(
      gateway.callTool(principal, "send", {
        action: "draft",
        grant_id: "mailbox-1",
        to: ["recipient@example.invalid"],
        subject: "Draft subject",
        body: "Draft body",
      }),
    ).resolves.toMatchObject({ action: "draft", draft_ref: "Drafts:1:7", folder: "Drafts" });
    await expect(
      gateway.callTool(principal, "messages", {
        action: "move",
        grant_id: "mailbox-1",
        folder: "INBOX",
        message_ref: "INBOX:1:8",
        destination: "Archive",
      }),
    ).resolves.toMatchObject({ action: "move", message_ref: "Archive:1:9", folder: "Archive" });
    await expect(
      gateway.callTool(principal, "messages", {
        action: "trash",
        grant_id: "mailbox-1",
        folder: "INBOX",
        message_ref: "INBOX:1:8",
      }),
    ).resolves.toMatchObject({ action: "trash", message_ref: "Trash:1:10", folder: "Trash" });
    await expect(
      gateway.callTool(principal, "messages", {
        action: "delete",
        grant_id: "mailbox-1",
        message_ref: "Trash:1:10",
      }),
    ).rejects.toThrow("unsupported messages action");
    expect(createDraft).toHaveBeenCalledTimes(1);
    expect(move).toHaveBeenCalledTimes(1);
    expect(trash).toHaveBeenCalledTimes(1);
  });
});
