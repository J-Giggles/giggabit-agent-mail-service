import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const DEFAULT_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export interface AttachmentScanner {
  scan(path: string): Promise<{ clean: boolean; signature?: string }>;
}

export interface AttachmentQuarantineOptions {
  root: string;
  scanner: AttachmentScanner;
  now?: () => Date;
  lifetimeMs?: number;
  maxAttachmentBytes?: number;
}

interface StoreAttachmentInput {
  runId: string;
  attachmentRef: string;
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface QuarantinedAttachment {
  attachment_ref: string;
  filename: string;
  content_type: string;
  path: string;
  expires_at: string;
}

function assertId(label: string, value: string): void {
  if (!ID_PATTERN.test(value)) {
    throw new Error(`${label} is invalid`);
  }
}

function safeFilename(filename: string): string {
  const value = basename(filename.replaceAll("\0", "")).trim();
  return value && value !== "." && value !== ".." ? value : "attachment.bin";
}

export class AttachmentQuarantine {
  readonly #handles = new Map<string, Map<string, QuarantinedAttachment>>();
  readonly #lifetimeMs: number;
  readonly #maxAttachmentBytes: number;
  readonly #now: () => Date;
  readonly #root: string;
  readonly #scanner: AttachmentScanner;

  constructor(options: AttachmentQuarantineOptions) {
    this.#root = options.root;
    this.#scanner = options.scanner;
    this.#now = options.now ?? (() => new Date());
    this.#lifetimeMs = options.lifetimeMs ?? DEFAULT_LIFETIME_MS;
    this.#maxAttachmentBytes = options.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
  }

  async store(input: StoreAttachmentInput): Promise<QuarantinedAttachment> {
    assertId("runId", input.runId);
    assertId("attachmentRef", input.attachmentRef);
    if (!input.contentType.trim()) {
      throw new Error("attachment content type is required");
    }
    if (input.content.length > this.#maxAttachmentBytes) {
      throw new Error("attachment exceeds the quarantine size limit");
    }

    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    await chmod(this.#root, 0o700);
    const runDirectory = join(this.#root, input.runId);
    await mkdir(runDirectory, { recursive: true, mode: 0o700 });
    await chmod(runDirectory, 0o700);
    const filename = safeFilename(input.filename);
    const path = join(runDirectory, `${input.attachmentRef}-${randomUUID()}-${filename}`);
    await writeFile(path, input.content, { flag: "wx", mode: 0o600 });
    await chmod(path, 0o600);

    let scan;
    try {
      scan = await this.#scanner.scan(path);
    } catch (error) {
      await rm(path, { force: true });
      throw error;
    }
    if (!scan.clean) {
      await rm(path, { force: true });
      throw new Error("attachment failed malware scanning");
    }
    const attachment = {
      attachment_ref: input.attachmentRef,
      filename,
      content_type: input.contentType,
      path,
      expires_at: new Date(this.#now().getTime() + this.#lifetimeMs).toISOString(),
    };
    const handles = this.#handles.get(input.runId) ?? new Map<string, QuarantinedAttachment>();
    const previous = handles.get(input.attachmentRef);
    if (previous) await rm(previous.path, { force: true });
    handles.set(input.attachmentRef, attachment);
    this.#handles.set(input.runId, handles);
    return attachment;
  }

  resolve(runId: string, attachmentRef: string): QuarantinedAttachment {
    assertId("runId", runId);
    assertId("attachmentRef", attachmentRef);
    const attachment = this.#handles.get(runId)?.get(attachmentRef);
    if (!attachment) throw new Error("quarantined attachment handle was not found for this run");
    return attachment;
  }

  async cleanupRun(runId: string): Promise<void> {
    assertId("runId", runId);
    this.#handles.delete(runId);
    await rm(join(this.#root, runId), { recursive: true, force: true });
  }

  async cleanupExpired(): Promise<void> {
    let runs;
    try {
      runs = await readdir(this.#root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const cutoff = this.#now().getTime() - this.#lifetimeMs;
    for (const run of runs) {
      const runPath = join(this.#root, run.name);
      if (!run.isDirectory()) {
        await rm(runPath, { force: true });
        continue;
      }
      const entries = await readdir(runPath, { withFileTypes: true });
      for (const entry of entries) {
        const path = join(runPath, entry.name);
        const info = await lstat(path);
        if (!entry.isFile() || info.mtimeMs <= cutoff) {
          await rm(path, { recursive: true, force: true });
          this.#forgetPath(path);
        }
      }
      if ((await readdir(runPath)).length === 0) await rm(runPath, { recursive: true, force: true });
    }
  }

  #forgetPath(path: string): void {
    for (const [runId, handles] of this.#handles) {
      for (const [attachmentRef, attachment] of handles) {
        if (attachment.path === path) handles.delete(attachmentRef);
      }
      if (handles.size === 0) this.#handles.delete(runId);
    }
  }
}
