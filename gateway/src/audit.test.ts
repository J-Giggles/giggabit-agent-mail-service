import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SqliteGatewayAudit } from "./audit.js";

describe("metadata-only gateway audit", () => {
  it("records attribution while hashing provider target references", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mail-audit-"));
    const path = join(directory, "audit.sqlite");
    try {
      const audit = new SqliteGatewayAudit({ path, hashKey: Buffer.alloc(32, 7) });
      audit.record({
        occurredAt: "2026-07-11T10:00:00.000Z",
        runId: "run-1",
        nodeId: "node-1",
        grantId: "mailbox-1",
        action: "messages.read",
        targetRef: "sensitive-provider-message-reference",
      });
      expect(audit.recent(1)).toMatchObject([
        { runId: "run-1", nodeId: "node-1", grantId: "mailbox-1", action: "messages.read" },
      ]);
      audit.close();
      expect((await readFile(path)).includes(Buffer.from("sensitive-provider-message-reference"))).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
