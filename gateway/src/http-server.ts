import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

export interface McpRequestHandler {
  handle(request: Request, peerIp: string): Promise<Response>;
}

export interface GatewayHttpServerOptions {
  handler: McpRequestHandler;
  runEndHandler?: McpRequestHandler;
  host?: string;
  port?: number;
  maxBodyBytes?: number;
}

export interface GatewayServerAddress {
  host: string;
  port: number;
  url: string;
}

async function readBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      throw new Error("request body is too large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function requestHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  return headers;
}

async function writeResponse(response: Response, target: ServerResponse): Promise<void> {
  target.statusCode = response.status;
  response.headers.forEach((value, name) => target.setHeader(name, value));
  target.end(Buffer.from(await response.arrayBuffer()));
}

export class GatewayHttpServer {
  readonly #handler: McpRequestHandler;
  readonly #host: string;
  readonly #maxBodyBytes: number;
  readonly #port: number;
  readonly #runEndHandler: McpRequestHandler | undefined;
  #server: Server | undefined;

  constructor(options: GatewayHttpServerOptions) {
    this.#handler = options.handler;
    this.#host = options.host ?? "127.0.0.1";
    this.#port = options.port ?? 45873;
    this.#runEndHandler = options.runEndHandler;
    this.#maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  }

  async start(): Promise<GatewayServerAddress> {
    if (this.#server) {
      throw new Error("agent mail service server is already running");
    }
    this.#server = createServer((request, response) => {
      void this.#route(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      this.#server?.once("error", reject);
      this.#server?.listen(this.#port, this.#host, () => resolve());
    });
    const address = this.#server.address();
    if (!address || typeof address === "string") {
      throw new Error("agent mail service server address is unavailable");
    }
    return {
      host: this.#host,
      port: address.port,
      url: `http://${this.#host}:${address.port}`,
    };
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  async #route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.method === "GET" && request.url === "/health") {
        await writeResponse(
          Response.json({ status: "ok", service: "giggabit-agent-mail-service" }),
          response,
        );
        return;
      }
      if (request.method === "POST" && request.url === "/run/end" && this.#runEndHandler) {
        const body = await readBody(request, this.#maxBodyBytes);
        const runEndRequest = new Request(`http://${request.headers.host ?? this.#host}${request.url}`, {
          method: "POST",
          headers: requestHeaders(request),
          body: new Uint8Array(body),
        });
        await writeResponse(
          await this.#runEndHandler.handle(runEndRequest, request.socket.remoteAddress ?? ""),
          response,
        );
        return;
      }
      if (request.method !== "POST" || request.url !== "/mcp") {
        await writeResponse(Response.json({ error: "not_found" }, { status: 404 }), response);
        return;
      }
      const body = await readBody(request, this.#maxBodyBytes);
      const webRequest = new Request(`http://${request.headers.host ?? this.#host}${request.url}`, {
        method: "POST",
        headers: requestHeaders(request),
        body: new Uint8Array(body),
      });
      const peerIp = request.socket.remoteAddress ?? "";
      await writeResponse(await this.#handler.handle(webRequest, peerIp), response);
    } catch (error) {
      const status = error instanceof Error && error.message === "request body is too large" ? 413 : 500;
      await writeResponse(Response.json({ error: status === 413 ? "request_too_large" : "internal_error" }, { status }), response);
    }
  }
}
