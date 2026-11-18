import { ImapFlow, type ListResponse } from "imapflow";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HostMailGateway } from "./gateway.js";
import { ImapSmtpProvider } from "./imap-smtp-provider.js";

function mailbox(path: string, ...flags: string[]): ListResponse {
  return {
    path, pathAsListed: path, name: path, delimiter: ".", parent: [], parentPath: "",
    flags: new Set(flags), listed: true, subscribed: false,
  };
}

function imapProvider(namespace: { prefix: string; delimiter: string | null }) {
  vi.spyOn(ImapFlow.prototype, "connect").mockImplementation(async function (this: ImapFlow) {
    Object.assign(this, { namespace });
  });
  vi.spyOn(ImapFlow.prototype, "logout").mockResolvedValue(undefined);
  const list = vi.spyOn(ImapFlow.prototype, "list");
  const create = vi.spyOn(ImapFlow.prototype, "mailboxCreate");
  const provider = new ImapSmtpProvider({
    grant: { grantId: "synthetic", label: "Synthetic", provider: "imap-smtp" },
    connections: { getConnection: async () => ({
      mailboxAddress: "test@example.invalid", username: "synthetic", password: "test-fixture",
      imap: { host: "localhost", port: 143, secure: false },
      smtp: { host: "localhost", port: 25, secure: false },
    }) },
  });
  return { provider, list, create };
}

afterEach(() => vi.restoreAllMocks());

describe("IMAP folder creation", () => {
  it("uses the personal namespace for create, existing folders, and a racing create", async () => {
    const { provider, list, create } = imapProvider({ prefix: "INBOX.", delimiter: "." });
    const path = "INBOX.Finance.Receipts";
    list.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValue([mailbox(path)]);
    create.mockResolvedValueOnce({ path, created: true }).mockRejectedValueOnce(new Error("generic CREATE error"));

    const gateway = new HostMailGateway({ providers: [provider], audit: () => undefined });
    const principal = { tokenId: "test", runId: "test", nodeId: "synthetic", expiresAt: "" };
    const input = { action: "create", grant_id: "synthetic", folder: "Finance/Receipts" };
    const results = await Promise.all([
      gateway.callTool(principal, "folders", input), gateway.callTool(principal, "folders", input),
    ]);
    expect(results).toEqual([ { ...input, folder: path }, { ...input, folder: path } ]);
    await expect(provider.ensureFolder("Finance/Receipts")).resolves.toBe(path);
    expect(create.mock.calls).toEqual([[path], [path]]);

    const lock = vi.spyOn(ImapFlow.prototype, "getMailboxLock").mockResolvedValue({ path, release: () => undefined });
    vi.spyOn(ImapFlow.prototype, "search").mockResolvedValue([]);
    await gateway.callTool(principal, "messages", {
      action: "search", grant_id: "synthetic", folder: results[0]?.folder,
    });
    expect(lock).toHaveBeenCalledWith(path, { readOnly: true });
  });

  it("matches the wire name when LIST strips a leading personal delimiter", async () => {
    const { provider, list, create } = imapProvider({ prefix: "/mail/", delimiter: "/" });
    const path = "/mail/Archive";
    list.mockResolvedValueOnce([]).mockResolvedValue([{
      ...mailbox("mail/Archive"), pathAsListed: path, delimiter: "/",
    }]);
    create.mockRejectedValue(new Error("generic CREATE error"));

    await expect(provider.ensureFolder("Archive")).resolves.toBe(path);
    await expect(provider.ensureFolder(path)).resolves.toBe(path);
    expect(create.mock.calls).toEqual([[path]]);
  });

  it("refuses a trailing native delimiter before CREATE", async () => {
    const { provider, list, create } = imapProvider({ prefix: "INBOX.", delimiter: "." });
    list.mockResolvedValue([]);
    create.mockResolvedValue({ path: "INBOX.Reports.", created: true });

    await expect(provider.ensureFolder("Reports.")).rejects.toThrow("trailing hierarchy delimiter");
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses nested paths on servers without a hierarchy delimiter", async () => {
    const { provider, list, create } = imapProvider({ prefix: "", delimiter: null });
    list.mockResolvedValue([]);
    create.mockResolvedValue({ path: "FinanceReceipts", created: true });

    await expect(provider.ensureFolder("Finance/Receipts")).rejects.toThrow("nested folders");
    expect(create).not.toHaveBeenCalled();
  });

  it("requires a selectable mailbox when CREATE says it already exists", async () => {
    const { provider, list, create } = imapProvider({ prefix: "INBOX.", delimiter: "." });
    const path = "INBOX.Archive.2021";
    list.mockResolvedValue([mailbox(path, "\\NonExistent")]);
    create.mockResolvedValue({ path, created: false });

    await expect(provider.ensureFolder("Archive/2021")).rejects.toThrow("selectable folder");
    expect(create).toHaveBeenCalledWith(path);
  });
});
