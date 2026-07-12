import { describe, expect, it, vi } from "vitest";

import { MailCircuitBreaker } from "./circuit-breaker.js";
import { HostMailGateway } from "./gateway.js";
import type { MailboxProvider } from "./provider.js";

describe("Gateway outbound safety seam", () => {
  it("sends once per idempotency key and freezes unique sends above the configured limit", async () => {
    const send = vi.fn(async () => ({ messageId: "provider-message-1" }));
    const provider: MailboxProvider = {
      grant: { grantId: "mailbox-1", label: "Personal mailbox", provider: "fake" },
      listFolders: async () => [],
      search: async () => [],
      read: async () => {
        throw new Error("not used");
      },
      send,
    };
    const now = new Date("2026-07-11T10:00:00.000Z");
    const gateway = new HostMailGateway({
      providers: [provider],
      audit: () => undefined,
      circuitBreaker: new MailCircuitBreaker({
        now: () => now,
        limits: { perMinute: 1, perHour: 50, perDay: 200, maxRecipients: 25 },
      }),
    });
    const principal = { tokenId: "token-1", runId: "run-1", nodeId: "node-1", expiresAt: "2026-07-11T18:00:00.000Z" };
    const input = {
      action: "new",
      grant_id: "mailbox-1",
      idempotency_key: "send-run-1-0001",
      to: ["recipient@example.invalid"],
      subject: "Synthetic test",
      body: "Hello",
    };

    await expect(gateway.callTool(principal, "send", input)).resolves.toMatchObject({
      action: "new",
      success: true,
      message_id: "provider-message-1",
      deduplicated: false,
    });
    await expect(gateway.callTool(principal, "send", input)).resolves.toMatchObject({
      message_id: "provider-message-1",
      deduplicated: true,
    });
    expect(send).toHaveBeenCalledTimes(1);

    await expect(
      gateway.callTool(principal, "send", {
        ...input,
        idempotency_key: "send-run-1-0002",
        subject: "Another message",
      }),
    ).rejects.toThrow("circuit breaker");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("uses a provider-specific limit when it is lower than host policy", async () => {
    const provider: MailboxProvider = {
      grant: {
        grantId: "limited-mailbox",
        label: "Limited mailbox",
        provider: "fake",
        outboundLimits: { perMinute: 1 },
      },
      listFolders: async () => [],
      search: async () => [],
      read: async () => {
        throw new Error("not used");
      },
      send: async () => ({ messageId: "sent" }),
    };
    const gateway = new HostMailGateway({ providers: [provider], audit: () => undefined });
    const principal = { tokenId: "token-1", runId: "run-1", nodeId: "node-1", expiresAt: "2026-07-11T18:00:00.000Z" };
    const input = {
      action: "new",
      grant_id: "limited-mailbox",
      to: ["recipient@example.invalid"],
      subject: "Synthetic",
      body: "Synthetic",
    };

    await gateway.callTool(principal, "send", { ...input, idempotency_key: "provider-limit-0001" });
    await expect(
      gateway.callTool(principal, "send", { ...input, idempotency_key: "provider-limit-0002" }),
    ).rejects.toThrow("circuit breaker");
  });
});
