import { ImapFlow, type ListResponse } from "imapflow";
import { afterEach, describe, expect, it, vi } from "vitest";

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

    await Promise.all([provider.ensureFolder("Finance/Receipts"), provider.ensureFolder("Finance/Receipts")]);
    await provider.ensureFolder("Finance/Receipts");
    expect(create.mock.calls).toEqual([[path], [path]]);
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
