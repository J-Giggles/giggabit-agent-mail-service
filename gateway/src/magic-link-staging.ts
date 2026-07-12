import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

interface StagingAttempt {
  alias: string;
  attemptId: string;
  expiresAt: number;
  handedOut: boolean;
  magicLink?: string;
  requestedAt: string;
  tokenHash: Buffer;
}

export interface MagicLinkStagingOptions {
  publicOrigin: string;
  controlSocketPath: string;
  now?: () => Date;
  port?: number;
}

export interface MagicLinkStagingAddress {
  url: string;
}

const PAGE_HEADERS = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; form-action 'self'; frame-ancestors 'none'; style-src 'unsafe-inline'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "content-type": "text/html; charset=utf-8",
};

function htmlPage(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
}

function json(response: ServerResponse, status: number, value: Record<string, unknown>): void {
  response.writeHead(status, { "cache-control": "no-store", "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function requestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 4096) reject(new Error("request body is too large"));
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function listen(server: Server, target: { host: string; port: number } | string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(target, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server: Server | undefined): Promise<void> {
  if (!server) return Promise.resolve();
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

export class MagicLinkStagingApp {
  readonly #attempts = new Map<string, StagingAttempt>();
  readonly #controlSocketPath: string;
  readonly #hostname: string;
  readonly #now: () => Date;
  readonly #port: number;
  readonly #publicOrigin: string;
  readonly #sessions = new Map<string, number>();
  #controlServer: Server | undefined;
  #publicServer: Server | undefined;

  constructor(options: MagicLinkStagingOptions) {
    const origin = new URL(options.publicOrigin);
    if (origin.protocol !== "https:" || origin.origin !== options.publicOrigin) {
      throw new Error("publicOrigin must be an exact HTTPS origin");
    }
    this.#controlSocketPath = options.controlSocketPath;
    this.#hostname = origin.hostname;
    this.#now = options.now ?? (() => new Date());
    this.#port = options.port ?? 0;
    if (!Number.isSafeInteger(this.#port) || this.#port < 0 || this.#port > 65_535) {
      throw new Error("port must be between 0 and 65535");
    }
    this.#publicOrigin = origin.origin;
  }

  async start(): Promise<MagicLinkStagingAddress> {
    if (this.#publicServer || this.#controlServer) throw new Error("staging application is already started");
    await rm(this.#controlSocketPath, { force: true });
    this.#publicServer = createServer((request, response) => void this.#handlePublic(request, response));
    this.#controlServer = createServer((request, response) => this.#handleControl(request, response));
    await listen(this.#publicServer, { host: "127.0.0.1", port: this.#port });
    try {
      await listen(this.#controlServer, this.#controlSocketPath);
      await chmod(this.#controlSocketPath, 0o600);
    } catch (error) {
      await close(this.#publicServer);
      this.#publicServer = undefined;
      this.#controlServer = undefined;
      throw error;
    }
    const address = this.#publicServer.address();
    if (!address || typeof address === "string") throw new Error("staging application did not bind to TCP");
    return { url: `http://127.0.0.1:${address.port}` };
  }

  async stop(): Promise<void> {
    const publicServer = this.#publicServer;
    const controlServer = this.#controlServer;
    this.#publicServer = undefined;
    this.#controlServer = undefined;
    await Promise.all([close(publicServer), close(controlServer)]);
    await rm(this.#controlSocketPath, { force: true });
    this.#attempts.clear();
    this.#sessions.clear();
  }

  async #handlePublic(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.method === "GET" && request.url === "/magic-link-staging") {
        response.writeHead(200, PAGE_HEADERS);
        response.end(
          htmlPage(
            "Staging magic-link sign in",
            '<main><h1>Staging magic-link sign in</h1><form method="post" action="/magic-link-staging/request"><label>Dedicated test alias <input type="email" name="alias" required autocomplete="email"></label><button type="submit">Request magic link</button></form></main>',
          ),
        );
        return;
      }
      if (request.method === "GET" && request.url === "/magic-link-staging/health") {
        json(response, 200, { status: "ok", service: "giggabit-magic-link-staging" });
        return;
      }
      if (request.method === "POST" && request.url === "/magic-link-staging/request") {
        if (request.headers.origin !== this.#publicOrigin) {
          response.writeHead(403, PAGE_HEADERS).end(htmlPage("Request refused", "<p>Request refused.</p>"));
          return;
        }
        const contentType = request.headers["content-type"] ?? "";
        if (!contentType.startsWith("application/x-www-form-urlencoded")) {
          response.writeHead(415, PAGE_HEADERS).end(htmlPage("Unsupported request", "<p>Unsupported request.</p>"));
          return;
        }
        const values = new URLSearchParams(await requestBody(request));
        const alias = values.get("alias")?.trim() ?? "";
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(alias) || alias.length > 320) {
          response.writeHead(400, PAGE_HEADERS).end(htmlPage("Invalid alias", "<p>Enter a valid test alias.</p>"));
          return;
        }
        const attemptId = randomUUID();
        const token = randomBytes(32).toString("base64url");
        const requestedAt = this.#now().toISOString();
        const magicLink = `${this.#publicOrigin}/magic-link-staging/consume?${new URLSearchParams({ attempt: attemptId, token })}`;
        this.#attempts.set(attemptId, {
          alias,
          attemptId,
          expiresAt: this.#now().getTime() + 5 * 60_000,
          handedOut: false,
          magicLink,
          requestedAt,
          tokenHash: createHash("sha256").update(token).digest(),
        });
        response.writeHead(202, PAGE_HEADERS);
        response.end(htmlPage("Check mailbox", "<main><h1>Check the dedicated test mailbox</h1></main>"));
        return;
      }
      const requestUrl = new URL(request.url ?? "/", "http://staging.invalid");
      if (request.method === "GET" && requestUrl.pathname === "/magic-link-staging/consume") {
        const attemptValues = requestUrl.searchParams.getAll("attempt");
        const tokenValues = requestUrl.searchParams.getAll("token");
        const allowedKeys = [...requestUrl.searchParams.keys()].every((key) => key === "attempt" || key === "token");
        const attempt = attemptValues.length === 1 ? this.#attempts.get(attemptValues[0]!) : undefined;
        const candidateHash = createHash("sha256").update(tokenValues.length === 1 ? tokenValues[0]! : "").digest();
        const tokenMatches = timingSafeEqual(candidateHash, attempt?.tokenHash ?? Buffer.alloc(32));
        if (!allowedKeys || !attempt || attempt.expiresAt <= this.#now().getTime() || !tokenMatches) {
          response.writeHead(410, PAGE_HEADERS).end(htmlPage("Link unavailable", "<p>Link unavailable.</p>"));
          return;
        }
        this.#attempts.delete(attempt.attemptId);
        const session = randomBytes(32).toString("base64url");
        this.#sessions.set(createHash("sha256").update(session).digest("hex"), this.#now().getTime() + 10 * 60_000);
        response.writeHead(303, {
          "cache-control": "no-store",
          location: "/magic-link-staging/account",
          "referrer-policy": "no-referrer",
          "set-cookie": `gbt_staging_session=${session}; Path=/magic-link-staging; Max-Age=600; HttpOnly; Secure; SameSite=Strict`,
          "x-content-type-options": "nosniff",
        });
        response.end();
        return;
      }
      if (request.method === "GET" && requestUrl.pathname === "/magic-link-staging/account") {
        const cookie = request.headers.cookie
          ?.split(";")
          .map((part) => part.trim())
          .find((part) => part.startsWith("gbt_staging_session="))
          ?.slice("gbt_staging_session=".length);
        const sessionExpiresAt = cookie
          ? this.#sessions.get(createHash("sha256").update(cookie).digest("hex"))
          : undefined;
        if (!sessionExpiresAt || sessionExpiresAt <= this.#now().getTime()) {
          response.writeHead(401, PAGE_HEADERS).end(htmlPage("Sign in required", "<p>Sign in required.</p>"));
          return;
        }
        response.writeHead(200, PAGE_HEADERS);
        response.end(
          htmlPage(
            "Authenticated staging session",
            '<main data-authenticated="true"><h1>Staging session authenticated</h1></main>',
          ),
        );
        return;
      }
      response.writeHead(404, PAGE_HEADERS).end(htmlPage("Not found", "<p>Not found.</p>"));
    } catch {
      response.writeHead(400, PAGE_HEADERS).end(htmlPage("Request failed", "<p>Request failed.</p>"));
    }
  }

  #handleControl(request: IncomingMessage, response: ServerResponse): void {
    if (request.method !== "POST" || request.url !== "/attempts/claim") {
      json(response, 404, { status: "not_found" });
      return;
    }
    const now = this.#now().getTime();
    for (const [attemptId, attempt] of this.#attempts) {
      if (attempt.expiresAt <= now) {
        this.#attempts.delete(attemptId);
        continue;
      }
      if (!attempt.handedOut && attempt.magicLink) {
        attempt.handedOut = true;
        const magicLink = attempt.magicLink;
        delete attempt.magicLink;
        json(response, 200, {
          attempt_id: attempt.attemptId,
          request_time: attempt.requestedAt,
          recipient_alias: attempt.alias,
          expected_sender: attempt.alias,
          expected_hostname: this.#hostname,
          magic_link: magicLink,
        });
        return;
      }
    }
    json(response, 404, { status: "no_pending_attempt" });
  }
}
