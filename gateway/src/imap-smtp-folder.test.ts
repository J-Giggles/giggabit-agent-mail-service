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

type Namespace = { prefix: string; delimiter: string | null };

function imapProvider(namespace: Namespace, personal: Namespace[] = [namespace]) {
  vi.spyOn(ImapFlow.prototype, "connect").mockImplementation(async function (this: ImapFlow) {
    this.capabilities.set("NAMESPACE", true);
    Object.assign(this, {
      namespace,
      async exec(command: string, _attributes: unknown, options: {
        untagged: Record<string, (reply: unknown) => Promise<void>>;
      }) {
        expect(command).toBe("NAMESPACE");
        await options.untagged.NAMESPACE?.({
          attributes: [personal.map(({ prefix, delimiter }) => [
            { value: prefix },
            delimiter === null ? null : { value: delimiter },
          ]), null, null],
        });
        return { next: () => undefined };
      },
    });
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

  it("creates nested folders under an empty prefix with the server's delimiter", async () => {
    const { provider, list, create } = imapProvider({ prefix: "", delimiter: ":" });
    const path = "Finance:Receipts";
    list.mockResolvedValue([]);
    create.mockResolvedValue({ path, created: true });

    await expect(provider.ensureFolder("Finance/Receipts")).resolves.toBe(path);
    expect(create).toHaveBeenCalledWith(path);
  });

  it("handles a literal LIST wire name from ImapFlow", async () => {
    const { provider, list, create } = imapProvider({ prefix: "INBOX.", delimiter: "." });
    const folder = mailbox("INBOX.Archive");
    const wireName = Buffer.from("INBOX.Archive", "utf8");
    const decode = vi.spyOn(wireName, "toString");
    Object.defineProperty(folder, "pathAsListed", { value: wireName });
    list.mockResolvedValue([folder]);

    await expect(provider.ensureFolder("Archive")).resolves.toBe("INBOX.Archive");
    expect(decode).toHaveBeenCalledExactlyOnceWith("utf8");
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses an unconfirmed case-only alias and accepts the exact listed path", async () => {
    const { provider, list, create } = imapProvider({ prefix: "INBOX.", delimiter: "." });
    const path = "INBOX.REPORTS";
    list.mockResolvedValue([mailbox(path)]);
    create.mockResolvedValue({ path: "INBOX.Reports", created: false });

    await expect(provider.ensureFolder("Reports")).rejects.toThrow("Use the exact path from folders.list");
    await expect(provider.ensureFolder(path)).resolves.toBe(path);
    expect(create.mock.calls).toEqual([["INBOX.Reports"]]);
  });

  it("refuses a trailing native delimiter before CREATE", async () => {
    const { provider, list, create } = imapProvider({ prefix: "INBOX.", delimiter: "." });
    list.mockResolvedValue([]);
    create.mockResolvedValue({ path: "INBOX.Reports.", created: true });

    await expect(provider.ensureFolder("Reports.")).rejects.toThrow("trailing hierarchy delimiter");
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    { label: "leading delimiter", namespace: { prefix: "/mail/", delimiter: "/" } },
    { label: "NIL delimiter", namespace: { prefix: "", delimiter: null } },
    {
      label: "missing trailing delimiter on the wire",
      namespace: { prefix: "INBOX.", delimiter: "." },
      personal: [{ prefix: "INBOX", delimiter: "." }],
    },
    { label: "doubled trailing delimiter", namespace: { prefix: "INBOX..", delimiter: "." } },
    { label: "multi-character delimiter", namespace: { prefix: "", delimiter: "::" } },
    { label: "no personal namespace", namespace: { prefix: "", delimiter: "/" }, personal: [] },
    {
      label: "multiple personal namespaces",
      namespace: { prefix: "", delimiter: "/" },
      personal: [{ prefix: "", delimiter: "/" }, { prefix: "Shared.", delimiter: "." }],
    },
  ])("refuses $label before CREATE", async ({ namespace, personal }) => {
    const { provider, list, create } = imapProvider(namespace, personal);
    await expect(provider.ensureFolder("mail/Archive")).rejects.toThrow("Unsupported IMAP personal namespace");
    expect(list).not.toHaveBeenCalled();
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
