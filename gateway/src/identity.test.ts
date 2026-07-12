import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import { AgentIdentityAuthority, signAgentRequest } from "./identity.js";

describe("Fleet launcher identity seam", () => {
  it("binds one run to its proof key and tailnet node, rejects replay, and supports revocation", () => {
    const now = new Date("2026-07-11T10:00:00.000Z");
    const authority = new AgentIdentityAuthority({
      signingKey: Buffer.alloc(32, 7),
      now: () => now,
    });
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const token = authority.issue({
      runId: "run-42",
      nodeId: "node-production-host",
      publicKey,
      lifetimeMs: 60_000,
    });
    const request = {
      method: "POST",
      path: "/mcp",
      body: Buffer.from('{"tool":"folders","action":"list"}'),
      timestamp: now.toISOString(),
      nonce: "nonce-000000000001",
    };
    const proof = signAgentRequest(privateKey, request);

    expect(
      authority.authorize({
        token,
        proof,
        tailnetNodeId: "node-production-host",
        request,
      }),
    ).toMatchObject({ runId: "run-42", nodeId: "node-production-host" });

    expect(() =>
      authority.authorize({
        token,
        proof,
        tailnetNodeId: "node-other",
        request,
      }),
    ).toThrow("tailnet node");
    expect(() =>
      authority.authorize({
        token,
        proof,
        tailnetNodeId: "node-production-host",
        request,
      }),
    ).toThrow("replay");

    authority.revoke("run-42");
    const secondRequest = { ...request, nonce: "nonce-000000000002" };
    expect(() =>
      authority.authorize({
        token,
        proof: signAgentRequest(privateKey, secondRequest),
        tailnetNodeId: "node-production-host",
        request: secondRequest,
      }),
    ).toThrow("revoked");
  });
});
