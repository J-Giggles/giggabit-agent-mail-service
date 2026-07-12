import { generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import { request as httpRequest } from "node:http";

import { signAgentRequest } from "./identity.js";

export interface SignedGatewaySessionOptions {
  baseUrl: string;
  enrollmentSocketPath: string;
  runId: string;
  lifetimeMs?: number;
  fetch?: typeof fetch;
  now?: () => Date;
}

async function enroll(socketPath: string, body: string): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const request = httpRequest(
      {
        socketPath,
        path: "/identity",
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        response.once("error", reject);
        response.once("end", () =>
          resolve(
            new Response(Buffer.concat(chunks), {
              status: response.statusCode ?? 500,
              headers: response.headers as Record<string, string>,
            }),
          ),
        );
      },
    );
    request.once("error", reject);
    request.end(body);
  });
}

function gatewayBaseUrl(value: string): URL {
  const url = new URL(value);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) {
    throw new Error("mail gateway URL is invalid");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  return url;
}

export class SignedGatewaySession {
  readonly #baseUrl: URL;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  #privateKey: KeyObject | undefined;
  readonly #token: string;
  readonly publicKey: KeyObject;

  private constructor(
    options: SignedGatewaySessionOptions,
    token: string,
    privateKey: KeyObject,
    publicKey: KeyObject,
  ) {
    this.#baseUrl = gatewayBaseUrl(options.baseUrl);
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? (() => new Date());
    this.#token = token;
    this.#privateKey = privateKey;
    this.publicKey = publicKey;
  }

  static async connect(options: SignedGatewaySessionOptions): Promise<SignedGatewaySession> {
    const baseUrl = gatewayBaseUrl(options.baseUrl);
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const response = await enroll(
      options.enrollmentSocketPath,
      JSON.stringify({
        run_id: options.runId,
        public_key: publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
        ...(options.lifetimeMs === undefined ? {} : { lifetime_ms: options.lifetimeMs }),
      }),
    );
    if (!response.ok) {
      throw new Error("mail gateway run identity enrollment failed");
    }
    const registration = (await response.json()) as { token?: unknown };
    if (typeof registration.token !== "string") {
      throw new Error("mail gateway returned an invalid run identity");
    }
    return new SignedGatewaySession(options, registration.token, privateKey, publicKey);
  }

  async request(body: Buffer): Promise<Response> {
    return this.#signedRequest("/mcp", body);
  }

  async #signedRequest(path: "/mcp" | "/run/end", body: Buffer): Promise<Response> {
    const privateKey = this.#privateKey;
    if (!privateKey) throw new Error("mail gateway session is closed");
    const timestamp = this.#now().toISOString();
    const nonce = randomUUID();
    const proof = signAgentRequest(privateKey, { method: "POST", path, body, timestamp, nonce });
    return this.#fetch(new URL(path, this.#baseUrl), {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Agent ${this.#token}`,
        "content-type": "application/json",
        "x-agent-nonce": nonce,
        "x-agent-proof": proof,
        "x-agent-timestamp": timestamp,
      },
      body: new Uint8Array(body),
    });
  }

  async close(): Promise<void> {
    if (!this.#privateKey) return;
    try {
      const response = await this.#signedRequest("/run/end", Buffer.alloc(0));
      if (!response.ok) throw new Error("mail gateway run cleanup failed");
    } finally {
      this.#privateKey = undefined;
    }
  }
}
