import type { AttachmentQuarantine } from "./quarantine.js";
import type { AgentIdentityAuthority } from "./identity.js";
import type { TailnetIdentityVerifier } from "./mcp-handler.js";

export interface AgentRunEndHandlerOptions {
  authority: AgentIdentityAuthority;
  tailnet: TailnetIdentityVerifier;
  quarantine: Pick<AttachmentQuarantine, "cleanupRun">;
}

function unauthorized(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401, headers: { "www-authenticate": "Agent" } });
}

export class AgentRunEndHandler {
  readonly #authority: AgentIdentityAuthority;
  readonly #quarantine: AgentRunEndHandlerOptions["quarantine"];
  readonly #tailnet: TailnetIdentityVerifier;

  constructor(options: AgentRunEndHandlerOptions) {
    this.#authority = options.authority;
    this.#quarantine = options.quarantine;
    this.#tailnet = options.tailnet;
  }

  async handle(request: Request, peerIp: string): Promise<Response> {
    const authorization = request.headers.get("authorization");
    const proof = request.headers.get("x-agent-proof");
    const timestamp = request.headers.get("x-agent-timestamp");
    const nonce = request.headers.get("x-agent-nonce");
    if (!authorization?.startsWith("Agent ") || !proof || !timestamp || !nonce) return unauthorized();
    const body = Buffer.from(await request.clone().arrayBuffer());
    let runId: string;
    try {
      const tailnet = await this.#tailnet.identify(peerIp);
      runId = this.#authority.authorize({
        token: authorization.slice("Agent ".length),
        proof,
        tailnetNodeId: tailnet.nodeId,
        request: { method: request.method, path: new URL(request.url).pathname, body, timestamp, nonce },
      }).runId;
    } catch {
      return unauthorized();
    }
    try {
      await this.#quarantine.cleanupRun(runId);
      return new Response(null, { status: 204 });
    } finally {
      this.#authority.revoke(runId);
    }
  }
}
