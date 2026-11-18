import { ImapFlow, type ListResponse } from "imapflow";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HostMailGateway } from "./gateway.js";
import { ImapSmtpProvider } from "./imap-smtp-provider.js";
import { FolderCreateRefusal } from "./provider.js";

function mailbox(path: string, ...flags: string[]): ListResponse {
  return {
    path, pathAsListed: path, name: path, delimiter: ".", parent: [], parentPath: "",
    flags: new Set(flags), listed: true, subscribed: false,
  };
}

type Namespace = { prefix: string; delimiter: string | null };
type WireNamespace = { prefix: string | Buffer; delimiter: string | null };
const supported = { prefix: "", delimiter: "/" };
const tokenValue = (token: unknown) =>
  token && typeof token === "object" && "value" in token ? token.value : token;

function wireNamespace(entries: WireNamespace[], delimiterType: "STRING" | "ATOM" = "STRING") {
  return entries.map(({ prefix, delimiter }) => [
    { type: Buffer.isBuffer(prefix) ? "LITERAL" : "STRING", value: prefix },
    delimiter === null ? null : { type: delimiterType, value: delimiter },
  ]);
}

function imapProvider(
  namespace: Namespace,
  personal: WireNamespace[] = [namespace],
  extensions: {
    mode?: "namespace" | "rev2" | "rev1";
    other?: WireNamespace[];
    shared?: WireNamespace[];
    listReference?: string;
    listPattern?: string;
    delimiterType?: "STRING" | "ATOM";
    provider?: string;
  } = {},
) {
  const list = vi.fn<() => Promise<ListResponse[]>>();
  const mergedList = vi.spyOn(ImapFlow.prototype, "list").mockImplementation(() => list());
  vi.spyOn(ImapFlow.prototype, "connect").mockImplementation(async function (this: ImapFlow) {
    if (extensions.mode === "rev2") this.capabilities.set("IMAP4rev2", true);
    else {
      this.capabilities.set("IMAP4rev1", true);
      if (extensions.mode !== "rev1") this.capabilities.set("NAMESPACE", true);
    }
    Object.assign(this, {
      namespace,
      async exec(command: string, attributes: unknown, options: {
        untagged: Record<string, (reply: unknown) => Promise<void>>;
      }) {
        if (command === "LIST") {
          const [reference, pattern] = Array.isArray(attributes) ? attributes.map(tokenValue) : [];
          if ((extensions.listReference !== undefined && reference !== extensions.listReference) ||
            (extensions.listPattern !== undefined && pattern !== extensions.listPattern)) {
            return { next: () => undefined };
          }
          for (const item of await list()) {
            if (!item.listed) continue;
            await options.untagged.LIST?.({
              attributes: [[...item.flags].map((value) => ({ value })), { value: item.delimiter }, { value: item.pathAsListed }],
            });
          }
        } else {
          expect(command).toBe("NAMESPACE");
          await options.untagged.NAMESPACE?.({
            attributes: [
              wireNamespace(personal, extensions.delimiterType),
              extensions.other ? wireNamespace(extensions.other) : null,
              extensions.shared ? wireNamespace(extensions.shared) : null,
            ],
          });
        }
        return { next: () => undefined };
      },
    });
  });
  vi.spyOn(ImapFlow.prototype, "logout").mockResolvedValue(undefined);
  const create = vi.spyOn(ImapFlow.prototype, "mailboxCreate");
  const provider = new ImapSmtpProvider({
    grant: { grantId: "synthetic", label: "Synthetic", provider: extensions.provider ?? "google-oauth" },
    connections: { getConnection: async () => ({
      mailboxAddress: "test@example.invalid", username: "synthetic", password: "test-fixture",
      imap: { host: "localhost", port: 143, secure: false },
      smtp: { host: "localhost", port: 25, secure: false },
    }) },
  });
  return { provider, list, mergedList, create };
}

afterEach(() => vi.restoreAllMocks());

describe("IMAP folder creation", () => {
  it("uses the personal namespace for create, existing folders, and a racing create", async () => {
    const { provider, list, create } = imapProvider(supported);
    const path = "Finance/Receipts";
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

  it.each(["google-oauth", "microsoft-oauth"])("accepts the pinned root slash namespace for %s", async (kind) => {
    const { provider, list, create } = imapProvider(supported, [supported], { provider: kind, listReference: "" });
    const path = "Finance/Receipts";
    list.mockResolvedValueOnce([]).mockResolvedValue([mailbox(path)]);
    create.mockResolvedValue({ path, created: true });

    await expect(provider.ensureFolder("Finance/Receipts")).resolves.toBe(path);
    await expect(provider.ensureFolder("Finance/Receipts")).resolves.toBe(path);
    expect(create).toHaveBeenCalledExactlyOnceWith(path);
  });

  it("refuses a provider whose live shape was unverified even if the synthetic namespace matches", async () => {
    const { provider, list, create } = imapProvider(supported, [supported], { provider: "imap-smtp" });
    await expect(provider.ensureFolder("Archive")).rejects.toThrow("Unsupported IMAP personal namespace");
    expect(ImapFlow.prototype.connect).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("handles a literal LIST wire name from ImapFlow", async () => {
    const { provider, list, create } = imapProvider(supported);
    const folder = mailbox("Archive");
    const wireName = Buffer.from("Archive", "utf8");
    const decode = vi.spyOn(wireName, "toString");
    Object.defineProperty(folder, "pathAsListed", { value: wireName });
    list.mockResolvedValue([folder]);

    await expect(provider.ensureFolder("Archive")).resolves.toBe("Archive");
    expect(decode).toHaveBeenCalledExactlyOnceWith("utf8");
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses an unconfirmed case-only alias and accepts the exact listed path", async () => {
    const { provider, list, create } = imapProvider(supported);
    const path = "REPORTS";
    list.mockResolvedValue([mailbox(path)]);
    create.mockResolvedValue({ path: "Reports", created: false });

    await expect(provider.ensureFolder("Reports")).rejects.toThrow("Use the exact path from folders.list");
    await expect(provider.ensureFolder("REPORTS")).resolves.toBe(path);
    expect(create.mock.calls).toEqual([["Reports"]]);
  });

  it("refuses a dot namespace before a literal slash can be translated", async () => {
    const { provider, list, create } = imapProvider({ prefix: "", delimiter: "." });
    list.mockResolvedValue([mailbox("A/B")]);
    create.mockResolvedValue({ path: "A.B", created: true });

    await expect(provider.ensureFolder("A/B")).rejects.toThrow("Unsupported IMAP personal namespace");
    expect(list).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("does not accept a different raw LIST name that ImapFlow stripped", async () => {
    const { provider, list, create } = imapProvider({ prefix: "", delimiter: "/" });
    list.mockResolvedValue([{ ...mailbox("Archive"), pathAsListed: "/Archive" }]);
    create.mockResolvedValue({ path: "Archive", created: true });

    await expect(provider.ensureFolder("Archive")).resolves.toBe("Archive");
    expect(create).toHaveBeenCalledWith("Archive");
  });

  it("refuses encoded, ampersand and non-ASCII namespace prefixes", async () => {
    for (const prefix of ["R&-D.", "R&D.", "Café."]) {
      const { provider, create } = imapProvider({ prefix, delimiter: "." });
      create.mockResolvedValue({ path: prefix + "Archive", created: true });
      await expect(provider.ensureFolder("Archive")).rejects.toThrow("Unsupported IMAP personal namespace");
      expect(create).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    }
  });

  it("uses a supported literal prefix that ImapFlow omitted from its active namespace", async () => {
    const { provider, list, create } = imapProvider(
      { prefix: "", delimiter: "." },
      [{ prefix: Buffer.from(""), delimiter: "/" }],
    );
    list.mockResolvedValue([]);
    create.mockResolvedValue({ path: "Archive", created: true });

    await expect(provider.ensureFolder("Archive")).resolves.toBe("Archive");
    expect(create).toHaveBeenCalledWith("Archive");
  });

  it("requires NAMESPACE and does not fall back to a root LIST", async () => {
    const { provider, list, create } = imapProvider({ prefix: "", delimiter: "/" }, [], { mode: "rev1" });
    await expect(provider.ensureFolder("Archive")).rejects.toThrow("Unsupported IMAP personal namespace");
    expect(list).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses non-ASCII, unsafe segments and constructed INBOX aliases", async () => {
    const { provider, list, create } = imapProvider(supported);
    list.mockResolvedValue([]);
    create.mockResolvedValue({ path: "INBOX", created: true });

    for (const name of ["ınbox", "R&D", "A/..", "A/.", "A/Name ", "A/Name\r", "a".repeat(64)]) {
      await expect(provider.ensureFolder(name)).rejects.toBeInstanceOf(FolderCreateRefusal);
    }
    expect(create).not.toHaveBeenCalled();
    list.mockResolvedValue([mailbox("INBOX")]);
    await expect(provider.ensureFolder("inbox")).resolves.toBe("INBOX");
  });

  it("relists after an uncoded CREATE failure and returns a safe recovery message", async () => {
    const { provider, list, create } = imapProvider(supported);
    list.mockResolvedValueOnce([]).mockResolvedValueOnce([mailbox("REPORTS")])
      .mockResolvedValueOnce([]).mockResolvedValueOnce([mailbox("Receipts")])
      .mockResolvedValue([]);
    create.mockRejectedValue(new Error("Uncoded server failure with private diagnostics"));

    await expect(provider.ensureFolder("Reports")).rejects.toThrow("Use the exact path from folders.list");
    await expect(provider.ensureFolder("Receipts")).resolves.toBe("Receipts");
    await expect(provider.ensureFolder("Missing")).rejects.toThrow("The server did not confirm folder creation.");
    expect(list).toHaveBeenCalledTimes(6);
  });

  it("refuses the unpinned dot-delimited namespace before any LIST or CREATE", async () => {
    const { provider, list, create } = imapProvider({ prefix: "INBOX.", delimiter: "." });
    list.mockResolvedValue([]);
    create.mockResolvedValue({ path: "INBOX.Reports.", created: true });

    for (const path of ["Reports.", "Finance.Receipts", "INBOX.A/B"]) {
      await expect(provider.ensureFolder(path)).rejects.toThrow("Unsupported IMAP personal namespace");
    }
    expect(list).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("keeps a dot literal inside a segment on a slash-delimited server", async () => {
    const { provider, list, create } = imapProvider({ prefix: "", delimiter: "/" });
    const path = "Finance.Receipts";
    list.mockResolvedValue([]);
    create.mockResolvedValue({ path, created: true });

    await expect(provider.ensureFolder(path)).resolves.toBe(path);
    expect(create).toHaveBeenCalledExactlyOnceWith(path);
  });

  it("refuses paths under shared and other-users namespace prefixes before LIST or CREATE", async () => {
    const personal = { prefix: "", delimiter: "/" };
    const { provider, list, create } = imapProvider(personal, [personal], {
      shared: [{ prefix: "Public Folders/", delimiter: "/" }],
      other: [{ prefix: "Other Users/", delimiter: "/" }],
    });
    list.mockResolvedValue([]);
    create.mockResolvedValue({ path: "Public Folders/Archive", created: true });

    for (const path of ["Public Folders/Archive", "Other Users/Archive"]) {
      await expect(provider.ensureFolder(path)).rejects.toThrow("Unsupported IMAP personal namespace");
    }
    expect(list).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("confirms and retries a mailbox hidden from wildcard LIST", async () => {
    const path = "Archive";
    const { provider, list, create } = imapProvider(supported, [supported], { listReference: "", listPattern: path });
    list.mockResolvedValueOnce([]).mockResolvedValue([mailbox(path)]);
    create.mockRejectedValue(new Error("uncoded CREATE failure"));

    await expect(provider.ensureFolder("Archive")).resolves.toBe(path);
    await expect(provider.ensureFolder("Archive")).resolves.toBe(path);
    expect(list).toHaveBeenCalledTimes(3);
    expect(create).toHaveBeenCalledExactlyOnceWith(path);
  });

  it.each([
    { label: "absent group expressed as an empty list", shared: [] },
    { label: "an unquoted delimiter", delimiterType: "ATOM" },
  ] satisfies { label: string; shared?: WireNamespace[]; delimiterType?: "ATOM" }[])(
    "refuses $label before LIST or CREATE", async ({ shared, delimiterType }) => {
      const { provider, list, create } = imapProvider(supported, [supported], {
        ...(shared ? { shared } : {}),
        ...(delimiterType ? { delimiterType } : {}),
      });
      list.mockResolvedValue([]);
      create.mockResolvedValue({ path: "Archive", created: true });

      await expect(provider.ensureFolder("Archive")).rejects.toThrow("Unsupported IMAP personal namespace");
      expect(list).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    },
  );

  it("refuses an unpinned personal prefix even when only scoped LIST would show it", async () => {
    const personal = { prefix: "#personal/", delimiter: "/" };
    const { provider, list, create } = imapProvider(personal, [personal], { listReference: "#personal/" });
    list.mockResolvedValue([mailbox("#personal/Archive")]);
    await expect(provider.ensureFolder("Archive")).rejects.toThrow("Unsupported IMAP personal namespace");
    expect(list).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses the unpinned shape with distinct personal and shared prefix casing", async () => {
    const personal = { prefix: "Mail/", delimiter: "/" };
    const { provider, list, create } = imapProvider(personal, [personal], {
      shared: [{ prefix: "mail/", delimiter: "/" }],
    });
    list.mockResolvedValue([mailbox("Mail/Archive")]);

    await expect(provider.ensureFolder("Archive")).rejects.toThrow("Unsupported IMAP personal namespace");
    expect(list).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses the NIL mailbox token in any segment", async () => {
    const { provider, list, create } = imapProvider({ prefix: "", delimiter: "/" });
    list.mockResolvedValue([]);
    create.mockResolvedValue({ path: "NIL", created: true });

    for (const path of ["NIL", "Archive/nIl"]) {
      await expect(provider.ensureFolder(path)).rejects.toBeInstanceOf(FolderCreateRefusal);
    }
    expect(create).not.toHaveBeenCalled();
  });

  it("keeps a selectable raw LIST row when LSUB would add Noselect", async () => {
    const { provider, list, mergedList, create } = imapProvider({ prefix: "", delimiter: "/" });
    list.mockResolvedValue([mailbox("Archive")]);
    mergedList.mockResolvedValue([mailbox("Archive", "\\Noselect")]);
    create.mockResolvedValue({ path: "Archive", created: false });

    await expect(provider.ensureFolder("Archive")).resolves.toBe("Archive");
    expect(mergedList).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses the unpinned quoted IMAP4rev2 namespace despite the root LIST fallback", async () => {
    const personal = { prefix: "Mail/", delimiter: "/" };
    const { provider, list, create } = imapProvider(supported, [personal], { mode: "rev2" });
    list.mockResolvedValue([mailbox("Mail/Archive")]);

    await expect(provider.ensureFolder("Archive")).rejects.toThrow("Unsupported IMAP personal namespace");
    expect(list).not.toHaveBeenCalled();
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
    const { provider, list, create } = imapProvider(supported);
    const path = "Archive/2021";
    list.mockResolvedValue([mailbox(path, "\\NonExistent")]);
    create.mockResolvedValue({ path, created: false });

    await expect(provider.ensureFolder("Archive/2021")).rejects.toThrow("The server did not confirm folder creation.");
    expect(create).toHaveBeenCalledWith(path);
  });
});
