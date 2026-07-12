import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { VaultMailboxConnectionSource } from "./oauth-connection-source.js";
import { CredentialVault } from "./vault.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("OAuth provider connection seam", () => {
  it("hydrates an access token in memory and persists only an encrypted rotated refresh token", async () => {
    const directory = await mkdtemp(join(tmpdir(), "giggabit-agent-mail-service-oauth-"));
    temporaryDirectories.push(directory);
    const vault = new CredentialVault({ databasePath: join(directory, "vault.sqlite"), masterKey: Buffer.alloc(32, 5) });
    vault.put({
      grantId: "google-mailbox",
      label: "Google mailbox",
      provider: "google",
      secret: {
        mailboxAddress: "owner@example.invalid",
        username: "owner@example.invalid",
        imap: { host: "imap.gmail.com", port: 993, secure: true },
        smtp: { host: "smtp.gmail.com", port: 465, secure: true },
        auth: {
          type: "oauth2",
          tokenEndpoint: "https://oauth2.googleapis.com/token",
          clientId: "client-id",
          clientSecret: "client-secret",
          refreshToken: "initial-refresh-token",
        },
      },
    });
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(String(init?.body)).toContain("refresh_token=initial-refresh-token");
      return Response.json({
        access_token: "short-lived-access-token",
        expires_in: 3600,
        refresh_token: "rotated-refresh-token",
      });
    });
    const source = new VaultMailboxConnectionSource({ vault, fetch });

    await expect(source.getConnection("google-mailbox")).resolves.toMatchObject({
      mailboxAddress: "owner@example.invalid",
      username: "owner@example.invalid",
      accessToken: "short-lived-access-token",
      imap: { host: "imap.gmail.com", port: 993, secure: true },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vault.get("google-mailbox")).toMatchObject({
      auth: { refreshToken: "rotated-refresh-token" },
    });
    vault.close();
  });
});
