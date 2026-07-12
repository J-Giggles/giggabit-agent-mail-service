import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { TailnetIdentityVerifier } from "./mcp-handler.js";

const execFileAsync = promisify(execFile);
const TAILSCALE_IPV6_PREFIX = "fd7a:115c:a1e0:";
const NODE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{1,127}$/;

export interface TailnetNodeIdentity {
  nodeId: string;
  nodeName: string;
}

export interface TailscaleCliVerifierOptions {
  lookup?: (peerIp: string) => Promise<string>;
  lookupLocal?: () => Promise<string>;
}

function normalizePeerIp(peerIp: string): string {
  return peerIp.replace(/^\[|\]$/g, "").replace(/^::ffff:/, "").split("%")[0] ?? "";
}

function isTailnetIp(peerIp: string): boolean {
  if (peerIp.toLowerCase().startsWith(TAILSCALE_IPV6_PREFIX)) {
    return true;
  }
  const octets = peerIp.split(".").map((part) => Number.parseInt(part, 10));
  return (
    octets.length === 4 &&
    octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255) &&
    octets[0] === 100 &&
    octets[1] !== undefined &&
    octets[1] >= 64 &&
    octets[1] <= 127
  );
}

async function lookupWithCli(peerIp: string): Promise<string> {
  const { stdout } = await execFileAsync("tailscale", ["whois", "--json", peerIp], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 5_000,
  });
  return stdout;
}

async function lookupLocalWithCli(): Promise<string> {
  const { stdout } = await execFileAsync("tailscale", ["status", "--json"], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 5_000,
  });
  return stdout;
}

function nodeIdentity(node: unknown): TailnetNodeIdentity {
  if (!node || typeof node !== "object") throw new Error("tailnet node identity could not be verified");
  const fields = node as { StableID?: unknown; ID?: unknown; Name?: unknown; DNSName?: unknown };
  const nodeId = typeof fields.StableID === "string" ? fields.StableID : fields.ID;
  if (typeof nodeId !== "string" || !NODE_ID_PATTERN.test(nodeId)) {
    throw new Error("tailnet peer stable identity is missing");
  }
  const rawName = typeof fields.Name === "string" ? fields.Name : fields.DNSName;
  const nodeName = typeof rawName === "string" ? rawName.replace(/\.$/, "") : "tailnet-node";
  return { nodeId, nodeName };
}

export class TailscaleCliVerifier implements TailnetIdentityVerifier {
  readonly #lookup: (peerIp: string) => Promise<string>;
  readonly #lookupLocal: () => Promise<string>;

  constructor(options: TailscaleCliVerifierOptions = {}) {
    this.#lookup = options.lookup ?? lookupWithCli;
    this.#lookupLocal = options.lookupLocal ?? lookupLocalWithCli;
  }

  async identify(rawPeerIp: string): Promise<TailnetNodeIdentity> {
    const peerIp = normalizePeerIp(rawPeerIp);
    if (!isTailnetIp(peerIp)) {
      throw new Error("request did not originate from a tailnet peer");
    }

    let value: unknown;
    try {
      value = JSON.parse(await this.#lookup(peerIp));
    } catch {
      throw new Error("tailnet peer identity could not be verified");
    }
    if (!value || typeof value !== "object") {
      throw new Error("tailnet peer identity could not be verified");
    }
    return nodeIdentity((value as { Node?: unknown }).Node);
  }

  async identifyLocal(): Promise<TailnetNodeIdentity> {
    let value: unknown;
    try {
      value = JSON.parse(await this.#lookupLocal());
    } catch {
      throw new Error("local tailnet identity could not be verified");
    }
    if (!value || typeof value !== "object") throw new Error("local tailnet identity could not be verified");
    return nodeIdentity((value as { Self?: unknown }).Self);
  }
}
