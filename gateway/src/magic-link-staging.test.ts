import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { MagicLinkStagingApp } from "./magic-link-staging.js";

async function requestControl(socketPath: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      { socketPath, method: "POST", path: "/attempts/claim", headers: { "content-length": "0" } },
      (incoming) => {
        let body = "";
        incoming.setEncoding("utf8");
        incoming.on("data", (chunk) => (body += chunk));
        incoming.on("end", () => {
          try {
            resolve(JSON.parse(body) as Record<string, unknown>);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

describe("Magic-link staging application", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("hands one browser request to the isolated driver without exposing the alias or link publicly", async () => {
    const directory = await mkdtemp(join(tmpdir(), "magic-link-staging-"));
    const socketPath = join(directory, "control.sock");
    const app = new MagicLinkStagingApp({
      publicOrigin: "https://staging.example.invalid",
      controlSocketPath: socketPath,
      now: () => new Date("2026-07-12T10:00:00.000Z"),
    });
    const address = await app.start();
    cleanups.push(async () => {
      await app.stop();
      await rm(directory, { recursive: true, force: true });
    });

    const response = await fetch(`${address.url}/magic-link-staging/request`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://staging.example.invalid",
      },
      body: new URLSearchParams({ alias: "automation@example.invalid" }),
      redirect: "manual",
    });
    const publicBody = await response.text();
    const handoff = await requestControl(socketPath);

    expect(response.status).toBe(202);
    expect(publicBody).toContain("Check the dedicated test mailbox");
    expect(publicBody).not.toContain("automation@example.invalid");
    expect(publicBody).not.toContain("https://staging.example.invalid/magic-link-staging/consume");
    expect(handoff).toMatchObject({
      request_time: "2026-07-12T10:00:00.000Z",
      recipient_alias: "automation@example.invalid",
      expected_sender: "automation@example.invalid",
      expected_hostname: "staging.example.invalid",
    });
    expect(handoff.attempt_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(handoff.magic_link).toMatch(
      /^https:\/\/staging\.example\.invalid\/magic-link-staging\/consume\?attempt=[^&]+&token=[^&]+$/,
    );
    await expect(requestControl(socketPath)).resolves.toEqual({ status: "no_pending_attempt" });
  });

  it("consumes a link once and redirects to a clean authenticated browser state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "magic-link-staging-"));
    const socketPath = join(directory, "control.sock");
    const app = new MagicLinkStagingApp({
      publicOrigin: "https://staging.example.invalid",
      controlSocketPath: socketPath,
      now: () => new Date("2026-07-12T10:00:00.000Z"),
    });
    const address = await app.start();
    cleanups.push(async () => {
      await app.stop();
      await rm(directory, { recursive: true, force: true });
    });
    await fetch(`${address.url}/magic-link-staging/request`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://staging.example.invalid",
      },
      body: new URLSearchParams({ alias: "automation@example.invalid" }),
    });
    const handoff = await requestControl(socketPath);
    const bearer = new URL(String(handoff.magic_link));
    const localBearer = `${address.url}${bearer.pathname}${bearer.search}`;

    const consumed = await fetch(localBearer, { redirect: "manual" });
    const cookie = consumed.headers.get("set-cookie");

    expect(consumed.status).toBe(303);
    expect(consumed.headers.get("location")).toBe("/magic-link-staging/account");
    expect(cookie).toMatch(/^gbt_staging_session=[^;]+; Path=\/magic-link-staging; Max-Age=600; HttpOnly; Secure; SameSite=Strict$/);
    const account = await fetch(`${address.url}/magic-link-staging/account`, {
      headers: { cookie: cookie!.split(";", 1)[0]! },
    });
    await expect(account.text()).resolves.toContain('data-authenticated="true"');
    await expect(fetch(localBearer, { redirect: "manual" })).resolves.toMatchObject({ status: 410 });
  });

  it("rejects an alias submission from any other browser origin", async () => {
    const directory = await mkdtemp(join(tmpdir(), "magic-link-staging-"));
    const socketPath = join(directory, "control.sock");
    const app = new MagicLinkStagingApp({
      publicOrigin: "https://staging.example.invalid",
      controlSocketPath: socketPath,
    });
    const address = await app.start();
    cleanups.push(async () => {
      await app.stop();
      await rm(directory, { recursive: true, force: true });
    });

    const response = await fetch(`${address.url}/magic-link-staging/request`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://attacker.example.invalid",
      },
      body: new URLSearchParams({ alias: "automation@example.invalid" }),
    });

    expect(response.status).toBe(403);
    await expect(requestControl(socketPath)).resolves.toEqual({ status: "no_pending_attempt" });
  });

  it("exposes only a secret-free readiness identity on the public health path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "magic-link-staging-"));
    const socketPath = join(directory, "control.sock");
    const app = new MagicLinkStagingApp({
      publicOrigin: "https://staging.example.invalid",
      controlSocketPath: socketPath,
      port: 0,
    });
    const address = await app.start();
    cleanups.push(async () => {
      await app.stop();
      await rm(directory, { recursive: true, force: true });
    });

    const response = await fetch(`${address.url}/magic-link-staging/health`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      service: "giggabit-magic-link-staging",
    });
  });

  it("hands concurrent browser requests to the driver as distinct attempts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "magic-link-staging-"));
    const socketPath = join(directory, "control.sock");
    const app = new MagicLinkStagingApp({
      publicOrigin: "https://staging.example.invalid",
      controlSocketPath: socketPath,
    });
    const address = await app.start();
    cleanups.push(async () => {
      await app.stop();
      await rm(directory, { recursive: true, force: true });
    });
    const submit = (alias: string) =>
      fetch(`${address.url}/magic-link-staging/request`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "https://staging.example.invalid",
        },
        body: new URLSearchParams({ alias }),
      });

    await Promise.all([submit("first@example.invalid"), submit("second@example.invalid")]);
    const first = await requestControl(socketPath);
    const second = await requestControl(socketPath);

    expect(first.attempt_id).not.toBe(second.attempt_id);
    expect(first.magic_link).not.toBe(second.magic_link);
    await expect(requestControl(socketPath)).resolves.toEqual({ status: "no_pending_attempt" });
  });

  it("fails closed when an unconsumed bearer link expires", async () => {
    const directory = await mkdtemp(join(tmpdir(), "magic-link-staging-"));
    const socketPath = join(directory, "control.sock");
    let now = new Date("2026-07-12T10:00:00.000Z");
    const app = new MagicLinkStagingApp({
      publicOrigin: "https://staging.example.invalid",
      controlSocketPath: socketPath,
      now: () => now,
    });
    const address = await app.start();
    cleanups.push(async () => {
      await app.stop();
      await rm(directory, { recursive: true, force: true });
    });
    await fetch(`${address.url}/magic-link-staging/request`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://staging.example.invalid",
      },
      body: new URLSearchParams({ alias: "automation@example.invalid" }),
    });
    const handoff = await requestControl(socketPath);
    const bearer = new URL(String(handoff.magic_link));
    now = new Date("2026-07-12T10:05:00.001Z");

    await expect(
      fetch(`${address.url}${bearer.pathname}${bearer.search}`, { redirect: "manual" }),
    ).resolves.toMatchObject({ status: 410 });
  });
});
