import { describe, expect, it } from "vitest";

import { isAutomaticResponse } from "./imap-smtp-provider.js";

describe("automatic response detection", () => {
  it.each([
    { autoSubmitted: "auto-replied" },
    { precedence: "bulk" },
    { listId: "list.example.invalid" },
    { returnPath: "<>" },
    { xAutoReply: "yes" },
    { from: "MAILER-DAEMON@example.invalid" },
  ])("rejects automatic or robot mail: %o", (headers) => {
    expect(isAutomaticResponse(headers)).toBe(true);
  });

  it("allows a normal human-authored message", () => {
    expect(isAutomaticResponse({ autoSubmitted: "no", from: "person@example.invalid" })).toBe(false);
  });
});
