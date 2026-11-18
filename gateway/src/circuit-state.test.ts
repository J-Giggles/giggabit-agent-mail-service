import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MailCircuitBreaker, SqliteMailCircuitStateStore } from "./circuit-breaker.js";
import { HostMailGateway } from "./gateway.js";
import type { MailboxProvider } from "./provider.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("persistent outbound safety state", () => {
  it("uses elapsed time across service restarts and starts a new window on host reboot", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mail-folder-limit-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "state.sqlite");
    let now = Date.parse("2026-07-11T10:00:00.000Z");
    let elapsedMs = 5_000;
    let bootId = "test-boot-one";
    const hostClock = () => ({ bootId, elapsedMs });
    let writes = 0;
    const provider: MailboxProvider = {
      grant: { grantId: "mailbox-1", label: "Synthetic", provider: "fake" },
      ensureFolder: async (folder) => {
        writes += 1;
        return folder;
      },
      listFolders: async () => [],
      search: async () => [],
      read: async () => { throw new Error("not used"); },
    };
    const connect = (stateStore: SqliteMailCircuitStateStore) => new HostMailGateway({
      providers: [provider], audit: () => undefined, now: () => new Date(now),
      circuitBreaker: new MailCircuitBreaker({ now: () => new Date(now), stateStore }),
    });
    const principal = { tokenId: "token-1", runId: "test", nodeId: "synthetic", expiresAt: "" };
    const create = (gateway: HostMailGateway) => gateway.callTool(principal, "folders", {
      action: "create", grant_id: "mailbox-1", folder: "Finance/Receipts",
    });
    const before = new SqliteMailCircuitStateStore(path, hostClock);
    try {
      const gateway = connect(before);
      for (let count = 0; count < 10; count += 1) await create(gateway);
    } finally {
      before.close();
    }

    const after = new SqliteMailCircuitStateStore(path, hostClock);
    try {
      const gateway = connect(after);
      now += 3_600_000;
      await expect(create(gateway)).rejects.toThrow("folder creation rate limit reached");
      now -= 7_200_000;
      elapsedMs += 59_999;
      await expect(create(gateway)).rejects.toThrow("folder creation rate limit reached");
      expect(writes).toBe(10);
      elapsedMs += 1;
      for (let count = 0; count < 10; count += 1) await create(gateway);
      expect(writes).toBe(20);
    } finally {
      after.close();
    }
    bootId = "test-boot-two";
    elapsedMs = 5;
    const rebooted = new SqliteMailCircuitStateStore(path, hostClock);
    try {
      await expect(create(connect(rebooted))).resolves.toMatchObject({ action: "create" });
      expect(writes).toBe(21);
    } finally {
      rebooted.close();
    }
  });

  it("survives restart without allowing a duplicate send or bypassing an opened circuit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mail-circuit-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "state.sqlite");
    const now = new Date("2026-07-11T10:00:00.000Z");
    const limits = { perMinute: 1, perHour: 50, perDay: 200, maxRecipients: 25 };

    const firstStore = new SqliteMailCircuitStateStore(path);
    const first = new MailCircuitBreaker({ now: () => now, limits, stateStore: firstStore });
    expect(
      first.reserve({
        grantId: "mailbox-1",
        idempotencyKey: "run-1-send-0001",
        recipientCount: 1,
        replyToRef: "message-1",
      }),
    ).toEqual({ status: "reserved" });
    first.commit("mailbox-1", "run-1-send-0001", { message_id: "provider-message-1" });
    expect(() =>
      first.reserve({ grantId: "mailbox-1", idempotencyKey: "run-1-send-0002", recipientCount: 1 }),
    ).toThrow("circuit breaker");
    firstStore.close();

    const secondStore = new SqliteMailCircuitStateStore(path);
    const second = new MailCircuitBreaker({ now: () => now, limits, stateStore: secondStore });
    expect(
      second.reserve({
        grantId: "mailbox-1",
        idempotencyKey: "run-1-send-0001",
        recipientCount: 1,
        replyToRef: "message-1",
      }),
    ).toEqual({ status: "duplicate", result: { message_id: "provider-message-1" } });
    expect(() =>
      second.reserve({ grantId: "mailbox-1", idempotencyKey: "run-1-send-0003", recipientCount: 1 }),
    ).toThrow("circuit breaker is open");
    secondStore.close();
  });

  it("keeps a crashed pending reservation blocked after restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mail-circuit-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "state.sqlite");

    const firstStore = new SqliteMailCircuitStateStore(path);
    const first = new MailCircuitBreaker({ stateStore: firstStore });
    first.reserve({ grantId: "mailbox-1", idempotencyKey: "run-2-send-0001", recipientCount: 1 });
    firstStore.close();

    const secondStore = new SqliteMailCircuitStateStore(path);
    const second = new MailCircuitBreaker({ stateStore: secondStore });
    expect(() =>
      second.reserve({ grantId: "mailbox-1", idempotencyKey: "run-2-send-0001", recipientCount: 1 }),
    ).toThrow("already in progress");
    secondStore.close();
  });
});
