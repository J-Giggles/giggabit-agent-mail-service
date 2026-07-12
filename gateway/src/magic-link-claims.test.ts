import { constants, createDecipheriv, generateKeyPairSync, privateDecrypt, type KeyObject } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { HostMailGateway } from "./gateway.js";
import type { MailMessageDetail, MailboxProvider } from "./provider.js";

const magicLinkPolicy = {
  rules: [
    {
      grantId: "mailbox-1",
      expectedSenders: ["login@example.invalid"],
      expectedHostnames: ["staging.example.invalid"],
    },
  ],
};

function decryptMagicLink(result: Record<string, unknown>, privateKey: KeyObject): string {
  const contentKey = privateDecrypt(
    { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(result.encrypted_key as string, "base64"),
  );
  const decipher = createDecipheriv(
    "aes-256-gcm",
    contentKey,
    Buffer.from(result.iv as string, "base64"),
  );
  decipher.setAuthTag(Buffer.from(result.auth_tag as string, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(result.ciphertext as string, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

describe("Magic-link claim gateway seam", () => {
  it("rejects a claim outside the operator sender and exact-host policy", async () => {
    const search = vi.fn(async () => []);
    const provider: MailboxProvider = {
      grant: { grantId: "mailbox-1", label: "Test mailbox", provider: "fake" },
      listFolders: async () => [],
      search,
      read: async () => { throw new Error("not used"); },
    };
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const gateway = new HostMailGateway({ providers: [provider], audit: () => undefined, magicLinkPolicy });

    await expect(
      gateway.callTool(
        { tokenId: "token-policy", runId: "run-policy", nodeId: "node-1", expiresAt: "2026-07-12T09:00:00.000Z" },
        "magic_link",
        {
          action: "claim",
          grant_id: "mailbox-1",
          attempt_id: "attempt-policy",
          request_time: "2026-07-12T07:59:00.000Z",
          recipient_alias: "test-alias@example.invalid",
          expected_sender: "attacker@example.invalid",
          expected_hostname: "lookalike.example.invalid",
          public_key: publicKey.export({ type: "spki", format: "pem" }).toString(),
        },
      ),
    ).rejects.toThrow("magic link is not allowed by operator policy");
    expect(search).not.toHaveBeenCalled();
  });

  it("claims only the newer expected-sender message and returns an encrypted bearer URL", async () => {
    const now = new Date("2026-07-12T08:00:00.000Z");
    const requestTime = "2026-07-12T07:59:00.000Z";
    const validDetail: MailMessageDetail = {
      messageRef: "INBOX:valid",
      folder: "INBOX",
      subject: "Sign in",
      from: "login@example.invalid",
      to: ["test-alias@example.invalid"],
      receivedAt: "2026-07-12T07:59:30.000Z",
      text: "Open https://staging.example.invalid/auth/callback?token=secret-value",
      attachments: [],
    };
    const provider: MailboxProvider = {
      grant: { grantId: "mailbox-1", label: "Test mailbox", provider: "fake" },
      listFolders: async () => [],
      search: async () => [
        { ...validDetail, messageRef: "INBOX:old", receivedAt: "2026-07-12T07:58:59.000Z", snippet: "old" },
        { ...validDetail, messageRef: "INBOX:wrong", from: "attacker@example.invalid", snippet: "wrong" },
        { ...validDetail, snippet: "valid" },
      ],
      read: async ({ messageRef }) => {
        if (messageRef !== validDetail.messageRef) throw new Error("unexpected message read");
        return validDetail;
      },
    };
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const gateway = new HostMailGateway({
      providers: [provider],
      audit: () => undefined,
      magicLinkPolicy,
      now: () => now,
    });

    const result = await gateway.callTool(
      { tokenId: "token-1", runId: "run-1", nodeId: "node-1", expiresAt: "2026-07-12T09:00:00.000Z" },
      "magic_link",
      {
        action: "claim",
        grant_id: "mailbox-1",
        folder: "INBOX",
        attempt_id: "attempt-1",
        request_time: requestTime,
        recipient_alias: "test-alias@example.invalid",
        expected_sender: "login@example.invalid",
        expected_hostname: "staging.example.invalid",
        public_key: publicKey.export({ type: "spki", format: "pem" }).toString(),
      },
    );

    expect(result).toMatchObject({
      action: "claim",
      attempt_id: "attempt-1",
      algorithm: "RSA-OAEP-256+A256GCM",
      trust: "ephemeral_bearer_ciphertext",
    });
    expect(typeof result.claim_id).toBe("string");
    expect(typeof result.ciphertext).toBe("string");
    expect(JSON.stringify(result)).not.toContain("https://");
    expect(decryptMagicLink(result, privateKey)).toBe(
      "https://staging.example.invalid/auth/callback?token=secret-value",
    );
  });

  it("accepts an HTML-only link while keeping the link out of the tool result", async () => {
    const detail = {
      messageRef: "INBOX:html",
      folder: "INBOX",
      subject: "Sign in",
      from: "login@example.invalid",
      to: ["test-alias@example.invalid"],
      receivedAt: "2026-07-12T07:59:30.000Z",
      text: "",
      html: '<p><a href="https://staging.example.invalid/auth/callback?token=html-secret&amp;next=%2Fhome">Continue</a></p>',
      attachments: [],
    } satisfies MailMessageDetail & { html: string };
    const provider: MailboxProvider = {
      grant: { grantId: "mailbox-1", label: "Test mailbox", provider: "fake" },
      listFolders: async () => [],
      search: async () => [{ ...detail, snippet: "Continue" }],
      read: async () => detail,
    };
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const gateway = new HostMailGateway({
      providers: [provider],
      audit: () => undefined,
      magicLinkPolicy,
      now: () => new Date("2026-07-12T08:00:00.000Z"),
    });

    const result = await gateway.callTool(
      { tokenId: "token-1", runId: "run-html", nodeId: "node-1", expiresAt: "2026-07-12T09:00:00.000Z" },
      "magic_link",
      {
        action: "claim",
        grant_id: "mailbox-1",
        attempt_id: "attempt-html",
        request_time: "2026-07-12T07:59:00.000Z",
        recipient_alias: "test-alias@example.invalid",
        expected_sender: "login@example.invalid",
        expected_hostname: "staging.example.invalid",
        public_key: publicKey.export({ type: "spki", format: "pem" }).toString(),
      },
    );

    expect(JSON.stringify(result)).not.toContain("html-secret");
    expect(decryptMagicLink(result, privateKey)).toBe(
      "https://staging.example.invalid/auth/callback?token=html-secret&next=%2Fhome",
    );
  });

  it("prevents two agent runs from claiming the same message", async () => {
    const detail: MailMessageDetail = {
      messageRef: "INBOX:shared",
      folder: "INBOX",
      subject: "Sign in",
      from: "login@example.invalid",
      to: ["test-alias@example.invalid"],
      receivedAt: "2026-07-12T07:59:30.000Z",
      text: "https://staging.example.invalid/auth/callback?token=shared-secret",
      attachments: [],
    };
    const provider: MailboxProvider = {
      grant: { grantId: "mailbox-1", label: "Test mailbox", provider: "fake" },
      listFolders: async () => [],
      search: async () => [{ ...detail, snippet: "Sign in" }],
      read: async () => detail,
    };
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const gateway = new HostMailGateway({
      providers: [provider],
      audit: () => undefined,
      magicLinkPolicy,
      now: () => new Date("2026-07-12T08:00:00.000Z"),
    });
    const input = {
      action: "claim",
      grant_id: "mailbox-1",
      attempt_id: "attempt-shared",
      request_time: "2026-07-12T07:59:00.000Z",
      recipient_alias: "test-alias@example.invalid",
      expected_sender: "login@example.invalid",
      expected_hostname: "staging.example.invalid",
      public_key: publicKey.export({ type: "spki", format: "pem" }).toString(),
    };

    await gateway.callTool(
      { tokenId: "token-1", runId: "run-1", nodeId: "node-1", expiresAt: "2026-07-12T09:00:00.000Z" },
      "magic_link",
      input,
    );
    await expect(
      gateway.callTool(
        { tokenId: "token-2", runId: "run-2", nodeId: "node-1", expiresAt: "2026-07-12T09:00:00.000Z" },
        "magic_link",
        { ...input, attempt_id: "attempt-other" },
      ),
    ).rejects.toThrow("magic link message is already claimed");
  });

  it.each([
    ["an HTTP destination", "http://staging.example.invalid/auth/callback?token=secret"],
    ["a lookalike subdomain", "https://staging.example.invalid.attacker.test/auth/callback?token=secret"],
    [
      "multiple candidate links",
      "https://staging.example.invalid/auth/first?token=one https://staging.example.invalid/auth/second?token=two",
    ],
  ])("rejects %s", async (_caseName, text) => {
    const detail: MailMessageDetail = {
      messageRef: "INBOX:invalid",
      folder: "INBOX",
      subject: "Sign in",
      from: "login@example.invalid",
      to: ["test-alias@example.invalid"],
      receivedAt: "2026-07-12T07:59:30.000Z",
      text,
      attachments: [],
    };
    const provider: MailboxProvider = {
      grant: { grantId: "mailbox-1", label: "Test mailbox", provider: "fake" },
      listFolders: async () => [],
      search: async () => [{ ...detail, snippet: "Sign in" }],
      read: async () => detail,
    };
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const gateway = new HostMailGateway({ providers: [provider], audit: () => undefined, magicLinkPolicy });

    await expect(
      gateway.callTool(
        { tokenId: "token-invalid", runId: "run-invalid", nodeId: "node-1", expiresAt: "2026-07-12T09:00:00.000Z" },
        "magic_link",
        {
          action: "claim",
          grant_id: "mailbox-1",
          attempt_id: "attempt-invalid",
          request_time: "2026-07-12T07:59:00.000Z",
          recipient_alias: "test-alias@example.invalid",
          expected_sender: "login@example.invalid",
          expected_hostname: "staging.example.invalid",
          public_key: publicKey.export({ type: "spki", format: "pem" }).toString(),
        },
      ),
    ).rejects.toThrow("magic link message is ambiguous or invalid");
  });

  it("expires an abandoned claim before allowing another run to reclaim the message", async () => {
    const detail: MailMessageDetail = {
      messageRef: "INBOX:expired",
      folder: "INBOX",
      subject: "Sign in",
      from: "login@example.invalid",
      to: ["test-alias@example.invalid"],
      receivedAt: "2026-07-12T07:59:30.000Z",
      text: "https://staging.example.invalid/auth/callback?token=expiry-secret",
      attachments: [],
    };
    const provider: MailboxProvider = {
      grant: { grantId: "mailbox-1", label: "Test mailbox", provider: "fake" },
      listFolders: async () => [],
      search: async () => [{ ...detail, snippet: "Sign in" }],
      read: async () => detail,
    };
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    let now = new Date("2026-07-12T08:00:00.000Z");
    const gateway = new HostMailGateway({
      providers: [provider],
      audit: () => undefined,
      magicLinkPolicy,
      now: () => now,
    });
    const input = {
      action: "claim",
      grant_id: "mailbox-1",
      attempt_id: "attempt-expiry",
      request_time: "2026-07-12T07:59:00.000Z",
      recipient_alias: "test-alias@example.invalid",
      expected_sender: "login@example.invalid",
      expected_hostname: "staging.example.invalid",
      public_key: publicKey.export({ type: "spki", format: "pem" }).toString(),
    };

    await gateway.callTool(
      { tokenId: "token-first", runId: "run-first", nodeId: "node-1", expiresAt: "2026-07-12T09:00:00.000Z" },
      "magic_link",
      input,
    );
    now = new Date("2026-07-12T08:05:00.001Z");

    await expect(
      gateway.callTool(
        { tokenId: "token-next", runId: "run-next", nodeId: "node-1", expiresAt: "2026-07-12T09:00:00.000Z" },
        "magic_link",
        { ...input, attempt_id: "attempt-after-expiry" },
      ),
    ).resolves.toMatchObject({ action: "claim", attempt_id: "attempt-after-expiry" });
  });

  it("allows only the claiming run to consume and recoverably trash the message", async () => {
    const detail: MailMessageDetail = {
      messageRef: "INBOX:consume",
      folder: "INBOX",
      subject: "Sign in",
      from: "login@example.invalid",
      to: ["test-alias@example.invalid"],
      receivedAt: "2026-07-12T07:59:30.000Z",
      text: "https://staging.example.invalid/auth/callback?token=consume-secret",
      attachments: [],
    };
    const trash = vi.fn(async () => ({ messageRef: "Trash:consumed", folder: "Trash" }));
    const provider: MailboxProvider = {
      grant: { grantId: "mailbox-1", label: "Test mailbox", provider: "fake" },
      listFolders: async () => [],
      search: async () => [{ ...detail, snippet: "Sign in" }],
      read: async () => detail,
      trash,
    };
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const gateway = new HostMailGateway({
      providers: [provider],
      audit: () => undefined,
      magicLinkPolicy,
      now: () => new Date("2026-07-12T08:00:00.000Z"),
    });
    const owner = { tokenId: "token-1", runId: "run-owner", nodeId: "node-1", expiresAt: "2026-07-12T09:00:00.000Z" };
    const claim = await gateway.callTool(owner, "magic_link", {
      action: "claim",
      grant_id: "mailbox-1",
      attempt_id: "attempt-consume",
      request_time: "2026-07-12T07:59:00.000Z",
      recipient_alias: "test-alias@example.invalid",
      expected_sender: "login@example.invalid",
      expected_hostname: "staging.example.invalid",
      public_key: publicKey.export({ type: "spki", format: "pem" }).toString(),
    });

    await expect(
      gateway.callTool(
        { ...owner, tokenId: "token-2", runId: "run-other" },
        "magic_link",
        { action: "consume", grant_id: "mailbox-1", claim_id: claim.claim_id },
      ),
    ).rejects.toThrow("magic link claim does not belong to this run");
    const consumed = await gateway.callTool(owner, "magic_link", {
      action: "consume",
      grant_id: "mailbox-1",
      claim_id: claim.claim_id,
    });

    expect(consumed).toEqual({
      action: "consume",
      grant_id: "mailbox-1",
      claim_id: claim.claim_id,
      consumed: true,
    });
    expect(trash).toHaveBeenCalledOnce();
    expect(JSON.stringify(consumed)).not.toContain("INBOX:consume");
    expect(JSON.stringify(consumed)).not.toContain("Trash:consumed");
  });

  it("allows only the claiming run to release a message for another attempt", async () => {
    const detail: MailMessageDetail = {
      messageRef: "INBOX:release",
      folder: "INBOX",
      subject: "Sign in",
      from: "login@example.invalid",
      to: ["test-alias@example.invalid"],
      receivedAt: "2026-07-12T07:59:30.000Z",
      text: "https://staging.example.invalid/auth/callback?token=release-secret",
      attachments: [],
    };
    const provider: MailboxProvider = {
      grant: { grantId: "mailbox-1", label: "Test mailbox", provider: "fake" },
      listFolders: async () => [],
      search: async () => [{ ...detail, snippet: "Sign in" }],
      read: async () => detail,
    };
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const gateway = new HostMailGateway({
      providers: [provider],
      audit: () => undefined,
      magicLinkPolicy,
      now: () => new Date("2026-07-12T08:00:00.000Z"),
    });
    const owner = { tokenId: "token-1", runId: "run-owner", nodeId: "node-1", expiresAt: "2026-07-12T09:00:00.000Z" };
    const other = { ...owner, tokenId: "token-2", runId: "run-other" };
    const input = {
      action: "claim",
      grant_id: "mailbox-1",
      attempt_id: "attempt-release",
      request_time: "2026-07-12T07:59:00.000Z",
      recipient_alias: "test-alias@example.invalid",
      expected_sender: "login@example.invalid",
      expected_hostname: "staging.example.invalid",
      public_key: publicKey.export({ type: "spki", format: "pem" }).toString(),
    };
    const claim = await gateway.callTool(owner, "magic_link", input);

    await expect(
      gateway.callTool(other, "magic_link", { action: "release", grant_id: "mailbox-1", claim_id: claim.claim_id }),
    ).rejects.toThrow("magic link claim does not belong to this run");
    await expect(
      gateway.callTool(owner, "magic_link", { action: "release", grant_id: "mailbox-1", claim_id: claim.claim_id }),
    ).resolves.toEqual({ action: "release", grant_id: "mailbox-1", claim_id: claim.claim_id, released: true });
    await expect(
      gateway.callTool(other, "magic_link", { ...input, attempt_id: "attempt-after-release" }),
    ).resolves.toMatchObject({ action: "claim", attempt_id: "attempt-after-release" });
  });

  it("encrypts a long bearer URL without relying on the RSA payload limit", async () => {
    const longUrl = `https://staging.example.invalid/auth/callback?token=${"x".repeat(600)}`;
    const detail: MailMessageDetail = {
      messageRef: "INBOX:long",
      folder: "INBOX",
      subject: "Sign in",
      from: "login@example.invalid",
      to: ["test-alias@example.invalid"],
      receivedAt: "2026-07-12T07:59:30.000Z",
      text: longUrl,
      attachments: [],
    };
    const provider: MailboxProvider = {
      grant: { grantId: "mailbox-1", label: "Test mailbox", provider: "fake" },
      listFolders: async () => [],
      search: async () => [{ ...detail, snippet: "Sign in" }],
      read: async () => detail,
    };
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const gateway = new HostMailGateway({ providers: [provider], audit: () => undefined, magicLinkPolicy });

    await expect(
      gateway.callTool(
        { tokenId: "token-long", runId: "run-long", nodeId: "node-1", expiresAt: "2026-07-12T09:00:00.000Z" },
        "magic_link",
        {
          action: "claim",
          grant_id: "mailbox-1",
          attempt_id: "attempt-long",
          request_time: "2026-07-12T07:59:00.000Z",
          recipient_alias: "test-alias@example.invalid",
          expected_sender: "login@example.invalid",
          expected_hostname: "staging.example.invalid",
          public_key: publicKey.export({ type: "spki", format: "pem" }).toString(),
        },
      ),
    ).resolves.toMatchObject({ action: "claim", attempt_id: "attempt-long" });
  });

  it("rejects an encryption key below RSA-2048", async () => {
    const detail: MailMessageDetail = {
      messageRef: "INBOX:weak-key",
      folder: "INBOX",
      subject: "Sign in",
      from: "login@example.invalid",
      to: ["test-alias@example.invalid"],
      receivedAt: "2026-07-12T07:59:30.000Z",
      text: "https://staging.example.invalid/auth/callback?token=secret",
      attachments: [],
    };
    const provider: MailboxProvider = {
      grant: { grantId: "mailbox-1", label: "Test mailbox", provider: "fake" },
      listFolders: async () => [],
      search: async () => [{ ...detail, snippet: "Sign in" }],
      read: async () => detail,
    };
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 1024 });
    const gateway = new HostMailGateway({ providers: [provider], audit: () => undefined, magicLinkPolicy });

    await expect(
      gateway.callTool(
        { tokenId: "token-weak", runId: "run-weak", nodeId: "node-1", expiresAt: "2026-07-12T09:00:00.000Z" },
        "magic_link",
        {
          action: "claim",
          grant_id: "mailbox-1",
          attempt_id: "attempt-weak",
          request_time: "2026-07-12T07:59:00.000Z",
          recipient_alias: "test-alias@example.invalid",
          expected_sender: "login@example.invalid",
          expected_hostname: "staging.example.invalid",
          public_key: publicKey.export({ type: "spki", format: "pem" }).toString(),
        },
      ),
    ).rejects.toThrow("public_key must be RSA-2048 or stronger");
  });
});
