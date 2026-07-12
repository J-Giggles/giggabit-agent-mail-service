import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

export interface GatewayRequestSession {
  request(body: Buffer): Promise<Response>;
}

export interface StdioProxyOptions {
  input: Readable;
  output: Writable;
  session: GatewayRequestSession;
}

function failureResponse(id: unknown): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: typeof id === "string" || typeof id === "number" || id === null ? id : null,
    error: { code: -32000, message: "Mail gateway request failed." },
  });
}

export async function runStdioProxy(options: StdioProxyOptions): Promise<void> {
  const lines = createInterface({ input: options.input, crlfDelay: Infinity, terminal: false });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let id: unknown;
    try {
      const message = JSON.parse(line) as { id?: unknown };
      id = message.id;
    } catch {
      options.output.write(`${failureResponse(null)}\n`);
      continue;
    }
    try {
      const response = await options.session.request(Buffer.from(line, "utf8"));
      if (response.status === 202 || response.status === 204) continue;
      const body = await response.text();
      if (!response.ok) {
        if (id !== undefined) options.output.write(`${failureResponse(id)}\n`);
        continue;
      }
      JSON.parse(body);
      options.output.write(`${body}\n`);
    } catch {
      if (id !== undefined) options.output.write(`${failureResponse(id)}\n`);
    }
  }
}
