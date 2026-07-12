import { isIP } from "node:net";

import type { MailServerEndpoint, MailboxConnection, MailboxConnectionSource } from "./imap-smtp-provider.js";
import { CredentialVault, type JsonValue, type MailboxSecret } from "./vault.js";

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1_000;

interface PasswordAuth {
  type: "password";
  password: string;
}

interface OAuthAuth {
  type: "oauth2";
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
}

interface ParsedMailboxSecret {
  mailboxAddress: string;
  username: string;
  imap: MailServerEndpoint;
  smtp: MailServerEndpoint;
  auth: PasswordAuth | OAuthAuth;
}

interface CachedAccessToken {
  value: string;
  expiresAt: number;
}

export interface VaultMailboxConnectionSourceOptions {
  vault: CredentialVault;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}

function requiredString(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`mailbox ${label} is invalid`);
  return value;
}

function endpoint(value: JsonValue | undefined, label: string): MailServerEndpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`mailbox ${label} is invalid`);
  const host = requiredString(value.host, `${label}.host`);
  const port = value.port;
  const secure = value.secure;
  if (!Number.isSafeInteger(port) || (port as number) <= 0 || (port as number) > 65_535 || typeof secure !== "boolean") {
    throw new Error(`mailbox ${label} is invalid`);
  }
  return { host, port: port as number, secure };
}

function parseAuth(value: JsonValue | undefined): PasswordAuth | OAuthAuth {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("mailbox auth is invalid");
  if (value.type === "password") {
    return { type: "password", password: requiredString(value.password, "auth.password") };
  }
  if (value.type === "oauth2") {
    const tokenEndpoint = requiredString(value.tokenEndpoint, "auth.tokenEndpoint");
    const parsedUrl = new URL(tokenEndpoint);
    if (
      parsedUrl.protocol !== "https:" ||
      parsedUrl.username ||
      parsedUrl.password ||
      parsedUrl.hostname === "localhost" ||
      isIP(parsedUrl.hostname) !== 0
    ) {
      throw new Error("mailbox OAuth token endpoint must be a public HTTPS hostname");
    }
    return {
      type: "oauth2",
      tokenEndpoint,
      clientId: requiredString(value.clientId, "auth.clientId"),
      ...(typeof value.clientSecret === "string" && value.clientSecret
        ? { clientSecret: value.clientSecret }
        : {}),
      refreshToken: requiredString(value.refreshToken, "auth.refreshToken"),
    };
  }
  throw new Error("mailbox auth type is invalid");
}

function parseSecret(secret: MailboxSecret): ParsedMailboxSecret {
  return {
    mailboxAddress: requiredString(secret.mailboxAddress, "mailboxAddress"),
    username: requiredString(secret.username, "username"),
    imap: endpoint(secret.imap, "imap"),
    smtp: endpoint(secret.smtp, "smtp"),
    auth: parseAuth(secret.auth),
  };
}

export class VaultMailboxConnectionSource implements MailboxConnectionSource {
  readonly #cache = new Map<string, CachedAccessToken>();
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => Date;
  readonly #vault: CredentialVault;

  constructor(options: VaultMailboxConnectionSourceOptions) {
    this.#vault = options.vault;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? (() => new Date());
  }

  async getConnection(grantId: string): Promise<MailboxConnection> {
    const rawSecret = this.#vault.get(grantId);
    if (!rawSecret) throw new Error("mailbox grant credentials were not found");
    const secret = parseSecret(rawSecret);
    if (secret.auth.type === "password") {
      return {
        mailboxAddress: secret.mailboxAddress,
        username: secret.username,
        password: secret.auth.password,
        imap: secret.imap,
        smtp: secret.smtp,
      };
    }

    const cached = this.#cache.get(grantId);
    if (cached && cached.expiresAt - TOKEN_REFRESH_BUFFER_MS > this.#now().getTime()) {
      return {
        mailboxAddress: secret.mailboxAddress,
        username: secret.username,
        accessToken: cached.value,
        imap: secret.imap,
        smtp: secret.smtp,
      };
    }

    const form = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: secret.auth.clientId,
      refresh_token: secret.auth.refreshToken,
    });
    if (secret.auth.clientSecret) form.set("client_secret", secret.auth.clientSecret);
    const response = await this.#fetch(secret.auth.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form,
      redirect: "error",
    });
    if (!response.ok) throw new Error("mailbox OAuth token refresh failed");
    const token: unknown = await response.json();
    if (!token || typeof token !== "object") throw new Error("mailbox OAuth token response is invalid");
    const fields = token as { access_token?: unknown; expires_in?: unknown; refresh_token?: unknown };
    if (
      typeof fields.access_token !== "string" ||
      !fields.access_token ||
      typeof fields.expires_in !== "number" ||
      !Number.isFinite(fields.expires_in) ||
      fields.expires_in <= 0
    ) {
      throw new Error("mailbox OAuth token response is invalid");
    }
    this.#cache.set(grantId, {
      value: fields.access_token,
      expiresAt: this.#now().getTime() + fields.expires_in * 1_000,
    });

    if (typeof fields.refresh_token === "string" && fields.refresh_token && fields.refresh_token !== secret.auth.refreshToken) {
      const summary = this.#vault.list().find((grant) => grant.grantId === grantId);
      if (!summary) throw new Error("mailbox grant metadata was not found");
      const nextSecret = structuredClone(rawSecret);
      const nextAuth = nextSecret.auth;
      if (!nextAuth || typeof nextAuth !== "object" || Array.isArray(nextAuth)) {
        throw new Error("mailbox auth is invalid");
      }
      nextAuth.refreshToken = fields.refresh_token;
      this.#vault.put({
        grantId,
        label: summary.label,
        provider: summary.provider,
        secret: nextSecret,
      });
    }

    return {
      mailboxAddress: secret.mailboxAddress,
      username: secret.username,
      accessToken: fields.access_token,
      imap: secret.imap,
      smtp: secret.smtp,
    };
  }
}
