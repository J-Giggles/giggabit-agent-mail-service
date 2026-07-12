import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { SignedGatewaySession } from "./agent-launcher.js";
import { GatewayHttpServer } from "./http-server.js";
import { AgentIdentityAuthority } from "./identity.js";
import { AgentIdentityRegistrationHandler } from "./identity-registration.js";
import { IdentityUnixServer } from "./identity-unix-server.js";
import { AgentRunEndHandler } from "./run-end-handler.js";

describe("tailnet-bound agent launcher", () => {
  let server: GatewayHttpServer | undefined;
  let identityServer: IdentityUnixServer | undefined;
  let temporaryDirectory: string | undefined;

  afterEach(async () => {
    await server?.stop();
    await identityServer?.stop();
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it("enrolls an ephemeral run key and signs each exact MCP request", async () => {
    const authority = new AgentIdentityAuthority({ signingKey: randomBytes(32) });
    const tailnet = { identify: async () => ({ nodeId: "tailnet-node-1" }) };
    const registration = new AgentIdentityRegistrationHandler({
      authority,
      nodeIdentity: { identifyLocal: async () => ({ nodeId: "tailnet-node-1" }) },
    });
    temporaryDirectory = await mkdtemp(join(tmpdir(), "mail-identity-"));
    const socketPath = join(temporaryDirectory, "identity.sock");
    identityServer = new IdentityUnixServer({ handler: registration, socketPath });
    await identityServer.start();
    const seen: string[] = [];
    const cleanupRun = vi.fn(async () => undefined);
    server = new GatewayHttpServer({
      host: "127.0.0.1",
      port: 0,
      handler: {
        handle: async (request, _peerIp) => {
          expect(request.headers.get("accept")).toBe("application/json, text/event-stream");
          const body = Buffer.from(await request.arrayBuffer());
          const timestamp = request.headers.get("x-agent-timestamp") ?? "";
          const nonce = request.headers.get("x-agent-nonce") ?? "";
          const proof = request.headers.get("x-agent-proof") ?? "";
          const token = (request.headers.get("authorization") ?? "").replace(/^Agent /, "");
          const principal = authority.authorize({
            token,
            proof,
            tailnetNodeId: "tailnet-node-1",
            request: { method: "POST", path: "/mcp", body, timestamp, nonce },
          });
          seen.push(principal.runId);
          return Response.json({ jsonrpc: "2.0", id: 1, result: { accepted: true } });
        },
      },
      runEndHandler: new AgentRunEndHandler({
        authority,
        tailnet,
        quarantine: { cleanupRun },
      }),
    });
    const address = await server.start();

    const session = await SignedGatewaySession.connect({
      baseUrl: address.url,
      enrollmentSocketPath: socketPath,
      runId: "run-123",
    });
    const response = await session.request(Buffer.from('{"jsonrpc":"2.0","id":1,"method":"ping"}'));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { accepted: true } });
    expect(seen).toEqual(["run-123"]);
    expect(session.publicKey.asymmetricKeyType).toBe("ed25519");
    await session.close();
    expect(cleanupRun).toHaveBeenCalledWith("run-123");
  });
});
