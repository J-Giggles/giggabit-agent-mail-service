import { ImapFlow, type FetchMessageObject, type ListOptions, type ListResponse, type SearchObject } from "imapflow";
import { simpleParser, type AddressObject } from "mailparser";
import { createTransport } from "nodemailer";
import { z } from "zod";

import { findFolder, FolderCreateRefusal } from "./provider.js";
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

const specialUseRoles = new Map<string, NonNullable<MailFolder["role"]>>([
  ["\\archive", "archive"],
  ["\\all", "archive"],
  ["\\drafts", "drafts"],
  ["\\inbox", "inbox"],
  ["\\junk", "spam"],
  ["\\sent", "sent"],
  ["\\trash", "trash"],
]);

function folderRole(path: string, flags: Iterable<string | Buffer | undefined>): MailFolder["role"] {
  for (const flag of flags) {
    const role = flag && specialUseRoles.get(asciiFold(wireText(flag)));
    if (role) return role;
  }
  return path.toUpperCase() === "INBOX" ? "inbox" : undefined;
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

async function listMailboxes(client: ImapFlow, options?: ListOptions): Promise<ListResponse[]> {
  return (await client.list(options)).map((folder) => {
    const wireName: unknown = folder.pathAsListed;
    return Buffer.isBuffer(wireName) ? { ...folder, pathAsListed: wireName.toString("utf8") } : folder;
  });
}

const nameToken = z.object({ value: z.union([z.string(), z.instanceof(Buffer)]) }).transform((token) => token.value);
const namespacePrefix = z.object({
  type: z.enum(["STRING", "LITERAL"]),
  value: z.union([z.string(), z.instanceof(Buffer)]),
}).transform((token) => token.value);
const namespaceDelimiter = z.object({ type: z.literal("STRING"), value: z.string() }).transform((token) => token.value);
const namespaceEntry = z.tuple([namespacePrefix, namespaceDelimiter.nullable()]);
const nonPersonalNamespaces = z.array(namespaceEntry).min(1).nullable();
const namespaceReply = z.object({
  attributes: z.tuple([z.tuple([namespaceEntry]), nonPersonalNamespaces, nonPersonalNamespaces]),
});
const listReply = z.object({
  attributes: z.tuple([z.array(nameToken), z.unknown(), nameToken]).rest(z.unknown()),
});
const folderSegment = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,62}$/;
const asciiFold = (name: string) => name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
const isFolderSegment = (segment: string) =>
  folderSegment.test(segment) && !segment.endsWith(" ") && asciiFold(segment) !== "nil";
const wireText = (value: string | Buffer) => typeof value === "string" ? value : value.toString("utf8");

function isSelectableMailbox(flags: Iterable<string | Buffer>): boolean {
  return !Array.from(flags).some((flag) => ["\\nonexistent", "\\noselect"].includes(asciiFold(wireText(flag))));
}

const folderCreateProviders = new Set(["google-oauth", "microsoft-oauth"]);
const supportedFolderNamespace = {
  revision: "IMAP4rev1",
  prefix: "",
  delimiter: "/",
  otherUsers: false,
  shared: false,
};

function usesImap4Rev2(client: ImapFlow): boolean {
  return client.enabled.has("IMAP4REV2") ||
    ((client.capabilities.has("IMAP4rev2") || client.capabilities.has("IMAP4REV2")) &&
      !client.capabilities.has("IMAP4rev1") && !client.capabilities.has("IMAP4REV1"));
}

type ImapToken = { type: "STRING" | "ATOM"; value: string };

async function rawImapReplies(client: ImapFlow, command: "NAMESPACE" | "LIST", attributes: (ImapToken | ImapToken[])[] | false) {
  const exec = "exec" in client ? client.exec : undefined;
  if (typeof exec !== "function") throw new Error("raw IMAP command unavailable");
  const replies: unknown[] = [];
  const response: unknown = await exec.call(client, command, attributes, {
    untagged: { [command]: async (reply: unknown) => { replies.push(reply); } },
  });
  if (!response || typeof response !== "object" || !("next" in response) || typeof response.next !== "function") {
    throw new Error("invalid raw IMAP response");
  }
  response.next();
  return replies;
}

// ImapFlow normalizes prefixes during connect. Check the unmodified server reply before CREATE.
async function folderCreateNamespace(client: ImapFlow) {
  const rev2 = usesImap4Rev2(client);
  const revision = rev2 ? "IMAP4rev2" :
    client.capabilities.has("IMAP4rev1") || client.capabilities.has("IMAP4REV1") ? "IMAP4rev1" : undefined;
  const expected = supportedFolderNamespace;
  if (revision !== expected.revision || !client.capabilities.has("NAMESPACE")) {
    throw new FolderCreateRefusal("unsupportedNamespace");
  }
  let replies: unknown[];
  try {
    replies = await rawImapReplies(client, "NAMESPACE", false);
  } catch {
    throw new FolderCreateRefusal("unsupportedNamespace");
  }
  if (replies.length !== 1) throw new FolderCreateRefusal("unsupportedNamespace");

  const parsed = namespaceReply.safeParse(replies[0]);
  if (!parsed.success) throw new FolderCreateRefusal("unsupportedNamespace");
  const [[personal], otherUsers, shared] = parsed.data.attributes;
  const [wirePrefix, wireDelimiter] = personal;
  const prefix = wireText(wirePrefix);
  const delimiter = wireDelimiter ?? "";
  if (prefix !== expected.prefix || delimiter !== expected.delimiter ||
    (otherUsers !== null) !== expected.otherUsers || (shared !== null) !== expected.shared) {
    throw new FolderCreateRefusal("unsupportedNamespace");
  }
  const activeNamespace = "namespace" in client ? client.namespace : undefined;
  if (!activeNamespace ||
    typeof activeNamespace !== "object" || !("prefix" in activeNamespace) || !("delimiter" in activeNamespace)) {
    throw new FolderCreateRefusal("unsupportedNamespace");
  }
  // Both pinned ImapFlow versions can omit a literal during their initial NAMESPACE parse.
  Object.assign(activeNamespace, { prefix, delimiter });
  const utf8 = client.enabled.has("UTF8=ACCEPT");
  const nonPersonalPrefixes = [...(otherUsers ?? []), ...(shared ?? [])].map(([wireName]) => {
    const name = decodeListedName(wireText(wireName), utf8);
    if (name === undefined) throw new FolderCreateRefusal("unsupportedNamespace");
    return name;
  });
  return { prefix, delimiter, nonPersonalPrefixes, utf8 };
}

// ImapFlow's decoded path can drop a leading delimiter. Decode the raw LIST name without path normalization.
function decodeListedName(name: string, utf8: boolean): string | undefined {
  if (utf8 || !name.includes("&")) return name;
  if (/&(?![A-Za-z0-9+,]*-)/.test(name)) return undefined;
  const decoder = new TextDecoder("utf-16be", { fatal: true, ignoreBOM: true });
  try {
    return name.replace(/&([A-Za-z0-9+,]*)-/g, (_, token: string) => {
      if (!token) return "&";
      const base64 = token.replaceAll(",", "/");
      const bytes = Buffer.from(base64, "base64");
      const decoded = decoder.decode(bytes);
      if (bytes.toString("base64").replace(/=+$/, "") !== base64 || !decoded || /[\x20-\x7e]/.test(decoded)) {
        throw new Error("invalid modified UTF-7 mailbox name");
      }
      return decoded;
    });
  } catch {
    return undefined;
  }
}

async function selectableListRows(client: ImapFlow, attributes: (ImapToken | ImapToken[])[], utf8: boolean) {
  return (await rawImapReplies(client, "LIST", attributes)).flatMap((reply) => {
    const parsed = listReply.safeParse(reply);
    if (!parsed.success) return [];
    const [flags, delimiter, wireName] = parsed.data.attributes;
    if (!isSelectableMailbox(flags)) return [];
    const path = decodeListedName(wireText(wireName), utf8);
    return path === undefined ? [] : [{ path, flags, delimiter }];
  });
}

async function selectableMailboxNames(client: ImapFlow, path: string, utf8: boolean): Promise<string[]> {
  // ImapFlow's convenience list merges LSUB flags by normalized path. Use only raw LIST rows here.
  const rows = await selectableListRows(client, [
    { type: "STRING", value: "" },
    { type: "STRING", value: path },
  ], utf8);
  return rows.map((row) => row.path);
}

async function listMailFolders(client: ImapFlow, selectableOnly: boolean): Promise<MailFolder[]> {
  // ImapFlow 1.4.7 supports listOnly but omits it from ListOptions.
  const listOnly: ListOptions & { listOnly: true } = { listOnly: true };
  const folders = await listMailboxes(client, selectableOnly ? listOnly : undefined);
  return folders.filter((folder) => !selectableOnly || isSelectableMailbox(folder.flags)).map((folder) => {
    // ImapFlow fills specialUse after the LIST-only return.
    const role = folderRole(folder.path, selectableOnly ? folder.flags : [folder.specialUse]);
    return { path: folder.path, name: folder.name, ...(role ? { role } : {}) };
  });
}

async function listSelectableRoles(client: ImapFlow): Promise<MailFolder[]> {
  if (client.capabilities.has("SPECIAL-USE") || client.capabilities.has("LIST-EXTENDED")) {
    try {
      const rows = await selectableListRows(client, [
        { type: "STRING", value: "" },
        { type: "STRING", value: "*" },
        { type: "ATOM", value: "RETURN" },
        [{ type: "ATOM", value: "SPECIAL-USE" }],
      ], client.enabled.has("UTF8=ACCEPT") || usesImap4Rev2(client));
      return rows.map(({ path, flags, delimiter }) => {
        const parsedDelimiter = namespaceDelimiter.safeParse(delimiter);
        const name = parsedDelimiter.success && parsedDelimiter.data.length === 1
          ? path.slice(path.lastIndexOf(parsedDelimiter.data) + 1)
          : path;
        const role = folderRole(path, flags);
        return { path, name, ...(role ? { role } : {}) };
      });
    } catch (error) {
      // A server can implement LIST-EXTENDED without the SPECIAL-USE return option.
      if (!(error instanceof Error) || !("responseStatus" in error) ||
        (error.responseStatus !== "BAD" && error.responseStatus !== "NO")) throw error;
    }
  }
  return listMailFolders(client, true);
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

  async listFolders({ selectableOnly = false } = {}): Promise<MailFolder[]> {
    return this.#withImap((client) => selectableOnly && this.grant.provider !== "imap-smtp"
      ? listSelectableRoles(client)
      : listMailFolders(client, selectableOnly));
  }

  async #findOperationFolder(client: ImapFlow, role: "drafts" | "trash", fallback: string): Promise<string> {
    if (this.grant.provider !== "imap-smtp") {
      const preferred = findFolder(await listSelectableRoles(client), role);
      if (preferred) return preferred;
    }
    return findFolder(await listMailFolders(client, false), role) ?? fallback;
  }

  async ensureFolder(folder: string): Promise<string> {
    const segments = folder.split("/");
    if (!segments.every(isFolderSegment)) throw new FolderCreateRefusal("invalidPath");
    if (!folderCreateProviders.has(this.grant.provider)) throw new FolderCreateRefusal("unsupportedNamespace");
    return this.#withImap(async (client) => {
      const { prefix, delimiter, nonPersonalPrefixes, utf8 } = await folderCreateNamespace(client);
      if (segments.some((segment) => segment.includes(delimiter))) {
        throw new FolderCreateRefusal("delimiterInSegment");
      }
      const inbox = asciiFold(folder) === "inbox";
      const path = inbox ? "INBOX" : prefix + segments.join(delimiter);
      if (!inbox && path.toUpperCase() === "INBOX") throw new FolderCreateRefusal("invalidPath");
      const foldedPath = asciiFold(path);
      if (nonPersonalPrefixes.some((name) => path.startsWith(name))) {
        throw new FolderCreateRefusal("outsidePersonalNamespace");
      }

      const listed = await selectableMailboxNames(client, path, utf8);
      if (listed.includes(path)) return path;
      if (folder !== path && delimiter !== "/" && folder.includes("/") && listed.includes(folder)) {
        throw new FolderCreateRefusal("invalidPath");
      }
      try {
        await client.mailboxCreate(path);
      } catch {
        // Confirm success or recover from a racing CREATE using LIST.
      }
      let afterCreate: string[];
      try {
        afterCreate = await selectableMailboxNames(client, path, utf8);
      } catch {
        throw new FolderCreateRefusal("creationUnconfirmed");
      }
      const confirmedPath = afterCreate.find((name) => name === path);
      if (confirmedPath !== undefined) return confirmedPath;
      if (afterCreate.some((name) => asciiFold(name) === foldedPath)) {
        throw new FolderCreateRefusal("unconfirmedPath");
      }
      throw new FolderCreateRefusal("creationUnconfirmed");
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
      const folder = await this.#findOperationFolder(client, "drafts", "Drafts");
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
      const trashFolder = await this.#findOperationFolder(client, "trash", "Trash");
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
