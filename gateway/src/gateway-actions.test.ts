import { describe, expect, it, vi } from "vitest";

import { HostMailGateway } from "./gateway.js";
import type { MailboxProvider } from "./provider.js";

describe("Gateway mailbox write seam", () => {
  it("creates nested folders idempotently through the mailbox provider and audits each request", async () => {
    const folders = new Set<string>();
    const ensureFolder = vi.fn(async (folder: string) => {
      folders.add(folder);
      return folder;
    });
    const provider: MailboxProvider = {
      grant: { grantId: "mailbox-1", label: "Test mailbox", provider: "fake" },
      ensureFolder,
      listFolders: async () => Array.from(folders, (path) => ({ path, name: path })),
      search: async () => [],
      read: async () => { throw new Error("not used"); },
    };
    const audit = vi.fn();
    const gateway = new HostMailGateway({ providers: [provider], audit });
    const principal = { tokenId: "token-1", runId: "run-1", nodeId: "node-1", expiresAt: "2026-07-11T18:00:00.000Z" };
    const folder = "Finance/Receipts";
    const input = { action: "create", grant_id: "mailbox-1", folder };

    await expect(gateway.callTool(principal, "folders", input)).resolves.toEqual(input);
    await expect(gateway.callTool(principal, "folders", input)).resolves.toEqual(input);
    await expect(gateway.callTool(principal, "folders", { ...input, action: "list" })).resolves.toMatchObject({
      folders: [{ path: folder, name: folder }],
    });
    await expect(gateway.callTool(principal, "folders", { ...input, action: "delete" })).rejects.toThrow(
      "unsupported folders action",
    );
    expect(audit).toHaveBeenNthCalledWith(1, expect.objectContaining({
      grantId: "mailbox-1", action: "folders.create.requested", targetRef: folder,
    }));
    expect(audit).toHaveBeenNthCalledWith(2, expect.objectContaining({
      grantId: "mailbox-1", action: "folders.create", targetRef: folder,
    }));
    expect(audit).toHaveBeenNthCalledWith(4, expect.objectContaining({
      grantId: "mailbox-1", action: "folders.create", targetRef: folder,
    }));
    expect(ensureFolder).toHaveBeenCalledTimes(2);

    for (let year = 2021; year <= 2028; year += 1) {
      await gateway.callTool(principal, "folders", { ...input, folder: `Archive/${year}` });
    }
    await expect(gateway.callTool(principal, "folders", { ...input, folder: "Archive/2029" })).rejects.toThrow(
      "folder creation rate limit reached",
    );
    expect(ensureFolder).toHaveBeenCalledTimes(10);
  });

  it("requires an audit attempt before the provider can create a folder", async () => {
    const ensureFolder = vi.fn(async (folder: string) => folder);
    const provider: MailboxProvider = {
      grant: { grantId: "mailbox-1", label: "Test mailbox", provider: "fake" },
      ensureFolder,
      listFolders: async () => [],
      search: async () => [],
      read: async () => { throw new Error("not used"); },
    };
    const audit = vi.fn()
      .mockRejectedValueOnce(new Error("audit unavailable"))
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("audit unavailable"));
    const gateway = new HostMailGateway({ providers: [provider], audit });
    const principal = { tokenId: "token-1", runId: "run-1", nodeId: "node-1", expiresAt: "2026-07-11T18:00:00.000Z" };
    const input = { action: "create", grant_id: "mailbox-1", folder: "Finance/Receipts" };

    await expect(gateway.callTool(principal, "folders", input)).rejects.toThrow("audit unavailable");
    expect(ensureFolder).not.toHaveBeenCalled();
    await expect(gateway.callTool(principal, "folders", input)).rejects.toThrow("audit unavailable");
    expect(ensureFolder).toHaveBeenCalledOnce();
    expect(audit).toHaveBeenNthCalledWith(2, expect.objectContaining({ action: "folders.create.requested" }));
    expect(audit).toHaveBeenNthCalledWith(3, expect.objectContaining({ action: "folders.create" }));
  });

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
