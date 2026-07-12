import { describe, expect, it } from "vitest";

import { microsoftOAuthBase, microsoftTenant } from "./microsoft-tenant.js";

describe("Microsoft tenant selection", () => {
  it("preserves the personal-account consumers default", () => {
    expect(microsoftTenant(undefined)).toBe("consumers");
    expect(microsoftOAuthBase("consumers")).toBe(
      "https://login.microsoftonline.com/consumers/oauth2/v2.0",
    );
  });

  it("accepts tenant domains and identifiers", () => {
    expect(microsoftTenant(" SW-IFT.COM ")).toBe("sw-ift.com");
    expect(microsoftTenant("01234567-89ab-cdef-0123-456789abcdef")).toBe(
      "01234567-89ab-cdef-0123-456789abcdef",
    );
  });

  it.each([
    "",
    ".",
    "../consumers",
    "tenant/other",
    "https://login.microsoftonline.com/organizations",
    "tenant..example",
    "-tenant.example",
    "tenant.example-",
  ])("rejects unsafe tenant value %s", (value) => {
    expect(() => microsoftTenant(value)).toThrow("Microsoft tenant is invalid");
  });
});
