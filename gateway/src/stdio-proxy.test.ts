import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { runStdioProxy } from "./stdio-proxy.js";

describe("agent stdio MCP proxy", () => {
  it("forwards JSON-RPC messages in order and never writes enrollment material to stdout", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let captured = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => (captured += chunk));
    const bodies: string[] = [];
    const session = {
      request: async (body: Buffer) => {
        bodies.push(body.toString("utf8"));
        const request = JSON.parse(body.toString("utf8")) as { id: number };
        return Response.json({ jsonrpc: "2.0", id: request.id, result: { ok: true } });
      },
    };

    const running = runStdioProxy({ input, output, session });
    input.end(
      '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n',
    );
    await running;

    expect(bodies).toEqual([
      '{"jsonrpc":"2.0","id":1,"method":"initialize"}',
      '{"jsonrpc":"2.0","id":2,"method":"tools/list"}',
    ]);
    expect(captured.trim().split("\n").map((line) => JSON.parse(line))).toEqual([
      { jsonrpc: "2.0", id: 1, result: { ok: true } },
      { jsonrpc: "2.0", id: 2, result: { ok: true } },
    ]);
    expect(captured).not.toContain("token");
    expect(captured).not.toContain("private");
  });
});
