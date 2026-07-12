import type { CredentialVault, JsonValue } from "./vault.js";

type RevocationVault = Pick<CredentialVault, "get" | "list" | "revoke">;

function refreshToken(auth: JsonValue | undefined): string {
  if (!auth || typeof auth !== "object" || Array.isArray(auth) || typeof auth.refreshToken !== "string") {
    throw new Error("mailbox grant OAuth token is unavailable");
  }
  return auth.refreshToken;
}

export async function revokeMailboxGrant(
  vault: RevocationVault,
  grantId: string,
  request: typeof fetch = fetch,
): Promise<boolean> {
  const summary = vault.list().find((grant) => grant.grantId === grantId);
  if (!summary) return false;
  if (summary.provider === "google-oauth") {
    const secret = vault.get(grantId);
    if (!secret) return false;
    const response = await request("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refreshToken(secret.auth) }),
      redirect: "error",
    });
    if (!response.ok) throw new Error("mailbox provider revocation failed");
  }
  return vault.revoke(grantId);
}
