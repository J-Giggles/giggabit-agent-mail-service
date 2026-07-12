import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { AttachmentScanner } from "./quarantine.js";

const execFileAsync = promisify(execFile);

export interface ScanCommandResult {
  exitCode: number;
  output: string;
}

export type ScanCommand = (command: string, args: string[]) => Promise<ScanCommandResult>;

export interface ClamAvScannerOptions {
  command?: string;
  execute?: ScanCommand;
}

async function execute(command: string, args: string[]): Promise<ScanCommandResult> {
  try {
    const result = await execFileAsync(command, args, { timeout: 120_000, maxBuffer: 256 * 1024 });
    return { exitCode: 0, output: `${result.stdout}${result.stderr}` };
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
    return {
      exitCode: typeof failure.code === "number" ? failure.code : 2,
      output: `${typeof failure.stdout === "string" ? failure.stdout : ""}${
        typeof failure.stderr === "string" ? failure.stderr : ""
      }`,
    };
  }
}

export class ClamAvScanner implements AttachmentScanner {
  readonly #command: string;
  readonly #execute: ScanCommand;

  constructor(options: ClamAvScannerOptions = {}) {
    this.#command = options.command ?? "/usr/bin/clamscan";
    this.#execute = options.execute ?? execute;
  }

  async scan(path: string): Promise<{ clean: boolean; signature?: string }> {
    const result = await this.#execute(this.#command, ["--no-summary", path]);
    if (result.exitCode === 0) return { clean: true };
    if (result.exitCode === 1) return { clean: false };
    throw new Error("malware scanner failed closed");
  }
}
