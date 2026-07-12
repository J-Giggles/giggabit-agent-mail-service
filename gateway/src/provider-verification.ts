import { randomUUID } from "node:crypto";

import { HostMailGateway } from "./gateway.js";
import type { GatewayAuditEvent } from "./gateway.js";
import type { MailCircuitBreaker } from "./circuit-breaker.js";
import type { MailMessageDetail, MailboxProvider } from "./provider.js";

const TEST_FOLDER = "Agent Gateway Test";

export interface ProviderVerificationOptions {
  provider: MailboxProvider;
  testRecipient: string;
  pollAttempts?: number;
  pollIntervalMs?: number;
  circuitBreaker?: MailCircuitBreaker;
  audit?: (event: GatewayAuditEvent) => void | Promise<void>;
}

export interface ProviderVerificationResult {
  tag: string;
  searched: number;
  read: number;
  drafted: number;
  replied: number;
  moved: number;
  trashed: number;
  providerIdentifiers: string[];
}

function requireCapability<T>(value: T | undefined, name: string): T {
  if (!value) throw new Error(`provider verification requires ${name}`);
  return value;
}

function proveOwnership(message: MailMessageDetail, tag: string): void {
  if (!message.subject.includes(tag)) {
    throw new Error("provider verification refused to mutate a message it does not own");
  }
}

export class ProviderVerificationHarness {
  readonly #attempts: number;
  readonly #intervalMs: number;
  readonly #provider: MailboxProvider;
  readonly #testRecipient: string;
  readonly #circuitBreaker: MailCircuitBreaker | undefined;
  readonly #audit: NonNullable<ProviderVerificationOptions["audit"]>;

  constructor(options: ProviderVerificationOptions) {
    this.#provider = options.provider;
    this.#testRecipient = options.testRecipient;
    this.#attempts = options.pollAttempts ?? 30;
    this.#intervalMs = options.pollIntervalMs ?? 250;
    this.#circuitBreaker = options.circuitBreaker;
    this.#audit = options.audit ?? (() => undefined);
  }

  async run(): Promise<ProviderVerificationResult> {
    const ensureFolder = requireCapability(this.#provider.ensureFolder?.bind(this.#provider), "folder creation");
    const gateway = new HostMailGateway({
      providers: [this.#provider],
      audit: this.#audit,
      ...(this.#circuitBreaker ? { circuitBreaker: this.#circuitBreaker } : {}),
    });
    const principal = {
      tokenId: "provider-verification",
      runId: `verify-${randomUUID()}`,
      nodeId: "owner-admin",
      expiresAt: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
    };
    const grantId = this.#provider.grant.grantId;
    await ensureFolder(TEST_FOLDER);
    await ensureFolder("Drafts");
    await ensureFolder("Trash");

    const tag = `agent-gateway-test-${randomUUID()}`;
    const subject = `Synthetic provider verification ${tag}`;
    const sent = await gateway.callTool(principal, "send", {
      action: "new",
      grant_id: grantId,
      idempotency_key: `${tag}-send`,
      to: [this.#testRecipient],
      subject,
      body: "Synthetic test content.",
    });
    const providerIdentifiers = [String(sent.message_id)];
    const original = await this.#waitFor("INBOX", tag, 1);
    const originalDetail = await this.#provider.read({ folder: "INBOX", messageRef: original[0]!.messageRef });
    proveOwnership(originalDetail, tag);

    const draft = await gateway.callTool(principal, "send", {
      action: "draft",
      grant_id: grantId,
      to: [this.#testRecipient],
      subject: `Draft ${tag}`,
      body: "Synthetic draft content.",
    });
    const draftRef = String(draft.draft_ref);
    const draftFolder = String(draft.folder);
    providerIdentifiers.push(draftRef);
    const draftDetail = await this.#provider.read({ folder: draftFolder, messageRef: draftRef });
    proveOwnership(draftDetail, tag);
    const trashedDraft = await gateway.callTool(principal, "messages", {
      action: "trash",
      grant_id: grantId,
      folder: draftFolder,
      message_ref: draftRef,
    });
    providerIdentifiers.push(String(trashedDraft.message_ref));

    const replied = await gateway.callTool(principal, "send", {
      action: "reply",
      grant_id: grantId,
      idempotency_key: `${tag}-reply`,
      folder: originalDetail.folder,
      message_ref: originalDetail.messageRef,
      body: "Synthetic reply content.",
    });
    providerIdentifiers.push(String(replied.message_id));
    const inboxMessages = await this.#waitFor("INBOX", tag, 2);
    let moved = 0;
    let trashed = 1;
    let read = 1;
    for (const message of inboxMessages) {
      const detail = await this.#provider.read({ folder: "INBOX", messageRef: message.messageRef });
      read += 1;
      proveOwnership(detail, tag);
      const movedMessage = await gateway.callTool(principal, "messages", {
        action: "move",
        grant_id: grantId,
        folder: "INBOX",
        message_ref: detail.messageRef,
        destination: TEST_FOLDER,
      });
      providerIdentifiers.push(String(movedMessage.message_ref));
      moved += 1;
    }
    const movedMessages = await this.#waitFor(TEST_FOLDER, tag, inboxMessages.length);
    for (const message of movedMessages) {
      const detail = await this.#provider.read({ folder: TEST_FOLDER, messageRef: message.messageRef });
      read += 1;
      proveOwnership(detail, tag);
      const trashedMessage = await gateway.callTool(principal, "messages", {
        action: "trash",
        grant_id: grantId,
        folder: TEST_FOLDER,
        message_ref: detail.messageRef,
      });
      providerIdentifiers.push(String(trashedMessage.message_ref));
      trashed += 1;
    }
    return {
      tag,
      searched: inboxMessages.length + movedMessages.length,
      read,
      drafted: 1,
      replied: 1,
      moved,
      trashed,
      providerIdentifiers,
    };
  }

  async #waitFor(folder: string, tag: string, minimum: number) {
    for (let attempt = 0; attempt < this.#attempts; attempt += 1) {
      const messages = await this.#provider.search({ folder, query: `SUBJECT ${tag}`, limit: 100 });
      const owned = messages.filter((message) => message.subject.includes(tag));
      if (owned.length >= minimum) return owned;
      if (attempt + 1 < this.#attempts) await new Promise((resolve) => setTimeout(resolve, this.#intervalMs));
    }
    throw new Error("synthetic provider verification message did not arrive");
  }
}
