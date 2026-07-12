import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import { HostMailGateway } from "./gateway.js";
import { AgentIdentityAuthority, signAgentRequest } from "./identity.js";
import { GatewayMcpHandler } from "./mcp-handler.js";
import { packageVersion } from "./package-version.js";
import type { MailboxProvider } from "./provider.js";

describe("Gateway Streamable HTTP MCP seam", () => {
  it("rejects an invalid proof and accepts MCP initialization from the bound tailnet node", async () => {
    const now = new Date("2026-07-11T10:00:00.000Z");
    const authority = new AgentIdentityAuthority({ signingKey: Buffer.alloc(32, 3), now: () => now });
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const token = authority.issue({
      runId: "run-42",
      nodeId: "node-production-host",
      publicKey,
      lifetimeMs: 60_000,
    });
    const provider: MailboxProvider = {
      grant: { grantId: "mailbox-1", label: "Personal mailbox", provider: "fake" },
      listFolders: async () => [],
      search: async () => [],
      read: async () => {
        throw new Error("not used");
      },
    };
    const handler = new GatewayMcpHandler({
      authority,
      gateway: new HostMailGateway({ providers: [provider], audit: () => undefined }),
      tailnet: { identify: async () => ({ nodeId: "node-production-host" }) },
    });
    const body = Buffer.from(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "fleet-test", version: "1.0.0" },
        },
      }),
    );
    const requestProof = {
      method: "POST",
      path: "/mcp",
      body,
      timestamp: now.toISOString(),
      nonce: "nonce-000000000001",
    };
    const headers = {
      authorization: `Agent ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-agent-timestamp": requestProof.timestamp,
      "x-agent-nonce": requestProof.nonce,
    };

    const rejected = await handler.handle(
      new Request("https://mail-host.tailnet.invalid/mcp", {
        method: "POST",
        headers: { ...headers, "x-agent-proof": "invalid" },
        body,
      }),
      "100.114.48.17",
    );
    expect(rejected.status).toBe(401);

    const accepted = await handler.handle(
      new Request("https://mail-host.tailnet.invalid/mcp", {
        method: "POST",
        headers: { ...headers, "x-agent-proof": signAgentRequest(privateKey, requestProof) },
        body,
      }),
      "100.114.48.17",
    );
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toMatchObject({
      result: { serverInfo: { name: "giggabit-agent-mail-service", version: packageVersion } },
    });
  });

  it("advertises the magic-link tool only when operator policy enables it", async () => {
    const now = new Date("2026-07-11T10:00:00.000Z");
    const provider: MailboxProvider = {
      grant: { grantId: "mailbox-1", label: "Test mailbox", provider: "fake" },
      listFolders: async () => [],
      search: async () => [],
      read: async () => {
        throw new Error("not used");
      },
    };
    const listTools = async (gateway: HostMailGateway, suffix: string) => {
      const authority = new AgentIdentityAuthority({ signingKey: Buffer.alloc(32, 4), now: () => now });
      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      const token = authority.issue({
        runId: `run-${suffix}`,
        nodeId: "node-production-host",
        publicKey,
        lifetimeMs: 60_000,
      });
      const handler = new GatewayMcpHandler({
        authority,
        gateway,
        tailnet: { identify: async () => ({ nodeId: "node-production-host" }) },
      });
      const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }));
      const proofInput = {
        method: "POST",
        path: "/mcp",
        body,
        timestamp: now.toISOString(),
        nonce: `nonce-magic-link-${suffix}`,
      };
      const response = await handler.handle(
        new Request("https://mail-host.tailnet.invalid/mcp", {
          method: "POST",
          headers: {
            authorization: `Agent ${token}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "x-agent-timestamp": proofInput.timestamp,
            "x-agent-nonce": proofInput.nonce,
            "x-agent-proof": signAgentRequest(privateKey, proofInput),
          },
          body,
        }),
        "100.64.0.10",
      );
      expect(response.status).toBe(200);
      return response.text();
    };

    const disabled = await listTools(
      new HostMailGateway({ providers: [provider], audit: () => undefined }),
      "disabled-0001",
    );
    expect(disabled).not.toContain('"name":"magic_link"');

    const enabled = await listTools(
      new HostMailGateway({
        providers: [provider],
        audit: () => undefined,
        magicLinkPolicy: {
          rules: [{
            grantId: "mailbox-1",
            expectedSenders: ["login@example.invalid"],
            expectedHostnames: ["staging.example.invalid"],
          }],
        },
      }),
      "enabled-0002",
    );
    expect(enabled.match(/"name":"magic_link"/g)).toHaveLength(1);
  });
});
