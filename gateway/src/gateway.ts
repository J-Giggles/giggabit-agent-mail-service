import {
  constants,
  createCipheriv,
  createPublicKey,
  publicEncrypt,
  randomBytes,
  randomUUID,
} from "node:crypto";

import { MailCircuitBreaker } from "./circuit-breaker.js";
import type { AttachmentInspector } from "./attachment-inspector.js";
import type { AgentPrincipal } from "./identity.js";
import type { MailMessageDetail, MailMessageSummary, MailboxProvider } from "./provider.js";
import type { AttachmentQuarantine } from "./quarantine.js";

const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 100;

type ToolArguments = Record<string, unknown>;

interface MagicLinkClaim {
  attemptId: string;
  claimId: string;
  expiresAt: string;
  folder: string;
  grantId: string;
  messageRef: string;
  runId: string;
}

export interface MagicLinkPolicyRule {
  grantId: string;
  expectedSenders: string[];
  expectedHostnames: string[];
}

export interface MagicLinkPolicy {
  rules: MagicLinkPolicyRule[];
}

export interface GatewayAuditEvent {
  occurredAt: string;
  runId: string;
  nodeId: string;
  grantId: string;
  action: string;
  targetRef?: string;
}

export interface HostMailGatewayOptions {
  providers: MailboxProvider[];
  audit: (event: GatewayAuditEvent) => void | Promise<void>;
  circuitBreaker?: MailCircuitBreaker;
  quarantine?: AttachmentQuarantine;
  attachmentInspector?: AttachmentInspector;
  magicLinkPolicy?: MagicLinkPolicy;
  now?: () => Date;
}

function requiredString(input: ToolArguments, field: string): string {
  const value = input[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required`);
  }
  return value;
}

function optionalString(input: ToolArguments, field: string, fallback: string): string {
  const value = input[field];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }
  return value;
}

function searchLimit(input: ToolArguments): number {
  const value = input.limit ?? DEFAULT_SEARCH_LIMIT;
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > MAX_SEARCH_LIMIT) {
    throw new Error(`limit must be between 1 and ${MAX_SEARCH_LIMIT}`);
  }
  return value as number;
}

function stringArray(input: ToolArguments, field: string, required: boolean): string[] {
  const value = input[field];
  if (value === undefined && !required) {
    return [];
  }
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${field} must be a non-empty string array`);
  }
  return value as string[];
}

function requiredDate(input: ToolArguments, field: string): Date {
  const value = requiredString(input, field);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${field} must be an ISO timestamp`);
  return date;
}

function sameAddress(actual: string, expected: string): boolean {
  const normalized = actual.trim().toLowerCase();
  const target = expected.trim().toLowerCase();
  return normalized === target || normalized.endsWith(`<${target}>`);
}

function decodeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function oneExpectedHttpsLink(text: string, html: string | undefined, expectedHostname: string): string {
  const textLinks = text.match(/https:\/\/[^\s<>"']+/g) ?? [];
  const htmlLinks = html
    ? [...html.matchAll(/href\s*=\s*(["'])(.*?)\1/gi)].map((match) => decodeHtmlAttribute(match[2] ?? ""))
    : [];
  const matches = [...new Set([...textLinks, ...htmlLinks])];
  const accepted = matches.filter((candidate) => {
    try {
      const url = new URL(candidate);
      return url.protocol === "https:" && url.hostname.toLowerCase() === expectedHostname.toLowerCase();
    } catch {
      return false;
    }
  });
  if (accepted.length !== 1 || matches.length !== 1) throw new Error("magic link message is ambiguous or invalid");
  return accepted[0]!;
}

function serializeSummary(message: MailMessageSummary): Record<string, unknown> {
  return {
    message_ref: message.messageRef,
    folder: message.folder,
    subject: message.subject,
    from: message.from,
    to: message.to,
    received_at: message.receivedAt,
    snippet: message.snippet,
  };
}

function serializeDetail(message: MailMessageDetail): Record<string, unknown> {
  return {
    message_ref: message.messageRef,
    folder: message.folder,
    subject: message.subject,
    from: message.from,
    to: message.to,
    cc: message.cc ?? [],
    received_at: message.receivedAt,
    message_id: message.messageId,
    in_reply_to: message.inReplyTo,
    references: message.references ?? [],
    text: message.text,
    attachments: message.attachments.map((attachment) => ({
      attachment_ref: attachment.attachmentRef,
      filename: attachment.filename,
      content_type: attachment.contentType,
      size: attachment.size,
    })),
  };
}

export class HostMailGateway {
  readonly #audit: HostMailGatewayOptions["audit"];
  readonly #attachmentInspector: AttachmentInspector | undefined;
  readonly #circuitBreaker: MailCircuitBreaker;
  readonly #magicLinkClaims = new Map<string, MagicLinkClaim>();
  readonly #magicLinkPolicy = new Map<string, { expectedSenders: Set<string>; expectedHostnames: Set<string> }>();
  readonly #now: () => Date;
  readonly #providers: Map<string, MailboxProvider>;
  readonly #quarantine: AttachmentQuarantine | undefined;

  constructor(options: HostMailGatewayOptions) {
    this.#providers = new Map();
    for (const provider of options.providers) {
      if (this.#providers.has(provider.grant.grantId)) {
        throw new Error(`duplicate mailbox grant: ${provider.grant.grantId}`);
      }
      this.#providers.set(provider.grant.grantId, provider);
    }
    this.#audit = options.audit;
    this.#attachmentInspector = options.attachmentInspector;
    this.#circuitBreaker = options.circuitBreaker ?? new MailCircuitBreaker();
    this.#quarantine = options.quarantine;
    this.#now = options.now ?? (() => new Date());
    for (const rule of options.magicLinkPolicy?.rules ?? []) {
      const grantId = rule.grantId.trim();
      const expectedSenders = new Set(rule.expectedSenders.map((value) => value.trim().toLowerCase()).filter(Boolean));
      const expectedHostnames = new Set(
        rule.expectedHostnames.map((value) => value.trim().toLowerCase()).filter(Boolean),
      );
      if (!grantId || expectedSenders.size === 0 || expectedHostnames.size === 0) {
        throw new Error("magic link policy rule is invalid");
      }
      if (this.#magicLinkPolicy.has(grantId)) throw new Error("duplicate magic link policy grant");
      this.#magicLinkPolicy.set(grantId, { expectedSenders, expectedHostnames });
    }
  }

  get magicLinkEnabled(): boolean {
    return this.#magicLinkPolicy.size > 0;
  }

  async callTool(principal: AgentPrincipal, tool: string, input: ToolArguments): Promise<Record<string, unknown>> {
    const grantId = requiredString(input, "grant_id");
    const provider = this.#providers.get(grantId);
    if (!provider) {
      throw new Error("mailbox grant was not found");
    }

    if (tool === "folders") {
      if (input.action !== "list") {
        throw new Error("unsupported folders action");
      }
      const folders = await provider.listFolders();
      await this.#record(principal, grantId, "folders.list");
      return { action: "list", grant_id: grantId, folders };
    }

    if (tool === "messages") {
      if (input.action === "search") {
        const folder = optionalString(input, "folder", "INBOX");
        const query = optionalString(input, "query", "UNSEEN");
        const messages = await provider.search({ folder, query, limit: searchLimit(input) });
        await this.#record(principal, grantId, "messages.search");
        return {
          action: "search",
          grant_id: grantId,
          trust: "untrusted_email_content",
          messages: messages.map(serializeSummary),
        };
      }
      if (input.action === "read") {
        const folder = optionalString(input, "folder", "INBOX");
        const messageRef = requiredString(input, "message_ref");
        const message = await provider.read({ folder, messageRef });
        await this.#record(principal, grantId, "messages.read", messageRef);
        return {
          action: "read",
          grant_id: grantId,
          trust: "untrusted_email_content",
          message: serializeDetail(message),
        };
      }
      if (input.action === "move") {
        if (!provider.move) {
          throw new Error("mailbox provider does not support moving messages");
        }
        const fromFolder = optionalString(input, "folder", "INBOX");
        const messageRef = requiredString(input, "message_ref");
        const result = await provider.move({
          messageRef,
          fromFolder,
          toFolder: requiredString(input, "destination"),
        });
        await this.#record(principal, grantId, "messages.move", messageRef);
        return {
          action: "move",
          grant_id: grantId,
          message_ref: result.messageRef,
          folder: result.folder,
        };
      }
      if (input.action === "trash") {
        if (!provider.trash) {
          throw new Error("mailbox provider does not support recoverable trash");
        }
        const folder = optionalString(input, "folder", "INBOX");
        const messageRef = requiredString(input, "message_ref");
        const result = await provider.trash({ folder, messageRef });
        await this.#record(principal, grantId, "messages.trash", messageRef);
        return {
          action: "trash",
          grant_id: grantId,
          message_ref: result.messageRef,
          folder: result.folder,
        };
      }
      throw new Error("unsupported messages action");
    }

    if (tool === "magic_link") {
      const policy = this.#magicLinkPolicy.get(grantId);
      if (!policy) throw new Error("magic link is not allowed by operator policy");
      if (input.action === "release") {
        const claimId = requiredString(input, "claim_id");
        const claim = this.#magicLinkClaims.get(claimId);
        if (!claim || claim.grantId !== grantId) throw new Error("magic link claim was not found");
        if (claim.runId !== principal.runId) throw new Error("magic link claim does not belong to this run");
        if (new Date(claim.expiresAt).getTime() <= this.#now().getTime()) {
          this.#magicLinkClaims.delete(claimId);
          throw new Error("magic link claim expired");
        }
        this.#magicLinkClaims.delete(claimId);
        await this.#record(principal, grantId, "magic_link.release", claimId);
        return { action: "release", grant_id: grantId, claim_id: claimId, released: true };
      }
      if (input.action === "consume") {
        const claimId = requiredString(input, "claim_id");
        const claim = this.#magicLinkClaims.get(claimId);
        if (!claim || claim.grantId !== grantId) throw new Error("magic link claim was not found");
        if (claim.runId !== principal.runId) throw new Error("magic link claim does not belong to this run");
        if (new Date(claim.expiresAt).getTime() <= this.#now().getTime()) {
          this.#magicLinkClaims.delete(claimId);
          throw new Error("magic link claim expired");
        }
        if (!provider.trash) throw new Error("mailbox provider does not support recoverable trash");
        await provider.trash({ folder: claim.folder, messageRef: claim.messageRef });
        this.#magicLinkClaims.delete(claimId);
        await this.#record(principal, grantId, "magic_link.consume", claimId);
        return { action: "consume", grant_id: grantId, claim_id: claimId, consumed: true };
      }
      if (input.action !== "claim") throw new Error("unsupported magic link action");
      const folder = optionalString(input, "folder", "INBOX");
      const attemptId = requiredString(input, "attempt_id");
      const requestTime = requiredDate(input, "request_time");
      const recipientAlias = requiredString(input, "recipient_alias");
      const expectedSender = requiredString(input, "expected_sender");
      const expectedHostname = requiredString(input, "expected_hostname");
      if (
        !policy.expectedSenders.has(expectedSender.trim().toLowerCase()) ||
        !policy.expectedHostnames.has(expectedHostname.trim().toLowerCase())
      ) {
        throw new Error("magic link is not allowed by operator policy");
      }
      const publicKey = createPublicKey(requiredString(input, "public_key"));
      if (
        publicKey.asymmetricKeyType !== "rsa" ||
        (publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
      ) {
        throw new Error("public_key must be RSA-2048 or stronger");
      }
      const candidates = (await provider.search({ folder, query: "ALL", limit: MAX_SEARCH_LIMIT })).filter(
        (message) =>
          new Date(message.receivedAt).getTime() >= requestTime.getTime() &&
          sameAddress(message.from, expectedSender) &&
          message.to.some((address) => sameAddress(address, recipientAlias)),
      );
      if (candidates.length !== 1) throw new Error("magic link message correlation failed");
      const message = await provider.read({ folder, messageRef: candidates[0]!.messageRef });
      if (
        new Date(message.receivedAt).getTime() < requestTime.getTime() ||
        !sameAddress(message.from, expectedSender) ||
        !message.to.some((address) => sameAddress(address, recipientAlias))
      ) {
        throw new Error("magic link message identity changed");
      }
      const currentTime = this.#now().getTime();
      for (const [existingClaimId, existingClaim] of this.#magicLinkClaims) {
        if (new Date(existingClaim.expiresAt).getTime() <= currentTime) {
          this.#magicLinkClaims.delete(existingClaimId);
        }
      }
      if (
        [...this.#magicLinkClaims.values()].some(
          (claim) => claim.grantId === grantId && claim.messageRef === message.messageRef,
        )
      ) {
        throw new Error("magic link message is already claimed");
      }
      const url = oneExpectedHttpsLink(message.text, message.html, expectedHostname);
      const contentKey = randomBytes(32);
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", contentKey, iv);
      const ciphertext = Buffer.concat([cipher.update(url, "utf8"), cipher.final()]);
      const encryptedKey = publicEncrypt(
        { key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
        contentKey,
      );
      const claimId = randomUUID();
      const expiresAt = new Date(currentTime + 5 * 60_000).toISOString();
      this.#magicLinkClaims.set(claimId, {
        attemptId,
        claimId,
        expiresAt,
        folder,
        grantId,
        messageRef: message.messageRef,
        runId: principal.runId,
      });
      await this.#record(principal, grantId, "magic_link.claim", claimId);
      return {
        action: "claim",
        grant_id: grantId,
        attempt_id: attemptId,
        claim_id: claimId,
        expires_at: expiresAt,
        algorithm: "RSA-OAEP-256+A256GCM",
        trust: "ephemeral_bearer_ciphertext",
        encrypted_key: encryptedKey.toString("base64"),
        iv: iv.toString("base64"),
        auth_tag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64"),
      };
    }

    if (tool === "attachments") {
      if (input.action === "download") {
        if (!provider.downloadAttachment || !this.#quarantine) {
          throw new Error("mailbox provider attachment quarantine is unavailable");
        }
        const folder = optionalString(input, "folder", "INBOX");
        const messageRef = requiredString(input, "message_ref");
        const attachmentRef = requiredString(input, "attachment_ref");
        const downloaded = await provider.downloadAttachment({ folder, messageRef, attachmentRef });
        let attachment;
        try {
          attachment = await this.#quarantine.store({
            runId: principal.runId,
            attachmentRef,
            filename: downloaded.filename,
            contentType: downloaded.contentType,
            content: downloaded.content,
          });
        } finally {
          downloaded.content.fill(0);
        }
        await this.#record(principal, grantId, "attachments.download", attachmentRef);
        return {
          action: "download",
          grant_id: grantId,
          attachment: {
            attachment_ref: attachment.attachment_ref,
            filename: attachment.filename,
            content_type: attachment.content_type,
            expires_at: attachment.expires_at,
            sandbox_required: true,
          },
        };
      }
      if (input.action === "inspect") {
        if (!this.#quarantine || !this.#attachmentInspector) throw new Error("sandboxed attachment inspection is unavailable");
        const attachmentRef = requiredString(input, "attachment_ref");
        const attachment = this.#quarantine.resolve(principal.runId, attachmentRef);
        const inspection = await this.#attachmentInspector.inspect(attachment.path);
        await this.#record(principal, grantId, "attachments.inspect", attachmentRef);
        return {
          action: "inspect",
          grant_id: grantId,
          trust: "untrusted_email_content",
          inspection: {
            content_type: inspection.contentType,
            ...(inspection.text === undefined ? {} : { text: inspection.text }),
          },
        };
      }
      throw new Error("unsupported attachments action");
    }

    if (tool === "send") {
      if (input.action === "draft") {
        if (!provider.createDraft) {
          throw new Error("mailbox provider does not support drafts");
        }
        const result = await provider.createDraft({
          to: stringArray(input, "to", true),
          cc: stringArray(input, "cc", false),
          bcc: stringArray(input, "bcc", false),
          subject: requiredString(input, "subject"),
          text: requiredString(input, "body"),
        });
        await this.#record(principal, grantId, "send.draft", result.draftRef);
        return {
          action: "draft",
          grant_id: grantId,
          draft_ref: result.draftRef,
          folder: result.folder,
        };
      }
      if (input.action !== "new" && input.action !== "reply") {
        throw new Error("unsupported send action");
      }
      const idempotencyKey = requiredString(input, "idempotency_key");
      const cc = stringArray(input, "cc", false);
      const bcc = stringArray(input, "bcc", false);
      const body = requiredString(input, "body");
      let to: string[];
      let replyToRef: string | undefined;
      let automaticResponse = false;
      let original:
        | Awaited<ReturnType<MailboxProvider["read"]>>
        | undefined;
      if (input.action === "reply") {
        replyToRef = requiredString(input, "message_ref");
        original = await provider.read({
          folder: optionalString(input, "folder", "INBOX"),
          messageRef: replyToRef,
        });
        automaticResponse = original.autoSubmitted === true;
        to = input.to === undefined ? [original.from] : stringArray(input, "to", true);
      } else {
        to = stringArray(input, "to", true);
      }
      const reservation = this.#circuitBreaker.reserve({
        grantId,
        idempotencyKey,
        recipientCount: to.length + cc.length + bcc.length,
        ...(replyToRef ? { replyToRef } : {}),
        ...(automaticResponse ? { automaticResponse: true } : {}),
        ...(provider.grant.outboundLimits ? { providerLimits: provider.grant.outboundLimits } : {}),
      });
      if (reservation.status === "duplicate") {
        return { ...reservation.result, deduplicated: true };
      }
      try {
        const result =
          input.action === "reply"
            ? await (() => {
                if (!provider.reply || !original || !replyToRef) {
                  throw new Error("mailbox provider does not support replying");
                }
                return provider.reply({
                  to,
                  cc,
                  bcc,
                  subject: optionalString(input, "subject", original.subject),
                  text: body,
                  folder: original.folder,
                  messageRef: replyToRef,
                  ...(original.messageId ? { inReplyTo: original.messageId } : {}),
                  references: original.references ?? (original.messageId ? [original.messageId] : []),
                });
              })()
            : await (() => {
                if (!provider.send) {
                  throw new Error("mailbox provider does not support sending");
                }
                return provider.send({
                  to,
                  cc,
                  bcc,
                  subject: requiredString(input, "subject"),
                  text: body,
                });
              })();
        const response = {
          action: input.action,
          grant_id: grantId,
          success: true,
          message_id: result.messageId,
          deduplicated: false,
        };
        this.#circuitBreaker.commit(grantId, idempotencyKey, response);
        await this.#record(principal, grantId, `send.${input.action}`, result.messageId);
        return response;
      } catch (error) {
        this.#circuitBreaker.abort(grantId, idempotencyKey);
        throw error;
      }
    }

    throw new Error("unsupported mail gateway tool");
  }

  async #record(principal: AgentPrincipal, grantId: string, action: string, targetRef?: string): Promise<void> {
    await this.#audit({
      occurredAt: this.#now().toISOString(),
      runId: principal.runId,
      nodeId: principal.nodeId,
      grantId,
      action,
      ...(targetRef ? { targetRef } : {}),
    });
  }
}
