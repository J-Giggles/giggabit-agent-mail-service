import { commandOption } from "./cli-options.js";

export interface MailboxCliOptions {
  mailboxAddress: string | undefined;
  grantId: string | undefined;
  label: string | undefined;
  username: string | undefined;
  imapHost: string | undefined;
  imapPort: string | undefined;
  imapSecure: string | undefined;
  smtpHost: string | undefined;
  smtpPort: string | undefined;
  smtpSecure: string | undefined;
}

export function mailboxCliOptions(argv: string[]): MailboxCliOptions {
  return {
    mailboxAddress: commandOption(argv, "--mailbox-address"),
    grantId: commandOption(argv, "--grant-id"),
    label: commandOption(argv, "--label"),
    username: commandOption(argv, "--username"),
    imapHost: commandOption(argv, "--imap-host"),
    imapPort: commandOption(argv, "--imap-port"),
    imapSecure: commandOption(argv, "--imap-secure"),
    smtpHost: commandOption(argv, "--smtp-host"),
    smtpPort: commandOption(argv, "--smtp-port"),
    smtpSecure: commandOption(argv, "--smtp-secure"),
  };
}
