import { ImapFlow, type FetchMessageObject, type ListResponse, type SearchObject } from "imapflow";
import { simpleParser, type AddressObject } from "mailparser";
import { createTransport } from "nodemailer";

import type {
  DownloadAttachmentInput,
  DownloadAttachmentResult,
  DraftMailResult,
  MailFolder,
  MailMessageDetail,
  MailMessageSummary,
  MailboxGrantDescriptor,
  MailboxProvider,
  MoveMailInput,
  MoveMailResult,
  ReadMailInput,
  ReplyMailInput,
  SearchMailInput,
  SendMailInput,
  SendMailResult,
} from "./provider.js";

const MESSAGE_REF_PREFIX = "imap1:";
const ATTACHMENT_REF_PREFIX = "imap-att1:";

export interface MailServerEndpoint {
  host: string;
  port: number;
  secure: boolean;
}

export interface MailboxConnection {
  mailboxAddress: string;
  username: string;
  password?: string;
  accessToken?: string;
  imap: MailServerEndpoint;
  smtp: MailServerEndpoint;
}

export interface MailboxConnectionSource {
  getConnection(grantId: string): Promise<MailboxConnection>;
}

export interface ImapSmtpProviderOptions {
  grant: MailboxGrantDescriptor;
  connections: MailboxConnectionSource;
}

interface MessageReferencePayload {
  version: 1;
  folder: string;
  uidValidity: string;
  uid: number;
}

interface AttachmentReferencePayload {
  version: 1;
  messageRef: string;
  index: number;
}

function encodeReference(prefix: string, value: unknown): string {
  return `${prefix}${Buffer.from(JSON.stringify(value), "utf8").toString("base64url")}`;
}

function decodeReference<T>(prefix: string, value: string): T {
  if (!value.startsWith(prefix)) {
    throw new Error("mail provider reference is invalid");
  }
  try {
    return JSON.parse(Buffer.from(value.slice(prefix.length), "base64url").toString("utf8")) as T;
  } catch {
    throw new Error("mail provider reference is invalid");
  }
}

function messageReference(folder: string, uidValidity: bigint, uid: number): string {
  return encodeReference(MESSAGE_REF_PREFIX, { version: 1, folder, uidValidity: String(uidValidity), uid });
}

function parseMessageReference(value: string, expectedFolder: string): MessageReferencePayload {
  const parsed = decodeReference<Partial<MessageReferencePayload>>(MESSAGE_REF_PREFIX, value);
  if (
    parsed.version !== 1 ||
    parsed.folder !== expectedFolder ||
    typeof parsed.uidValidity !== "string" ||
    typeof parsed.uid !== "number" ||
    !Number.isSafeInteger(parsed.uid) ||
    parsed.uid <= 0
  ) {
    throw new Error("mail provider reference is invalid for this folder");
  }
  return parsed as MessageReferencePayload;
}

function attachmentReference(messageRef: string, index: number): string {
  return encodeReference(ATTACHMENT_REF_PREFIX, { version: 1, messageRef, index });
}

function parseAttachmentReference(value: string, messageRef: string): AttachmentReferencePayload {
  const parsed = decodeReference<Partial<AttachmentReferencePayload>>(ATTACHMENT_REF_PREFIX, value);
  if (
    parsed.version !== 1 ||
    parsed.messageRef !== messageRef ||
    typeof parsed.index !== "number" ||
    !Number.isSafeInteger(parsed.index) ||
    parsed.index < 0
  ) {
    throw new Error("attachment reference is invalid for this message");
  }
  return parsed as AttachmentReferencePayload;
}

function formatAddress(value: AddressObject | AddressObject[] | undefined): string {
  if (Array.isArray(value)) return value.map((item) => item.text).filter(Boolean).join(", ");
  return value?.text ?? "";
}

function folderRole(folder: ListResponse): MailFolder["role"] {
  switch (folder.specialUse) {
    case "\\Archive":
    case "\\All":
      return "archive";
    case "\\Drafts":
      return "drafts";
    case "\\Inbox":
      return "inbox";
    case "\\Junk":
      return "spam";
    case "\\Sent":
      return "sent";
    case "\\Trash":
      return "trash";
    default:
      return folder.path.toUpperCase() === "INBOX" ? "inbox" : undefined;
  }
}

function searchCriteria(query: string): SearchObject {
  const trimmed = query.trim();
  if (!trimmed || trimmed === "*") return { all: true };
  const upper = trimmed.toUpperCase();
  if (upper === "ALL") return { all: true };
  if (upper === "UNSEEN" || upper === "UNREAD") return { seen: false };
  if (upper === "SEEN" || upper === "READ") return { seen: true };
  if (upper === "FLAGGED" || upper === "STARRED") return { flagged: true };
  for (const [prefix, key] of [
    ["FROM ", "from"],
    ["TO ", "to"],
    ["SUBJECT ", "subject"],
    ["TEXT ", "text"],
  ] as const) {
    if (upper.startsWith(prefix)) return { [key]: trimmed.slice(prefix.length).trim() };
  }
  return { text: trimmed };
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function createImapClient(connection: MailboxConnection): ImapFlow {
  const auth = connection.accessToken
    ? { user: connection.username, accessToken: connection.accessToken }
    : { user: connection.username, pass: connection.password ?? "" };
  return new ImapFlow({
    host: connection.imap.host,
    port: connection.imap.port,
    secure: connection.imap.secure,
    ...(!connection.imap.secure ? { doSTARTTLS: !isLoopbackHost(connection.imap.host) } : {}),
    auth,
    logger: false,
  });
}

function createSmtpTransport(connection: MailboxConnection) {
  const implicitTls = connection.smtp.secure || connection.smtp.port === 465;
  const auth = connection.accessToken
    ? { type: "OAuth2" as const, user: connection.username, accessToken: connection.accessToken }
    : { user: connection.username, pass: connection.password ?? "" };
  return createTransport({
    host: connection.smtp.host,
    port: connection.smtp.port,
    secure: implicitTls,
    requireTLS: !implicitTls && !isLoopbackHost(connection.smtp.host),
    auth,
  });
}

async function composeRaw(connection: MailboxConnection, input: SendMailInput, headers: Record<string, string> = {}): Promise<Buffer> {
  const transport = createTransport({ streamTransport: true, buffer: true, newline: "unix" });
  const result = await transport.sendMail({
    from: connection.mailboxAddress,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject,
    text: input.text,
    headers,
  });
  transport.close();
  if (Buffer.isBuffer(result.message)) return result.message;
  if (typeof result.message === "string") return Buffer.from(result.message);
  const chunks: Buffer[] = [];
  for await (const chunk of result.message) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function findFolder(client: ImapFlow, role: MailFolder["role"], fallback: string): Promise<string> {
  const folders = await client.list();
  return folders.find((folder) => folderRole(folder) === role)?.path ?? fallback;
}

function currentUidValidity(client: ImapFlow): bigint {
  if (!client.mailbox) throw new Error("mailbox is not open");
  return client.mailbox.uidValidity;
}

export interface AutomaticResponseHeaders {
  autoSubmitted?: unknown;
  precedence?: unknown;
  listId?: unknown;
  returnPath?: unknown;
  xAutoReply?: unknown;
  xAutoRespond?: unknown;
  from?: string;
}

export function isAutomaticResponse(headers: AutomaticResponseHeaders): boolean {
  const autoSubmitted = typeof headers.autoSubmitted === "string" ? headers.autoSubmitted.trim() : "";
  const precedence = typeof headers.precedence === "string" ? headers.precedence.trim() : "";
  const returnPath = typeof headers.returnPath === "string" ? headers.returnPath.replaceAll(" ", "") : "";
  return (
    (Boolean(autoSubmitted) && autoSubmitted.toLowerCase() !== "no") ||
    /^(bulk|junk|list)$/i.test(precedence) ||
    headers.listId !== undefined ||
    headers.xAutoReply !== undefined ||
    headers.xAutoRespond !== undefined ||
    returnPath === "<>" ||
    /(^|[<\s])(mailer-daemon|postmaster)@/i.test(headers.from ?? "")
  );
}

async function fetchSource(client: ImapFlow, reference: MessageReferencePayload): Promise<FetchMessageObject> {
  if (currentUidValidity(client).toString() !== reference.uidValidity) {
    throw new Error("message reference expired because the mailbox identity changed");
  }
  const message = await client.fetchOne(reference.uid, { source: true, flags: true }, { uid: true });
  if (!message || !message.source) throw new Error("message was not found");
  return message;
}

export class ImapSmtpProvider implements MailboxProvider {
  readonly #connections: MailboxConnectionSource;
  readonly grant: MailboxGrantDescriptor;

  constructor(options: ImapSmtpProviderOptions) {
    this.grant = options.grant;
    this.#connections = options.connections;
  }

  async listFolders(): Promise<MailFolder[]> {
    return this.#withImap(async (client) =>
      (await client.list()).map((folder) => {
        const role = folderRole(folder);
        return { path: folder.path, name: folder.name, ...(role ? { role } : {}) };
      }),
    );
  }

  async ensureFolder(folder: string): Promise<void> {
    if (!folder.trim()) throw new Error("mail folder name is required");
    await this.#withImap(async (client) => {
      if ((await client.list()).some((item) => item.path === folder)) return;
      await client.mailboxCreate(folder);
    });
  }

  async search(input: SearchMailInput): Promise<MailMessageSummary[]> {
    return this.#withImap(async (client) => {
      const lock = await client.getMailboxLock(input.folder, { readOnly: true });
      try {
        const uids = await client.search(searchCriteria(input.query), { uid: true });
        if (!uids || uids.length === 0) return [];
        const selected = uids.slice(-input.limit).reverse();
        const results: MailMessageSummary[] = [];
        for await (const item of client.fetch(selected, { source: true }, { uid: true })) {
          if (!item.source) continue;
          const parsed = await simpleParser(item.source, { skipHtmlToText: false, skipTextToHtml: true });
          const text = (parsed.text ?? "").replace(/\s+/g, " ").trim();
          results.push({
            messageRef: messageReference(input.folder, currentUidValidity(client), item.uid),
            folder: input.folder,
            subject: parsed.subject ?? "",
            from: formatAddress(parsed.from),
            to: parsed.to ? [formatAddress(parsed.to)] : [],
            receivedAt: (parsed.date ?? new Date(0)).toISOString(),
            snippet: text.length > 200 ? `${text.slice(0, 200)}…` : text,
          });
        }
        return results;
      } finally {
        lock.release();
      }
    });
  }

  async read(input: ReadMailInput): Promise<MailMessageDetail> {
    return this.#withImap(async (client) => {
      const reference = parseMessageReference(input.messageRef, input.folder);
      const lock = await client.getMailboxLock(input.folder, { readOnly: true });
      try {
        const item = await fetchSource(client, reference);
        const parsed = await simpleParser(item.source!, { skipHtmlToText: false, skipTextToHtml: true });
        const autoSubmitted = parsed.headers.get("auto-submitted");
        const precedence = parsed.headers.get("precedence");
        const from = formatAddress(parsed.from);
        return {
          messageRef: input.messageRef,
          folder: input.folder,
          subject: parsed.subject ?? "",
          from,
          to: parsed.to ? [formatAddress(parsed.to)] : [],
          ...(parsed.cc ? { cc: [formatAddress(parsed.cc)] } : {}),
          receivedAt: (parsed.date ?? new Date(0)).toISOString(),
          text: parsed.text ?? "",
          ...(typeof parsed.html === "string" ? { html: parsed.html } : {}),
          ...(parsed.messageId ? { messageId: parsed.messageId } : {}),
          ...(parsed.inReplyTo ? { inReplyTo: parsed.inReplyTo } : {}),
          ...(parsed.references
            ? { references: Array.isArray(parsed.references) ? parsed.references : [parsed.references] }
            : {}),
          attachments: parsed.attachments.map((attachment, index) => ({
            attachmentRef: attachmentReference(input.messageRef, index),
            filename: attachment.filename ?? `attachment-${index + 1}.bin`,
            contentType: attachment.contentType,
            size: attachment.size,
          })),
          autoSubmitted: isAutomaticResponse({
            autoSubmitted,
            precedence,
            listId: parsed.headers.get("list-id"),
            returnPath: parsed.headers.get("return-path"),
            xAutoReply: parsed.headers.get("x-autoreply"),
            xAutoRespond: parsed.headers.get("x-autorespond"),
            from,
          }),
        };
      } finally {
        lock.release();
      }
    });
  }

  async send(input: SendMailInput): Promise<SendMailResult> {
    const connection = await this.#connections.getConnection(this.grant.grantId);
    const transport = createSmtpTransport(connection);
    try {
      const result = await transport.sendMail({
        from: connection.mailboxAddress,
        to: input.to,
        cc: input.cc,
        bcc: input.bcc,
        subject: input.subject,
        text: input.text,
      });
      return { messageId: result.messageId };
    } finally {
      transport.close();
    }
  }

  async reply(input: ReplyMailInput): Promise<SendMailResult> {
    const connection = await this.#connections.getConnection(this.grant.grantId);
    const transport = createSmtpTransport(connection);
    try {
      const subject = /^re:/i.test(input.subject) ? input.subject : `Re: ${input.subject}`;
      const result = await transport.sendMail({
        from: connection.mailboxAddress,
        to: input.to,
        cc: input.cc,
        bcc: input.bcc,
        subject,
        text: input.text,
        inReplyTo: input.inReplyTo,
        references: input.references,
      });
      return { messageId: result.messageId };
    } finally {
      transport.close();
    }
  }

  async createDraft(input: SendMailInput): Promise<DraftMailResult> {
    const connection = await this.#connections.getConnection(this.grant.grantId);
    const raw = await composeRaw(connection, input);
    return this.#withImap(async (client) => {
      const folder = await findFolder(client, "drafts", "Drafts");
      const result = await client.append(folder, raw, ["\\Draft", "\\Seen"], new Date());
      if (!result) throw new Error("draft could not be stored");
      return {
        folder,
        draftRef:
          result.uid && result.uidValidity
            ? messageReference(folder, result.uidValidity, result.uid)
            : encodeReference(MESSAGE_REF_PREFIX, { version: 1, folder, uidValidity: "unknown", uid: 1 }),
      };
    });
  }

  async move(input: MoveMailInput): Promise<MoveMailResult> {
    return this.#withImap(async (client) => {
      const reference = parseMessageReference(input.messageRef, input.fromFolder);
      const lock = await client.getMailboxLock(input.fromFolder);
      try {
        if (currentUidValidity(client).toString() !== reference.uidValidity) {
          throw new Error("message reference expired because the mailbox identity changed");
        }
        const result = await client.messageMove(reference.uid, input.toFolder, { uid: true });
        if (!result) throw new Error("message could not be moved");
        const destinationUid = result.uidMap?.get(reference.uid);
        return {
          folder: input.toFolder,
          messageRef:
            destinationUid && result.uidValidity
              ? messageReference(input.toFolder, result.uidValidity, destinationUid)
              : input.messageRef,
        };
      } finally {
        lock.release();
      }
    });
  }

  async trash(input: ReadMailInput): Promise<MoveMailResult> {
    const connection = await this.#connections.getConnection(this.grant.grantId);
    const client = createImapClient(connection);
    await client.connect();
    try {
      const trashFolder = await findFolder(client, "trash", "Trash");
      const reference = parseMessageReference(input.messageRef, input.folder);
      const lock = await client.getMailboxLock(input.folder);
      try {
        if (currentUidValidity(client).toString() !== reference.uidValidity) {
          throw new Error("message reference expired because the mailbox identity changed");
        }
        const result = await client.messageMove(reference.uid, trashFolder, { uid: true });
        if (!result) throw new Error("message could not be moved to trash");
        const destinationUid = result.uidMap?.get(reference.uid);
        return {
          folder: trashFolder,
          messageRef:
            destinationUid && result.uidValidity
              ? messageReference(trashFolder, result.uidValidity, destinationUid)
              : input.messageRef,
        };
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => undefined);
    }
  }

  async downloadAttachment(input: DownloadAttachmentInput): Promise<DownloadAttachmentResult> {
    const reference = parseAttachmentReference(input.attachmentRef, input.messageRef);
    return this.#withImap(async (client) => {
      const messageReferencePayload = parseMessageReference(input.messageRef, input.folder);
      const lock = await client.getMailboxLock(input.folder, { readOnly: true });
      try {
        const item = await fetchSource(client, messageReferencePayload);
        const parsed = await simpleParser(item.source!, { skipHtmlToText: true, skipTextToHtml: true });
        const attachment = parsed.attachments[reference.index];
        if (!attachment) throw new Error("attachment was not found");
        return {
          filename: attachment.filename ?? `attachment-${reference.index + 1}.bin`,
          contentType: attachment.contentType,
          content: Buffer.from(attachment.content),
        };
      } finally {
        lock.release();
      }
    });
  }

  async #withImap<T>(operation: (client: ImapFlow) => Promise<T>): Promise<T> {
    const connection = await this.#connections.getConnection(this.grant.grantId);
    const client = createImapClient(connection);
    await client.connect();
    try {
      return await operation(client);
    } finally {
      await client.logout().catch(() => undefined);
    }
  }
}
