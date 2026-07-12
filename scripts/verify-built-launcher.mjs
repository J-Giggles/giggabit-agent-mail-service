#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { AgentRunEndHandler } from "../gateway/dist/run-end-handler.js";
import { HostMailGateway } from "../gateway/dist/gateway.js";
import { GatewayHttpServer } from "../gateway/dist/http-server.js";
import { AgentIdentityAuthority } from "../gateway/dist/identity.js";
import { AgentIdentityRegistrationHandler } from "../gateway/dist/identity-registration.js";
import { IdentityUnixServer } from "../gateway/dist/identity-unix-server.js";
import { GatewayMcpHandler } from "../gateway/dist/mcp-handler.js";

const root = resolve(import.meta.dirname, "..");
const plugin = JSON.parse(await readFile(join(root, "plugin/.mcp.json"), "utf8"));
const command = plugin.mcpServers?.["giggabit-agent-mail-service"]?.command;
if (basename(command ?? "") !== "giggabit-agent-mail-service-agent") {
  throw new Error("Codex integration does not select the protected launcher");
}

const directory = await mkdtemp(join(tmpdir(), "built-launcher-"));
const socketPath = join(directory, "identity.sock");
const authority = new AgentIdentityAuthority({ signingKey: randomBytes(32) });
const tailnet = {
  identify: async () => ({ nodeId: "synthetic-node" }),
  identifyLocal: async () => ({ nodeId: "synthetic-node" }),
};
const identityServer = new IdentityUnixServer({
  socketPath,
  handler: new AgentIdentityRegistrationHandler({ authority, nodeIdentity: tailnet }),
});
const provider = {
  grant: { grantId: "synthetic-mail", label: "Synthetic mail", provider: "synthetic" },
  listFolders: async () => [],
  search: async () => [],
  read: async () => { throw new Error("synthetic launcher verification does not read mail"); },
};
const gateway = new HostMailGateway({ providers: [provider], audit: () => undefined });
const quarantine = { cleanupRun: async () => undefined };
const server = new GatewayHttpServer({
  host: "127.0.0.1",
  port: 0,
  handler: new GatewayMcpHandler({ authority, gateway, tailnet }),
  runEndHandler: new AgentRunEndHandler({ authority, tailnet, quarantine }),
});

let child;
try {
  await identityServer.start();
  const address = await server.start();
  child = spawn(process.execPath, [
    join(root, "gateway/dist/launcher-main.js"),
    "--url", address.url,
    "--enrollment-socket", socketPath,
    "--run-id", "synthetic-launcher-verification",
  ], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4096); });
  child.stdin.end(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "generic-mcp-verifier", version: "1.0.0" },
    },
  })}\n`);
  let timeout;
  const exitCode = await Promise.race([
    new Promise((resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", resolveExit);
    }),
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error("built launcher verification timed out")), 15_000);
    }),
  ]);
  clearTimeout(timeout);
  if (exitCode !== 0) throw new Error(`built launcher failed safely: ${stderr ? "stderr present" : "no stderr"}`);
  const lines = stdout.trim().split("\n").filter(Boolean);
  if (lines.length !== 1) throw new Error("built launcher returned an unexpected response count");
  const response = JSON.parse(lines[0]);
  if (
    response.jsonrpc !== "2.0" ||
    response.id !== 1 ||
    response.result?.serverInfo?.name !== "giggabit-agent-mail-service" ||
    response.result?.serverInfo?.version !== "0.1.0"
  ) {
    throw new Error("built launcher initialize response was invalid");
  }
  process.stdout.write("Built generic MCP launcher and Codex command integration passed.\n");
} finally {
  child?.kill("SIGKILL");
  await server.stop();
  await identityServer.stop();
  await rm(directory, { recursive: true, force: true });
}
