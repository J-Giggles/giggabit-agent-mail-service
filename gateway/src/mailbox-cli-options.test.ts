import { describe, expect, it } from "vitest";

import { mailboxCliOptions } from "./mailbox-cli-options.js";

describe("mailbox CLI options", () => {
  it("parses only non-secret mailbox connection metadata", () => {
    const options = mailboxCliOptions([
      "node",
      "admin-main.js",
      "add-password",
      "--mailbox-address",
      "owner@example.invalid",
      "--grant-id",
      "hosted-owner",
      "--label",
      "Hosted owner",
      "--username",
      "owner@example.invalid",
      "--imap-host",
      "mail.example.invalid",
      "--imap-port",
      "993",
      "--imap-secure",
      "yes",
      "--smtp-host",
      "mail.example.invalid",
      "--smtp-port",
      "465",
      "--smtp-secure",
      "yes",
      "--password",
      "must-never-be-consumed",
    ]);

    expect(options).toEqual({
      mailboxAddress: "owner@example.invalid",
      grantId: "hosted-owner",
      label: "Hosted owner",
      username: "owner@example.invalid",
      imapHost: "mail.example.invalid",
      imapPort: "993",
      imapSecure: "yes",
      smtpHost: "mail.example.invalid",
      smtpPort: "465",
      smtpSecure: "yes",
    });
    expect(options).not.toHaveProperty("password");
  });

  it("leaves omitted values undefined for interactive prompting", () => {
    expect(mailboxCliOptions(["node", "admin-main.js", "add-password"])).toEqual({
      mailboxAddress: undefined,
      grantId: undefined,
      label: undefined,
      username: undefined,
      imapHost: undefined,
      imapPort: undefined,
      imapSecure: undefined,
      smtpHost: undefined,
      smtpPort: undefined,
      smtpSecure: undefined,
    });
  });
});
