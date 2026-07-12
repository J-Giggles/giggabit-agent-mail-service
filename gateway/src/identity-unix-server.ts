import { chmod, lstat, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isAbsolute } from "node:path";

const MAX_REGISTRATION_BYTES = 64 * 1024;

export interface LocalIdentityHandler {
  handle(request: Request): Promise<Response>;
}

export interface IdentityUnixServerOptions {
  handler: LocalIdentityHandler;
  socketPath: string;
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += value.length;
    if (total > MAX_REGISTRATION_BYTES) throw new Error("registration request is too large");
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function writeResponse(response: Response, target: ServerResponse): Promise<void> {
  target.statusCode = response.status;
  response.headers.forEach((value, name) => target.setHeader(name, value));
  target.end(Buffer.from(await response.arrayBuffer()));
}

export class IdentityUnixServer {
  readonly #handler: LocalIdentityHandler;
  readonly #socketPath: string;
  #server: Server | undefined;

  constructor(options: IdentityUnixServerOptions) {
    if (!isAbsolute(options.socketPath)) throw new Error("identity socket path must be absolute");
    this.#handler = options.handler;
    this.#socketPath = options.socketPath;
  }

  async start(): Promise<void> {
    if (this.#server) throw new Error("identity registration server is already running");
    try {
      const existing = await lstat(this.#socketPath);
      if (!existing.isSocket()) throw new Error("identity socket path is occupied by a non-socket file");
      await rm(this.#socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.#server = createServer((request, response) => void this.#route(request, response));
    await new Promise<void>((resolve, reject) => {
      this.#server?.once("error", reject);
      this.#server?.listen(this.#socketPath, resolve);
    });
    await chmod(this.#socketPath, 0o600);
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    if (server) {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
    await rm(this.#socketPath, { force: true });
  }

  async #route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.method !== "POST" || request.url !== "/identity") {
        await writeResponse(Response.json({ error: "not_found" }, { status: 404 }), response);
        return;
      }
      const body = await readBody(request);
      const registration = new Request("http://localhost/identity", {
        method: "POST",
        headers: { "content-type": request.headers["content-type"] ?? "application/octet-stream" },
        body: new Uint8Array(body),
      });
      await writeResponse(await this.#handler.handle(registration), response);
    } catch {
      await writeResponse(Response.json({ error: "identity_registration_failed" }, { status: 400 }), response);
    }
  }
}
