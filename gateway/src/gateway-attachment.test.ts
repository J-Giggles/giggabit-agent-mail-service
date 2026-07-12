import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { HostMailGateway } from "./gateway.js";
import type { MailboxProvider } from "./provider.js";
import { AttachmentQuarantine } from "./quarantine.js";

describe("Gateway attachment seam", () => {
  it("returns only a scanned per-run attachment handle", async () => {
    const root = await mkdtemp(join(tmpdir(), "giggabit-agent-mail-service-attachment-"));
    const inspect = vi.fn(async () => ({ contentType: "application/pdf", text: "Sandboxed synthetic text" }));
    const downloadAttachment = vi.fn(async () => ({
      filename: "invoice.pdf",
      contentType: "application/pdf",
      content: Buffer.from("synthetic pdf"),
    }));
    const provider: MailboxProvider = {
      grant: { grantId: "mailbox-1", label: "Personal mailbox", provider: "fake" },
      listFolders: async () => [],
      search: async () => [],
      read: async () => {
        throw new Error("not used");
      },
      downloadAttachment,
    };
    const gateway = new HostMailGateway({
      providers: [provider],
      audit: () => undefined,
      quarantine: new AttachmentQuarantine({
        root,
        scanner: { scan: async () => ({ clean: true }) },
      }),
      attachmentInspector: { inspect },
    });
    const principal = { tokenId: "token-1", runId: "run-1", nodeId: "node-1", expiresAt: "2026-07-11T18:00:00.000Z" };

    const result = await gateway.callTool(principal, "attachments", {
      action: "download",
      grant_id: "mailbox-1",
      folder: "INBOX",
      message_ref: "INBOX:1:42",
      attachment_ref: "attachment-1",
    });
    expect(result).toMatchObject({
      action: "download",
      attachment: {
        attachment_ref: "attachment-1",
        filename: "invoice.pdf",
        sandbox_required: true,
      },
    });
    expect(JSON.stringify(result)).not.toContain(root);
    expect(JSON.stringify(result)).not.toContain("synthetic pdf");
    expect(downloadAttachment).toHaveBeenCalledWith({
      folder: "INBOX",
      messageRef: "INBOX:1:42",
      attachmentRef: "attachment-1",
    });
    await expect(
      gateway.callTool(principal, "attachments", {
        action: "inspect",
        grant_id: "mailbox-1",
        attachment_ref: "attachment-1",
      }),
    ).resolves.toMatchObject({
      action: "inspect",
      trust: "untrusted_email_content",
      inspection: { content_type: "application/pdf", text: "Sandboxed synthetic text" },
    });
    expect(inspect).toHaveBeenCalledWith(expect.stringContaining("/run-1/"));
    await rm(root, { recursive: true, force: true });
  });
});
