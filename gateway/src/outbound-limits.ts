import type { MailboxGrantDescriptor } from "./provider.js";
import type { CredentialVault, JsonValue } from "./vault.js";

export type OutboundLimits = NonNullable<MailboxGrantDescriptor["outboundLimits"]>;

export function defaultOutboundLimits(provider: string): OutboundLimits {
  return {
    perMinute: 10,
    perHour: 50,
    perDay: provider === "microsoft-oauth" || provider === "google-oauth" ? 100 : 200,
    maxRecipients: 25,
  };
}

function positiveInteger(value: JsonValue | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`mailbox ${label} is invalid`);
  return value as number;
}

export function readOutboundLimits(
  vault: Pick<CredentialVault, "get">,
  grantId: string,
): OutboundLimits | undefined {
  const secret = vault.get(grantId);
  const value = secret?.outboundLimits;
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("mailbox outbound limits are invalid");
  const limits = {
    perMinute: positiveInteger(value.perMinute, "outboundLimits.perMinute"),
    perHour: positiveInteger(value.perHour, "outboundLimits.perHour"),
    perDay: positiveInteger(value.perDay, "outboundLimits.perDay"),
    maxRecipients: positiveInteger(value.maxRecipients, "outboundLimits.maxRecipients"),
  };
  return Object.fromEntries(Object.entries(limits).filter((entry) => entry[1] !== undefined)) as OutboundLimits;
}
