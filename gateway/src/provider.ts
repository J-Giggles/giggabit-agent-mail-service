export interface MailboxGrantDescriptor {
  grantId: string;
  label: string;
  provider: string;
  outboundLimits?: {
    perMinute?: number;
    perHour?: number;
    perDay?: number;
    maxRecipients?: number;
  };
}

export interface MailFolder {
  path: string;
  name: string;
  role?: "archive" | "drafts" | "inbox" | "sent" | "spam" | "trash";
}

export interface MailMessageSummary {
  messageRef: string;
  folder: string;
  subject: string;
  from: string;
  to: string[];
  receivedAt: string;
  snippet: string;
}

export interface MailAttachmentSummary {
  attachmentRef?: string;
  filename: string;
  contentType: string;
  size: number;
}

export interface MailMessageDetail extends Omit<MailMessageSummary, "snippet"> {
  text: string;
  html?: string;
  cc?: string[];
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  attachments: MailAttachmentSummary[];
  autoSubmitted?: boolean;
}

export interface SearchMailInput {
  folder: string;
  query: string;
  limit: number;
}

export interface ReadMailInput {
  folder: string;
  messageRef: string;
}

export interface SendMailInput {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
}

export interface SendMailResult {
  messageId: string;
}

export interface ReplyMailInput extends SendMailInput {
  folder: string;
  messageRef: string;
  inReplyTo?: string;
  references: string[];
}

export interface DraftMailResult {
  draftRef: string;
  folder: string;
}

export interface MoveMailInput {
  messageRef: string;
  fromFolder: string;
  toFolder: string;
}

export interface MoveMailResult {
  messageRef: string;
  folder: string;
}

export interface DownloadAttachmentInput {
  folder: string;
  messageRef: string;
  attachmentRef: string;
}

export interface DownloadAttachmentResult {
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface MailboxProvider {
  grant: MailboxGrantDescriptor;
  listFolders(): Promise<MailFolder[]>;
  ensureFolder?(folder: string): Promise<void>;
  search(input: SearchMailInput): Promise<MailMessageSummary[]>;
  read(input: ReadMailInput): Promise<MailMessageDetail>;
  send?(input: SendMailInput): Promise<SendMailResult>;
  reply?(input: ReplyMailInput): Promise<SendMailResult>;
  createDraft?(input: SendMailInput): Promise<DraftMailResult>;
  move?(input: MoveMailInput): Promise<MoveMailResult>;
  trash?(input: ReadMailInput): Promise<MoveMailResult>;
  downloadAttachment?(input: DownloadAttachmentInput): Promise<DownloadAttachmentResult>;
}
