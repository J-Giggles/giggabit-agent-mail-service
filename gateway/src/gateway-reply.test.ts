import { describe, expect, it, vi } from "vitest";

import { HostMailGateway } from "./gateway.js";
import type { MailboxProvider } from "./provider.js";

describe("Gateway reply-loop seam", () => {
  it("replies once to a human message and refuses automatic-response targets", async () => {
    const reply = vi.fn(async () => ({ messageId: "reply-message-1" }));
    const provider: MailboxProvider = {
      grant: { grantId: "mailbox-1", label: "Personal mailbox", provider: "fake" },
      listFolders: async () => [],
      search: async () => [],
      read: async ({ messageRef, folder }) => ({
        messageRef,
        folder,
        subject: messageRef === "human-1" ? "Question" : "Automatic reply",
        from: "sender@example.invalid",
        to: ["owner@example.invalid"],
        receivedAt: "2026-07-11T10:00:00.000Z",
        text: "Message body",
        attachments: [],
        autoSubmitted: messageRef === "automatic-1",
      }),
      reply,
    };
    const gateway = new HostMailGateway({ providers: [provider], audit: () => undefined });
    const principal = { tokenId: "token-1", runId: "run-1", nodeId: "node-1", expiresAt: "2026-07-11T18:00:00.000Z" };
    const replyInput = {
      action: "reply",
      grant_id: "mailbox-1",
      folder: "INBOX",
      message_ref: "human-1",
      idempotency_key: "reply-run-1-0001",
      body: "Thanks",
    };

    await expect(gateway.callTool(principal, "send", replyInput)).resolves.toMatchObject({
      action: "reply",
      message_id: "reply-message-1",
    });
    await expect(
      gateway.callTool(principal, "send", { ...replyInput, idempotency_key: "reply-run-1-0002" }),
    ).rejects.toThrow("already replied");
    await expect(
      gateway.callTool(principal, "send", {
        ...replyInput,
        message_ref: "automatic-1",
        idempotency_key: "reply-run-1-0003",
      }),
    ).rejects.toThrow("automatic response");
    expect(reply).toHaveBeenCalledTimes(1);
  });
});
