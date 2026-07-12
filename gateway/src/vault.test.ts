import { readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CredentialVault } from "./vault.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Mailbox administration seam", () => {
  it("encrypts provider credentials at rest and supports rotation and revocation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "giggabit-agent-mail-service-vault-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "credentials.sqlite");
    const vault = new CredentialVault({ databasePath, masterKey: Buffer.alloc(32, 9) });

    vault.put({
      grantId: "mailbox-personal",
      label: "Personal Microsoft mailbox",
      provider: "microsoft",
      secret: {
        mailboxAddress: "owner@example.invalid",
        refreshToken: "refresh-token-value",
      },
    });

    expect(vault.list()).toEqual([
      expect.objectContaining({
        grantId: "mailbox-personal",
        label: "Personal Microsoft mailbox",
        provider: "microsoft",
      }),
    ]);
    expect(vault.get("mailbox-personal")).toEqual({
      mailboxAddress: "owner@example.invalid",
      refreshToken: "refresh-token-value",
    });
    const databaseBytes = readFileSync(databasePath);
    expect(databaseBytes.includes(Buffer.from("refresh-token-value"))).toBe(false);
    expect(databaseBytes.includes(Buffer.from("owner@example.invalid"))).toBe(false);
    expect(statSync(databasePath).mode & 0o777).toBe(0o600);

    vault.put({
      grantId: "mailbox-personal",
      label: "Personal Microsoft mailbox",
      provider: "microsoft",
      secret: {
        mailboxAddress: "owner@example.invalid",
        refreshToken: "rotated-token-value",
      },
    });
    expect(vault.get("mailbox-personal")).toMatchObject({ refreshToken: "rotated-token-value" });

    expect(vault.revoke("mailbox-personal")).toBe(true);
    expect(vault.get("mailbox-personal")).toBeNull();
    vault.close();
  });
});
