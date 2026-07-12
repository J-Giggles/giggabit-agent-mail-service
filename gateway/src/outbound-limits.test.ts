import { describe, expect, it } from "vitest";

import { defaultOutboundLimits, readOutboundLimits } from "./outbound-limits.js";

describe("provider-specific outbound limits", () => {
  it("uses a conservative provider policy and reads encrypted grant overrides", () => {
    expect(defaultOutboundLimits("google-oauth")).toMatchObject({ perDay: 100, maxRecipients: 25 });
    expect(
      readOutboundLimits(
        { get: () => ({ outboundLimits: { perMinute: 2, perHour: 10, perDay: 20, maxRecipients: 5 } }) },
        "mailbox-1",
      ),
    ).toEqual({ perMinute: 2, perHour: 10, perDay: 20, maxRecipients: 5 });
  });
});
