import { describe, expect, it, vi } from "vitest";

import { GatewayHttpServer } from "./http-server.js";

describe("Gateway service operations seam", () => {
  it("serves a secret-free health response and passes MCP requests to the authenticated handler", async () => {
    const handle = vi.fn(async () => Response.json({ jsonrpc: "2.0", result: { ok: true }, id: 1 }));
    const server = new GatewayHttpServer({
      handler: { handle },
      host: "127.0.0.1",
      port: 0,
    });
    const address = await server.start();
    try {
      const health = await fetch(`${address.url}/health`);
      expect(health.status).toBe(200);
      await expect(health.json()).resolves.toEqual({ status: "ok", service: "giggabit-agent-mail-service" });

      const mcp = await fetch(`${address.url}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
      expect(mcp.status).toBe(200);
      expect(handle).toHaveBeenCalledWith(expect.any(Request), "127.0.0.1");

      const remoteEnrollment = await fetch(`${address.url}/identity`, { method: "POST", body: "{}" });
      expect(remoteEnrollment.status).toBe(404);
    } finally {
      await server.stop();
    }
  });
});
