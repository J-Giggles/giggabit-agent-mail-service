import { existsSync, statSync } from "node:fs";
import { mkdtemp, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AttachmentQuarantine } from "./quarantine.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Attachment quarantine seam", () => {
  it("scans a private per-run file, returns no content, and removes the run directory on cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "giggabit-agent-mail-service-quarantine-"));
    temporaryDirectories.push(root);
    const scannedPaths: string[] = [];
    const quarantine = new AttachmentQuarantine({
      root,
      scanner: {
        async scan(path) {
          scannedPaths.push(path);
          return { clean: true };
        },
      },
    });

    const result = await quarantine.store({
      runId: "run-42",
      attachmentRef: "attachment-7",
      filename: "../../statement.pdf",
      contentType: "application/pdf",
      content: Buffer.from("synthetic attachment"),
    });

    expect(result).toEqual({
      attachment_ref: "attachment-7",
      filename: "statement.pdf",
      content_type: "application/pdf",
      path: expect.stringContaining("/run-42/"),
      expires_at: expect.any(String),
    });
    expect(JSON.stringify(result)).not.toContain("synthetic attachment");
    expect(scannedPaths).toEqual([result.path]);
    expect(statSync(result.path).mode & 0o777).toBe(0o600);

    await quarantine.cleanupRun("run-42");
    expect(existsSync(join(root, "run-42"))).toBe(false);
  });

  it("removes expired attachment files after the 24-hour fallback window", async () => {
    const root = await mkdtemp(join(tmpdir(), "giggabit-agent-mail-service-quarantine-"));
    temporaryDirectories.push(root);
    const now = new Date("2026-07-11T10:00:00.000Z");
    const quarantine = new AttachmentQuarantine({
      root,
      now: () => now,
      scanner: { scan: async () => ({ clean: true }) },
    });
    const expired = await quarantine.store({
      runId: "run-old",
      attachmentRef: "attachment-old",
      filename: "old.txt",
      contentType: "text/plain",
      content: Buffer.from("old"),
    });
    const current = await quarantine.store({
      runId: "run-current",
      attachmentRef: "attachment-current",
      filename: "current.txt",
      contentType: "text/plain",
      content: Buffer.from("current"),
    });
    await utimes(expired.path, new Date("2026-07-09T09:00:00.000Z"), new Date("2026-07-09T09:00:00.000Z"));
    await utimes(current.path, new Date("2026-07-11T09:00:00.000Z"), new Date("2026-07-11T09:00:00.000Z"));

    await quarantine.cleanupExpired();

    expect(existsSync(expired.path)).toBe(false);
    expect(existsSync(current.path)).toBe(true);
  });

  it("removes the quarantined file when the malware scanner itself fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "giggabit-agent-mail-service-quarantine-"));
    temporaryDirectories.push(root);
    const quarantine = new AttachmentQuarantine({
      root,
      scanner: { scan: async () => Promise.reject(new Error("scanner unavailable")) },
    });

    await expect(
      quarantine.store({
        runId: "run-failed-scan",
        attachmentRef: "attachment-failed-scan",
        filename: "unknown.bin",
        contentType: "application/octet-stream",
        content: Buffer.from("untrusted"),
      }),
    ).rejects.toThrow("scanner unavailable");
    await expect(readdir(join(root, "run-failed-scan"))).resolves.toEqual([]);
  });
});
