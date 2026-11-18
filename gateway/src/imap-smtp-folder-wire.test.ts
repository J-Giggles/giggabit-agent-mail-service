import { once } from "node:events";
import { createServer, type Socket } from "node:net";
import { expect, it } from "vitest";

import { ImapSmtpProvider } from "./imap-smtp-provider.js";

it("sends a quoted reference and exact quoted mailbox name on the IMAP wire", async () => {
  const sockets = new Set<Socket>();
  const listCommands: Buffer[] = [];
  const expected = Buffer.from('LIST "" "My Archive"\r\n');
  let createAttempts = 0;
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
            socket.write(`* CAPABILITY IMAP4rev1 NAMESPACE\r\n${tag} OK CAPABILITY\r\n`);
            break;
          case "LOGIN":
            socket.write(`${tag} OK LOGIN\r\n`);
            break;
          case "NAMESPACE":
            socket.write(`* NAMESPACE (("" "/")) NIL NIL\r\n${tag} OK NAMESPACE\r\n`);
            break;
          case "LIST":
            listCommands.push(command);
            if (createAttempts && command.equals(expected)) socket.write('* LIST () "/" "My Archive"\r\n');
            socket.write(`${tag} OK LIST\r\n`);
            break;
          case "CREATE":
            createAttempts += 1;
            socket.write(`${tag} NO [ALREADYEXISTS] Mailbox already exists\r\n`);
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

    await expect(provider.ensureFolder("My Archive")).resolves.toBe("My Archive");
    await expect(provider.ensureFolder("My Archive")).resolves.toBe("My Archive");
    expect(createAttempts).toBe(1);
    expect(listCommands).toEqual([expected, expected, expected]);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
