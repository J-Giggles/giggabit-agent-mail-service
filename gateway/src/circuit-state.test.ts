import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MailCircuitBreaker, SqliteMailCircuitStateStore } from "./circuit-breaker.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("persistent outbound safety state", () => {
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
