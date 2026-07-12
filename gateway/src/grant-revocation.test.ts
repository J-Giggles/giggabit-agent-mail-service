import { describe, expect, it, vi } from "vitest";

import { revokeMailboxGrant } from "./grant-revocation.js";

describe("mailbox grant revocation", () => {
  it("revokes a Google refresh token before deleting the local encrypted grant", async () => {
    const revoke = vi.fn(() => true);
    const request = vi.fn(async () => new Response(null, { status: 200 }));
    const vault = {
      list: () => [
        {
          grantId: "google-1",
          label: "Google",
          provider: "google-oauth",
          createdAt: "2026-07-11T10:00:00.000Z",
          updatedAt: "2026-07-11T10:00:00.000Z",
        },
      ],
      get: () => ({ auth: { type: "oauth2", refreshToken: "synthetic-refresh-token" } }),
      revoke,
    };

    await expect(revokeMailboxGrant(vault, "google-1", request)).resolves.toBe(true);
    expect(request).toHaveBeenCalledWith(
      "https://oauth2.googleapis.com/revoke",
      expect.objectContaining({ method: "POST", body: expect.any(URLSearchParams) }),
    );
    expect(revoke).toHaveBeenCalledWith("google-1");
  });

  it("retains the local grant when provider revocation fails", async () => {
    const revoke = vi.fn(() => true);
    const vault = {
      list: () => [
        {
          grantId: "google-1",
          label: "Google",
          provider: "google-oauth",
          createdAt: "2026-07-11T10:00:00.000Z",
          updatedAt: "2026-07-11T10:00:00.000Z",
        },
      ],
      get: () => ({ auth: { type: "oauth2", refreshToken: "synthetic-refresh-token" } }),
      revoke,
    };
    await expect(revokeMailboxGrant(vault, "google-1", async () => new Response(null, { status: 500 }))).rejects.toThrow(
      "provider revocation failed",
    );
    expect(revoke).not.toHaveBeenCalled();
  });
});
