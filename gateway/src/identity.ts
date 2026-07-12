import {
  createHash,
  createHmac,
  createPublicKey,
  randomUUID,
  sign,
  timingSafeEqual,
  verify,
  type KeyObject,
} from "node:crypto";

const TOKEN_VERSION = "v1";
const DEFAULT_MAX_LIFETIME_MS = 8 * 60 * 60 * 1_000;
const DEFAULT_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

export interface AgentRequest {
  method: string;
  path: string;
  body: Buffer;
  timestamp: string;
  nonce: string;
}

interface AgentIdentityTokenPayload {
  version: 1;
  tokenId: string;
  runId: string;
  nodeId: string;
  publicKey: string;
  issuedAt: number;
  expiresAt: number;
}

export interface AgentPrincipal {
  tokenId: string;
  runId: string;
  nodeId: string;
  expiresAt: string;
}

export interface AgentIdentityAuthorityOptions {
  signingKey: Buffer;
  now?: () => Date;
  maxLifetimeMs?: number;
  clockSkewMs?: number;
}

interface IssueAgentIdentityInput {
  runId: string;
  nodeId: string;
  publicKey: KeyObject;
  lifetimeMs: number;
}

interface AuthorizeAgentRequestInput {
  token: string;
  proof: string;
  tailnetNodeId: string;
  request: AgentRequest;
}

function assertIdentifier(label: string, value: string): void {
  if (!ID_PATTERN.test(value)) {
    throw new Error(`${label} is invalid`);
  }
}

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function canonicalRequest(request: AgentRequest): Buffer {
  const bodyHash = createHash("sha256").update(request.body).digest("base64url");
  return Buffer.from(
    [request.method.toUpperCase(), request.path, request.timestamp, request.nonce, bodyHash].join("\n"),
    "utf8",
  );
}

function parseTimestamp(timestamp: string): number {
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds)) {
    throw new Error("agent request timestamp is invalid");
  }
  return milliseconds;
}

function parsePayload(encodedPayload: string): AgentIdentityTokenPayload {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch {
    throw new Error("agent identity token is malformed");
  }
  if (!value || typeof value !== "object") {
    throw new Error("agent identity token is malformed");
  }
  const payload = value as Partial<AgentIdentityTokenPayload>;
  if (
    payload.version !== 1 ||
    typeof payload.tokenId !== "string" ||
    typeof payload.runId !== "string" ||
    typeof payload.nodeId !== "string" ||
    typeof payload.publicKey !== "string" ||
    typeof payload.issuedAt !== "number" ||
    typeof payload.expiresAt !== "number"
  ) {
    throw new Error("agent identity token is malformed");
  }
  return payload as AgentIdentityTokenPayload;
}

export function signAgentRequest(privateKey: KeyObject, request: AgentRequest): string {
  return sign(null, canonicalRequest(request), privateKey).toString("base64url");
}

export class AgentIdentityAuthority {
  readonly #clockSkewMs: number;
  readonly #maxLifetimeMs: number;
  readonly #now: () => Date;
  readonly #revokedRunIds = new Set<string>();
  readonly #signingKey: Buffer;
  readonly #usedNonces = new Map<string, Set<string>>();

  constructor(options: AgentIdentityAuthorityOptions) {
    if (options.signingKey.length < 32) {
      throw new Error("agent identity signing key must contain at least 32 bytes");
    }
    this.#signingKey = Buffer.from(options.signingKey);
    this.#now = options.now ?? (() => new Date());
    this.#maxLifetimeMs = options.maxLifetimeMs ?? DEFAULT_MAX_LIFETIME_MS;
    this.#clockSkewMs = options.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS;
  }

  issue(input: IssueAgentIdentityInput): string {
    assertIdentifier("runId", input.runId);
    assertIdentifier("nodeId", input.nodeId);
    if (!Number.isSafeInteger(input.lifetimeMs) || input.lifetimeMs <= 0 || input.lifetimeMs > this.#maxLifetimeMs) {
      throw new Error("agent identity lifetime is invalid");
    }
    if (input.publicKey.asymmetricKeyType !== "ed25519") {
      throw new Error("agent identity proof key must be Ed25519");
    }

    const issuedAt = this.#now().getTime();
    const payload: AgentIdentityTokenPayload = {
      version: 1,
      tokenId: randomUUID(),
      runId: input.runId,
      nodeId: input.nodeId,
      publicKey: input.publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
      issuedAt,
      expiresAt: issuedAt + input.lifetimeMs,
    };
    const encodedPayload = encodeJson(payload);
    const mac = createHmac("sha256", this.#signingKey)
      .update(`${TOKEN_VERSION}.${encodedPayload}`)
      .digest("base64url");
    return `${TOKEN_VERSION}.${encodedPayload}.${mac}`;
  }

  authorize(input: AuthorizeAgentRequestInput): AgentPrincipal {
    const parts = input.token.split(".");
    if (parts.length !== 3 || parts[0] !== TOKEN_VERSION || !parts[1] || !parts[2]) {
      throw new Error("agent identity token is malformed");
    }
    const expectedMac = createHmac("sha256", this.#signingKey)
      .update(`${TOKEN_VERSION}.${parts[1]}`)
      .digest();
    let providedMac: Buffer;
    try {
      providedMac = Buffer.from(parts[2], "base64url");
    } catch {
      throw new Error("agent identity token signature is invalid");
    }
    if (providedMac.length !== expectedMac.length || !timingSafeEqual(providedMac, expectedMac)) {
      throw new Error("agent identity token signature is invalid");
    }

    const payload = parsePayload(parts[1]);
    const now = this.#now().getTime();
    if (payload.expiresAt <= now || payload.issuedAt > now + this.#clockSkewMs) {
      throw new Error("agent identity token is expired");
    }
    if (this.#revokedRunIds.has(payload.runId)) {
      throw new Error("agent identity run is revoked");
    }
    if (payload.nodeId !== input.tailnetNodeId) {
      throw new Error("agent identity is bound to a different tailnet node");
    }

    const requestTime = parseTimestamp(input.request.timestamp);
    if (Math.abs(now - requestTime) > this.#clockSkewMs) {
      throw new Error("agent request timestamp is outside the accepted window");
    }
    if (!ID_PATTERN.test(input.request.nonce)) {
      throw new Error("agent request nonce is invalid");
    }

    const publicKey = createPublicKey({
      key: Buffer.from(payload.publicKey, "base64url"),
      format: "der",
      type: "spki",
    });
    const validProof = verify(null, canonicalRequest(input.request), publicKey, Buffer.from(input.proof, "base64url"));
    if (!validProof) {
      throw new Error("agent request proof is invalid");
    }

    const nonces = this.#usedNonces.get(payload.tokenId) ?? new Set<string>();
    if (nonces.has(input.request.nonce)) {
      throw new Error("agent request replay was rejected");
    }
    nonces.add(input.request.nonce);
    this.#usedNonces.set(payload.tokenId, nonces);

    return {
      tokenId: payload.tokenId,
      runId: payload.runId,
      nodeId: payload.nodeId,
      expiresAt: new Date(payload.expiresAt).toISOString(),
    };
  }

  revoke(runId: string): void {
    assertIdentifier("runId", runId);
    this.#revokedRunIds.add(runId);
  }
}
