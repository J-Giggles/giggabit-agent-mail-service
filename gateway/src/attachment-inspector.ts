import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_TEXT_BYTES = 1024 * 1024;

export interface AttachmentInspection {
  contentType: string;
  text?: string;
}

export interface AttachmentInspector {
  inspect(path: string): Promise<AttachmentInspection>;
}

export interface BwrapAttachmentInspectorOptions {
  execute?: (command: string, args: string[]) => Promise<string>;
}

async function execute(command: string, args: string[]): Promise<string> {
  const result = await execFileAsync(command, args, {
    encoding: "utf8",
    env: { PATH: "/usr/bin" },
    maxBuffer: MAX_TEXT_BYTES + 64 * 1024,
    timeout: 30_000,
  });
  return result.stdout;
}

function sandboxArgs(path: string, command: string, args: string[]): string[] {
  return [
    "--unshare-all",
    "--die-with-parent",
    "--new-session",
    "--ro-bind",
    "/usr",
    "/usr",
    "--symlink",
    "usr/lib",
    "/lib",
    "--symlink",
    "usr/lib",
    "/lib64",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--ro-bind",
    path,
    "/input",
    "--",
    command,
    ...args,
  ];
}

export class BwrapAttachmentInspector implements AttachmentInspector {
  readonly #execute: NonNullable<BwrapAttachmentInspectorOptions["execute"]>;

  constructor(options: BwrapAttachmentInspectorOptions = {}) {
    this.#execute = options.execute ?? execute;
  }

  async inspect(path: string): Promise<AttachmentInspection> {
    const contentType = (
      await this.#execute("/usr/bin/bwrap", sandboxArgs(path, "/usr/bin/file", ["--brief", "--mime-type", "/input"]))
    ).trim();
    if (!contentType) throw new Error("sandboxed attachment type inspection failed");
    if (!contentType.startsWith("text/")) return { contentType };
    const text = await this.#execute(
      "/usr/bin/bwrap",
      sandboxArgs(path, "/usr/bin/head", ["-c", String(MAX_TEXT_BYTES), "/input"]),
    );
    return { contentType, text };
  }
}
