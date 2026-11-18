import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CredentialVault } from "./vault.js";

describe("admin verify folder prerequisite", () => {
  const gateway = fileURLToPath(new URL("../", import.meta.url));
  let build: string;

  beforeAll(async () => {
    build = await mkdtemp(join(gateway, "node_modules", ".admin-verify-"));
    await writeFile(join(build, "package.json"), '{"type":"module"}');
    execFileSync(join(gateway, "node_modules", ".bin", "tsc"), [
      "-p", "tsconfig.build.json", "--outDir", build,
    ], { cwd: gateway, timeout: 15_000 });
  }, 20_000);

  afterAll(async () => {
    if (build) await rm(build, { recursive: true, force: true });
  });

  it.each([
    { name: "missing", listRow: "" },
    { name: "marked Noselect", listRow: '* LIST (\\Noselect) "/" "Agent Gateway Test"\r\n' },
  ])("names the test folder when it is $name", async ({ listRow }) => {
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => { sockets.delete(socket); });
      socket.on("error", () => { socket.destroy(); });
      socket.write("* OK Synthetic IMAP ready\r\n");
      socket.setEncoding("ascii");
      let pending = "";
      socket.on("data", (chunk: string) => {
        pending += chunk;
        let end: number;
        while ((end = pending.indexOf("\r\n")) >= 0) {
          const [tag, command] = pending.slice(0, end).split(" ", 2);
          pending = pending.slice(end + 2);
          switch (command) {
            case "CAPABILITY":
              socket.write("* CAPABILITY IMAP4rev1 NAMESPACE\r\n");
              break;
            case "NAMESPACE":
              socket.write('* NAMESPACE (("" "/")) NIL NIL\r\n');
              break;
            case "LIST":
              socket.write(listRow);
              break;
            case "LOGOUT":
              socket.end(`* BYE Synthetic IMAP closed\r\n${tag} OK LOGOUT\r\n`);
              continue;
            case "LOGIN":
            case "LSUB":
              break;
            default:
              socket.write(`${tag} BAD Unexpected fixture command\r\n`);
              continue;
          }
          socket.write(`${tag} OK ${command}\r\n`);
        }
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Synthetic IMAP port unavailable");
      const state = await mkdtemp(join(build, "state-"));
      const key = randomBytes(32);
      await writeFile(join(state, "mail-vault-master"), key, { mode: 0o600 });
      const vault = new CredentialVault({ databasePath: join(state, "vault.sqlite"), masterKey: key });
      try {
        vault.put({
          grantId: "synthetic", label: "Synthetic", provider: "imap-smtp",
          secret: {
            mailboxAddress: "synthetic@example.invalid",
            username: "synthetic",
            auth: { type: "password", password: "test-fixture" },
            imap: { host: "127.0.0.1", port: address.port, secure: false },
            smtp: { host: "127.0.0.1", port: 1, secure: false },
          },
        });
      } finally {
        vault.close();
      }

      const child = spawn(process.execPath, [
        "--disable-warning=ExperimentalWarning", join(build, "admin-main.js"), "verify", "--state-dir", state,
      ], { env: { CREDENTIALS_DIRECTORY: state }, stdio: ["pipe", "ignore", "pipe"], timeout: 5_000 });
      const finished = once(child, "close");
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      child.stdin.end("synthetic\n");
      const [code, signal] = await finished;
      expect(signal).toBeNull();
      expect(stderr).toBe('Create or fix the folder "Agent Gateway Test" in this mailbox, then rerun admin verify. It must be selectable.\n');
      expect(code).toBe(2);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }, 8_000);
});
