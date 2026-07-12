import { createPublicKey } from "node:crypto";

import type { AgentIdentityAuthority } from "./identity.js";
const DEFAULT_LIFETIME_MS = 8 * 60 * 60 * 1_000;

export interface LocalNodeIdentityProvider {
  identifyLocal(): Promise<{ nodeId: string }>;
}

export interface AgentIdentityRegistrationHandlerOptions {
  authority: AgentIdentityAuthority;
  nodeIdentity: LocalNodeIdentityProvider;
}

function registrationError(): Response {
  return Response.json({ error: "identity_registration_failed" }, { status: 401 });
}

export class AgentIdentityRegistrationHandler {
  readonly #authority: AgentIdentityAuthority;
  readonly #nodeIdentity: LocalNodeIdentityProvider;

  constructor(options: AgentIdentityRegistrationHandlerOptions) {
    this.#authority = options.authority;
    this.#nodeIdentity = options.nodeIdentity;
  }

  async handle(request: Request): Promise<Response> {
    try {
      const node = await this.#nodeIdentity.identifyLocal();
      const value = (await request.json()) as Record<string, unknown>;
      if (
        typeof value.run_id !== "string" ||
        typeof value.public_key !== "string" ||
        (value.lifetime_ms !== undefined && typeof value.lifetime_ms !== "number")
      ) {
        return registrationError();
      }
      const publicKey = createPublicKey({
        key: Buffer.from(value.public_key, "base64url"),
        format: "der",
        type: "spki",
      });
      const token = this.#authority.issue({
        runId: value.run_id,
        nodeId: node.nodeId,
        publicKey,
        lifetimeMs: value.lifetime_ms ?? DEFAULT_LIFETIME_MS,
      });
      return Response.json(
        { token, node_id: node.nodeId },
        { headers: { "cache-control": "no-store" } },
      );
    } catch {
      return registrationError();
    }
  }
}
