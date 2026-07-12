import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

import type { HostMailGateway } from "./gateway.js";
import type { AgentIdentityAuthority, AgentPrincipal } from "./identity.js";
import { packageVersion } from "./package-version.js";

export interface TailnetIdentityVerifier {
  identify(peerIp: string): Promise<{ nodeId: string }>;
}

export interface GatewayMcpHandlerOptions {
  authority: AgentIdentityAuthority;
  gateway: HostMailGateway;
  tailnet: TailnetIdentityVerifier;
}

const commonInputSchema = {
  action: z.string(),
  grant_id: z.string().min(1),
  folder: z.string().optional(),
  message_ref: z.string().optional(),
  attachment_ref: z.string().optional(),
  claim_id: z.string().optional(),
  destination: z.string().optional(),
  query: z.string().optional(),
  limit: z.number().int().positive().max(100).optional(),
  idempotency_key: z.string().optional(),
  to: z.array(z.string()).optional(),
  cc: z.array(z.string()).optional(),
  bcc: z.array(z.string()).optional(),
  subject: z.string().optional(),
  body: z.string().optional(),
  attempt_id: z.string().optional(),
  request_time: z.string().optional(),
  recipient_alias: z.string().optional(),
  expected_sender: z.string().optional(),
  expected_hostname: z.string().optional(),
  public_key: z.string().optional(),
};

function unauthorized(): Response {
  return Response.json(
    { jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null },
    { status: 401, headers: { "www-authenticate": "Agent" } },
  );
}

function registerGatewayTools(server: McpServer, gateway: HostMailGateway, principal: AgentPrincipal): void {
  const register = (
    name: "attachments" | "folders" | "magic_link" | "messages" | "send",
    description: string,
    readOnly: boolean,
  ) => {
    server.registerTool(
      name,
      {
        description,
        inputSchema: commonInputSchema,
        annotations: {
          readOnlyHint: readOnly,
          destructiveHint: name === "magic_link" || name === "messages" || name === "send",
          idempotentHint: name !== "magic_link" && name !== "send",
          openWorldHint: name === "send",
        },
      },
      async (input) => {
        try {
          const result = await gateway.callTool(principal, name, input as Record<string, unknown>);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
            structuredContent: result,
          };
        } catch {
          return {
            content: [{ type: "text" as const, text: "Mail gateway operation failed." }],
            isError: true,
          };
        }
      },
    );
  };

  register("folders", "List folders for an explicitly connected mailbox grant.", true);
  register("messages", "Search, read, move, and recoverably trash mailbox messages.", false);
  if (gateway.magicLinkEnabled) {
    register(
      "magic_link",
      "Claim, release, and consume an expected magic-link message without exposing its bearer URL as plaintext.",
      false,
    );
  }
  register(
    "attachments",
    "Quarantine and scan an attachment, then inspect eligible text only inside the networkless read-only sandbox.",
    true,
  );
  register("send", "Create drafts, send new messages, and reply with circuit-breaker protection.", false);
}

export class GatewayMcpHandler {
  readonly #authority: AgentIdentityAuthority;
  readonly #gateway: HostMailGateway;
  readonly #tailnet: TailnetIdentityVerifier;

  constructor(options: GatewayMcpHandlerOptions) {
    this.#authority = options.authority;
    this.#gateway = options.gateway;
    this.#tailnet = options.tailnet;
  }

  async handle(request: Request, peerIp: string): Promise<Response> {
    const authorization = request.headers.get("authorization");
    const proof = request.headers.get("x-agent-proof");
    const timestamp = request.headers.get("x-agent-timestamp");
    const nonce = request.headers.get("x-agent-nonce");
    if (!authorization?.startsWith("Agent ") || !proof || !timestamp || !nonce) {
      return unauthorized();
    }

    const body = request.method === "POST" ? Buffer.from(await request.clone().arrayBuffer()) : Buffer.alloc(0);
    let principal: AgentPrincipal;
    try {
      const tailnet = await this.#tailnet.identify(peerIp);
      principal = this.#authority.authorize({
        token: authorization.slice("Agent ".length),
        proof,
        tailnetNodeId: tailnet.nodeId,
        request: {
          method: request.method,
          path: new URL(request.url).pathname,
          body,
          timestamp,
          nonce,
        },
      });
    } catch {
      return unauthorized();
    }

    const server = new McpServer({ name: "giggabit-agent-mail-service", version: packageVersion });
    registerGatewayTools(server, this.#gateway, principal);
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      return await transport.handleRequest(request);
    } finally {
      await transport.close();
      await server.close();
    }
  }
}
