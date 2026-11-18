import { once } from "node:events";
import { createServer, type Socket } from "node:net";
import { ImapFlow } from "imapflow";
import { afterEach, expect, it, vi } from "vitest";

import { HostMailGateway } from "./gateway.js";
import { ImapSmtpProvider } from "./imap-smtp-provider.js";

async function withImapFixture(
  namespace: string,
  mailbox: string,
  verify: (provider: ImapSmtpProvider, listCommands: Buffer[], mutations: string[]) => Promise<void>,
  options: { createdName?: string; capabilities?: string; listRows?: (command: Buffer) => string | undefined } = {},
) {
  const sockets = new Set<Socket>();
  const listCommands: Buffer[] = [];
  const mutations: string[] = [];
  const quotedListedName = JSON.stringify(options.createdName ?? mailbox);
  const exactList = Buffer.from(`LIST "" ${JSON.stringify(mailbox)}\r\n`);
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => { sockets.delete(socket); });
    socket.on("error", () => { socket.destroy(); });
    socket.write("* OK Synthetic IMAP ready\r\n");
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
      let end: number;
      while ((end = pending.indexOf("\r\n")) >= 0) {
        const line = pending.subarray(0, end + 2);
        pending = pending.subarray(end + 2);
        const separator = line.indexOf(" ");
        const tag = line.subarray(0, separator).toString("ascii");
        const command = line.subarray(separator + 1);
        const verb = command.toString("ascii").split(/[ \r]/, 1)[0];
        switch (verb) {
          case "CAPABILITY":
            socket.write(`* CAPABILITY IMAP4rev1 NAMESPACE ${options.capabilities ?? ""}\r\n${tag} OK CAPABILITY\r\n`);
            break;
          case "LOGIN":
            socket.write(`${tag} OK LOGIN\r\n`);
            break;
          case "NAMESPACE":
            socket.write(`* NAMESPACE ${namespace}\r\n${tag} OK NAMESPACE\r\n`);
            break;
          case "LIST": {
            listCommands.push(command);
            if (options.listRows) {
              const rows = options.listRows(command);
              if (rows === undefined) {
                socket.write(`${tag} BAD Unsupported LIST return option\r\n`);
                break;
              }
              socket.write(rows);
            } else if (mutations.includes("CREATE") && command.equals(exactList)) {
              socket.write(`* LIST () "/" ${quotedListedName}\r\n`);
            }
            socket.write(`${tag} OK LIST\r\n`);
            break;
          }
          case "LSUB":
            socket.write(`${tag} OK LSUB\r\n`);
            break;
          case "CREATE": {
            const succeeds = options.createdName !== undefined && !mutations.includes("CREATE");
            mutations.push(verb);
            socket.write(succeeds ? `${tag} OK CREATE\r\n` : `${tag} NO [ALREADYEXISTS] Mailbox already exists\r\n`);
            break;
          }
          case "SUBSCRIBE":
            mutations.push(verb);
            socket.write(`${tag} OK SUBSCRIBE\r\n`);
            break;
          case "LOGOUT":
            socket.end(`* BYE Synthetic IMAP closed\r\n${tag} OK LOGOUT\r\n`);
            break;
          default:
            socket.write(`${tag} BAD Unexpected fixture command\r\n`);
        }
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Synthetic IMAP port unavailable");
    const provider = new ImapSmtpProvider({
      grant: { grantId: "synthetic", label: "Synthetic", provider: "google-oauth" },
      connections: { getConnection: async () => ({
        mailboxAddress: "test@example.invalid",
        username: "test",
        password: "test-fixture",
        imap: { host: "127.0.0.1", port: address.port, secure: false },
        smtp: { host: "127.0.0.1", port: 25, secure: false },
      }) },
    });

    await verify(provider, listCommands, mutations);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

afterEach(() => vi.restoreAllMocks());

it("sends a quoted reference and exact quoted mailbox name on the IMAP wire", async () => {
  await withImapFixture('(("" "/")) NIL NIL', "My Archive", async (provider, listCommands, mutations) => {
    const expected = Buffer.from('LIST "" "My Archive"\r\n');
    await expect(provider.ensureFolder("My Archive")).resolves.toBe("My Archive");
    await expect(provider.ensureFolder("My Archive")).resolves.toBe("My Archive");
    expect(mutations).toEqual(["CREATE"]);
    expect(listCommands).toEqual([expected, expected, expected]);
  });
});

it("refuses a case-normalized path after successful CREATE and on identical retry", async () => {
  const requested = "finance/Receipts";
  const expected = Buffer.from('LIST "" "finance/Receipts"\r\n');
  await withImapFixture('(("" "/")) NIL NIL', requested, async (provider, listCommands, mutations) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(provider.ensureFolder(requested)).rejects.toThrow("Use the exact path from folders.list");
    }
    expect(listCommands).toEqual([expected, expected, expected, expected]);
    expect(mutations).toEqual(["CREATE", "SUBSCRIBE", "CREATE"]);
  }, { createdName: "Finance/Receipts" });
});

it("refuses a namespace extension without a value list before issuing IMAP mutations", async () => {
  await withImapFixture('(("" "/" "X-TEST")) NIL NIL', "Archive/My Folder", async (provider, listCommands, mutations) => {
    await expect(provider.ensureFolder("Archive/My Folder")).rejects.toThrow("Unsupported IMAP personal namespace");
    expect(listCommands).toEqual([]);
    expect(mutations).toEqual([]);
  });
});

it.each(["SPECIAL-USE", "LIST-EXTENDED"])("requests selectable special-use roles on the wire with %s", async (capability) => {
  const expected = Buffer.from('LIST "" "*" RETURN (SPECIAL-USE)\r\n');
  await withImapFixture('(("" "/")) NIL NIL', "unused", async (provider, listCommands, mutations) => {
    await expect(provider.listFolders({ selectableOnly: true })).resolves.toEqual([
      { path: "Work/Drafts", name: "Drafts", role: "drafts" },
      { path: "Work/Trash", name: "Trash", role: "trash" },
    ]);
    expect(listCommands).toEqual([expected]);
    expect(mutations).toEqual([]);
  }, {
    capabilities: capability,
    listRows: (command) => command.equals(expected)
      ? '* LIST (\\Drafts) "/" "Work/Drafts"\r\n* LIST (\\Trash) "/" "Work/Trash"\r\n'
      : '* LIST () "/" "Work/Drafts"\r\n* LIST () "/" "Work/Trash"\r\n',
  });
});

it("uses the plain LIST flags if a LIST-EXTENDED server rejects the special-use option", async () => {
  const extended = Buffer.from('LIST "" "*" RETURN (SPECIAL-USE)\r\n');
  await withImapFixture('(("" "/")) NIL NIL', "unused", async (provider, listCommands) => {
    await expect(provider.listFolders({ selectableOnly: true })).resolves.toEqual([
      { path: "Work/Drafts", name: "Drafts", role: "drafts" },
    ]);
    expect(listCommands).toEqual([extended, Buffer.from('LIST "" "*"\r\n')]);
  }, {
    capabilities: "LIST-EXTENDED",
    listRows: (command) => command.equals(extended) ? undefined : '* LIST (\\Drafts) "/" "Work/Drafts"\r\n',
  });
});

it("keeps localized folder resolution for ordinary OAuth drafts and trash", async () => {
  const append = vi.spyOn(ImapFlow.prototype, "append").mockResolvedValue({ destination: "Borradores" });
  const move = vi.spyOn(ImapFlow.prototype, "messageMove").mockResolvedValue({
    path: "INBOX", destination: "Elementos eliminados",
  });
  vi.spyOn(ImapFlow.prototype, "getMailboxLock").mockImplementation(async function (this: ImapFlow) {
    Object.assign(this, { mailbox: { uidValidity: 7n } });
    return { path: "INBOX", release: () => undefined };
  });
  await withImapFixture('(("" "/")) NIL NIL', "unused", async (provider) => {
    const gateway = new HostMailGateway({ providers: [provider], audit: () => undefined });
    const principal = { tokenId: "agent", runId: "run", nodeId: "node", expiresAt: "2026-11-19T00:00:00.000Z" };
    const draft = await gateway.callTool(principal, "send", {
      action: "draft", grant_id: "synthetic", to: ["test@example.invalid"], subject: "Draft", body: "Synthetic.",
    });
    const reference = Buffer.from(JSON.stringify({ version: 1, folder: "INBOX", uidValidity: "7", uid: 1 })).toString("base64url");
    const trashed = await gateway.callTool(principal, "messages", {
      action: "trash", grant_id: "synthetic", folder: "INBOX", message_ref: `imap1:${reference}`,
    });
    expect([draft.folder, trashed.folder]).toEqual(["Borradores", "Elementos eliminados"]);
    expect(append.mock.calls[0]?.[0]).toBe("Borradores");
    expect(move.mock.calls[0]?.[1]).toBe("Elementos eliminados");
  }, {
    listRows: () => '* LIST () "/" "Borradores"\r\n* LIST () "/" "Elementos eliminados"\r\n',
  });
});
