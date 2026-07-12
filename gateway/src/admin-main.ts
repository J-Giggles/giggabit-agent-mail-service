#!/usr/bin/env node

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { MailCircuitBreaker, SqliteMailCircuitStateStore } from "./circuit-breaker.js";
import { SqliteGatewayAudit } from "./audit.js";
import { deriveAuditKey } from "./audit-key.js";
import { commandOption } from "./cli-options.js";
import { readSystemdCredential } from "./credential-file.js";
import { revokeMailboxGrant } from "./grant-revocation.js";
import { ImapSmtpProvider } from "./imap-smtp-provider.js";
import { mailboxCliOptions, type MailboxCliOptions } from "./mailbox-cli-options.js";
import { microsoftOAuthBase, microsoftTenant } from "./microsoft-tenant.js";
import { VaultMailboxConnectionSource } from "./oauth-connection-source.js";
import { defaultOutboundLimits, readOutboundLimits } from "./outbound-limits.js";
import { ProviderVerificationHarness } from "./provider-verification.js";
import { CredentialVault, type MailboxSecret } from "./vault.js";

const input = process.stdin;
const output = process.stdout;
let prompt: ReturnType<typeof createInterface> | undefined;

function prompter(): ReturnType<typeof createInterface> {
  prompt ??= createInterface({ input, output });
  return prompt;
}

async function ask(label: string, fallback?: string): Promise<string> {
  const suffix = fallback ? ` [${fallback}]` : "";
  const value = (await prompter().question(`${label}${suffix}: `)).trim();
  const answer = value || fallback;
  if (!answer) throw new Error(`${label} is required`);
  return answer;
}

async function askSecret(label: string): Promise<string> {
  const hide = input.isTTY && output.isTTY;
  if (hide) execFileSync("stty", ["-echo"], { stdio: ["inherit", "inherit", "inherit"] });
  try {
    const value = await prompter().question(`${label}: `);
    output.write("\n");
    if (!value) throw new Error(`${label} is required`);
    return value;
  } finally {
    if (hide) execFileSync("stty", ["echo"], { stdio: ["inherit", "inherit", "inherit"] });
  }
}

function port(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 65_535) throw new Error("mail server port is invalid");
  return parsed;
}

function secure(value: string): boolean {
  if (/^(yes|true|1)$/i.test(value)) return true;
  if (/^(no|false|0)$/i.test(value)) return false;
  throw new Error("secure must be yes or no");
}

async function mailboxDetails(defaults?: {
  imapHost: string;
  imapPort: string;
  imapSecure: string;
  smtpHost: string;
  smtpPort: string;
  smtpSecure: string;
}, overrides: Partial<MailboxCliOptions> = {}) {
  const mailboxAddress = overrides.mailboxAddress ?? (await ask("Mailbox address"));
  return {
    grantId: overrides.grantId ?? (await ask("Grant ID (letters, digits, dots, dashes)")),
    label: overrides.label ?? (await ask("Private display label", "Mailbox")),
    mailboxAddress,
    username: overrides.username ?? (await ask("Login username", mailboxAddress)),
    imap: {
      host: overrides.imapHost ?? (await ask("IMAP host", defaults?.imapHost)),
      port: port(overrides.imapPort ?? (await ask("IMAP port", defaults?.imapPort))),
      secure: secure(overrides.imapSecure ?? (await ask("IMAP implicit TLS", defaults?.imapSecure))),
    },
    smtp: {
      host: overrides.smtpHost ?? (await ask("SMTP host", defaults?.smtpHost)),
      port: port(overrides.smtpPort ?? (await ask("SMTP port", defaults?.smtpPort))),
      secure: secure(overrides.smtpSecure ?? (await ask("SMTP implicit TLS", defaults?.smtpSecure))),
    },
  };
}

export async function microsoftDeviceAuthorization(
  clientId: string,
  tenant: string,
  dependencies: {
    now?: () => number;
    present?: (verificationUri: string, userCode: string) => void | Promise<void>;
    request?: typeof fetch;
    wait?: (milliseconds: number) => Promise<void>;
  } = {},
): Promise<string> {
  const now = dependencies.now ?? Date.now;
  const request = dependencies.request ?? fetch;
  const wait = dependencies.wait ?? ((milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)));
  const base = microsoftOAuthBase(tenant);
  const scope = "offline_access https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send";
  const deviceResponse = await request(`${base}/devicecode`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, scope }),
    redirect: "error",
  });
  if (!deviceResponse.ok) throw new Error("Microsoft device authorization could not start");
  const device = (await deviceResponse.json()) as {
    device_code?: unknown;
    user_code?: unknown;
    verification_uri?: unknown;
    expires_in?: unknown;
    interval?: unknown;
  };
  if (
    typeof device.device_code !== "string" ||
    typeof device.user_code !== "string" ||
    typeof device.verification_uri !== "string" ||
    typeof device.expires_in !== "number"
  ) {
    throw new Error("Microsoft device authorization response was invalid");
  }
  await (dependencies.present ?? ((verificationUri, userCode) => {
    output.write(`Open ${verificationUri} and enter code ${userCode}.\n`);
  }))(device.verification_uri, device.user_code);
  const deadline = now() + device.expires_in * 1_000;
  let interval = typeof device.interval === "number" ? device.interval : 5;
  while (now() < deadline) {
    await wait(interval * 1_000);
    const response = await request(`${base}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: clientId,
        device_code: device.device_code,
      }),
      redirect: "error",
    });
    const token = (await response.json()) as { error?: unknown; refresh_token?: unknown };
    if (response.ok && typeof token.refresh_token === "string" && token.refresh_token) return token.refresh_token;
    if (token.error === "authorization_pending") continue;
    if (token.error === "slow_down") {
      interval += 5;
      continue;
    }
    throw new Error("Microsoft device authorization failed");
  }
  throw new Error("Microsoft device authorization expired");
}

export async function googleAuthorization(
  clientId: string,
  clientSecret: string,
  dependencies: {
    present?: (authorizationUrl: string) => void | Promise<void>;
    request?: typeof fetch;
  } = {},
): Promise<string> {
  const request = dependencies.request ?? fetch;
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomUUID();
  let finish!: (value: string) => void;
  let fail!: (error: Error) => void;
  const code = new Promise<string>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  const callbackServer = createServer((request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/oauth/callback" || url.searchParams.get("state") !== state) {
        response.writeHead(400, { "content-type": "text/plain" }).end("Invalid OAuth callback.");
        return;
      }
      const authorizationCode = url.searchParams.get("code");
      if (!authorizationCode) throw new Error("Google authorization did not return a code");
      response
        .writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" })
        .end("Mailbox authorization received. You may close this tab.");
      finish(authorizationCode);
    } catch (error) {
      fail(error instanceof Error ? error : new Error("Google OAuth callback failed"));
    }
  });
  await new Promise<void>((resolve, reject) => {
    callbackServer.once("error", reject);
    callbackServer.listen(0, "127.0.0.1", resolve);
  });
  const address = callbackServer.address();
  if (!address || typeof address === "string") throw new Error("Google OAuth callback could not start");
  const redirectUri = `http://127.0.0.1:${address.port}/oauth/callback`;
  const authorizationUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authorizationUrl.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "https://mail.google.com/",
    access_type: "offline",
    prompt: "consent",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  await (dependencies.present ?? ((url) => {
    output.write(`Open this URL in a browser on this host:\n${url}\n`);
  }))(authorizationUrl.toString());
  const timeout = setTimeout(() => fail(new Error("Google authorization expired")), 10 * 60 * 1_000);
  let authorizationCode: string;
  try {
    authorizationCode = await code;
  } finally {
    clearTimeout(timeout);
    await new Promise<void>((resolve) => callbackServer.close(() => resolve()));
  }
  const response = await request("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code: authorizationCode,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
    redirect: "error",
  });
  const token = (await response.json()) as { refresh_token?: unknown };
  if (!response.ok || typeof token.refresh_token !== "string" || !token.refresh_token) {
    throw new Error("Google authorization did not return an offline refresh token");
  }
  return token.refresh_token;
}

function store(vault: CredentialVault, details: Awaited<ReturnType<typeof mailboxDetails>>, provider: string, auth: MailboxSecret["auth"]): void {
  vault.put({
    grantId: details.grantId,
    label: details.label,
    provider,
    secret: {
      mailboxAddress: details.mailboxAddress,
      username: details.username,
      imap: details.imap,
      smtp: details.smtp,
      auth,
      outboundLimits: defaultOutboundLimits(provider),
    },
  });
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const mailboxOverrides = mailboxCliOptions(process.argv);
  const stateDirectory = commandOption(process.argv, "--state-dir");
  if (!stateDirectory) throw new Error("--state-dir is required");
  if (command === "reset-circuit") {
    const grantId = await ask("Grant ID to unfreeze");
    const stateStore = new SqliteMailCircuitStateStore(join(stateDirectory, "outbound-state.sqlite"));
    new MailCircuitBreaker({ stateStore }).reset(grantId);
    stateStore.close();
    output.write("Outbound circuit reset.\n");
    return;
  }

  const masterKey = readSystemdCredential("mail-vault-master");
  const auditKey = deriveAuditKey(masterKey);
  const vault = new CredentialVault({ databasePath: join(stateDirectory, "vault.sqlite"), masterKey });
  masterKey.fill(0);
  try {
    if (command === "list") {
      for (const grant of vault.list()) output.write(`${grant.grantId}\t${grant.provider}\t${grant.label}\n`);
      return;
    }
    if (command === "revoke") {
      const grantId = await ask("Grant ID to revoke");
      output.write(
        (await revokeMailboxGrant(vault, grantId))
          ? "Mailbox grant revoked.\n"
          : "Mailbox grant was not found.\n",
      );
      return;
    }
    if (command === "verify") {
      const grantId = await ask("Grant ID to verify");
      const grant = vault.list().find((item) => item.grantId === grantId);
      if (!grant) throw new Error("mailbox grant was not found");
      const connections = new VaultMailboxConnectionSource({ vault });
      const connection = await connections.getConnection(grantId);
      const outboundLimits = readOutboundLimits(vault, grantId);
      const provider = new ImapSmtpProvider({
        grant: {
          grantId,
          label: grant.label,
          provider: grant.provider,
          ...(outboundLimits ? { outboundLimits } : {}),
        },
        connections,
      });
      const circuitStore = new SqliteMailCircuitStateStore(join(stateDirectory, "outbound-state.sqlite"));
      const audit = new SqliteGatewayAudit({ path: join(stateDirectory, "audit.sqlite"), hashKey: auditKey });
      let result;
      try {
        result = await new ProviderVerificationHarness({
          provider,
          testRecipient: connection.mailboxAddress,
          circuitBreaker: new MailCircuitBreaker({ stateStore: circuitStore }),
          audit: (event) => audit.record(event),
        }).run();
      } finally {
        circuitStore.close();
        audit.close();
      }
      output.write(`${JSON.stringify(result)}\n`);
      return;
    }
    if (command === "add-password") {
      const details = await mailboxDetails(undefined, mailboxOverrides);
      const password = await askSecret("Mailbox password or app password");
      store(vault, details, "imap-smtp", { type: "password", password });
      output.write("Mailbox grant stored in the encrypted vault. Restart the gateway to activate it.\n");
      return;
    }
    if (command === "add-microsoft") {
      const tenant = microsoftTenant(commandOption(process.argv, "--microsoft-tenant"));
      const details = await mailboxDetails({
        imapHost: "outlook.office365.com",
        imapPort: "993",
        imapSecure: "yes",
        smtpHost: "smtp.office365.com",
        smtpPort: "587",
        smtpSecure: "no",
      }, mailboxOverrides);
      const clientId = await ask("Your Microsoft public-client application ID");
      const refreshToken = await microsoftDeviceAuthorization(clientId, tenant);
      store(vault, details, "microsoft-oauth", {
        type: "oauth2",
        tokenEndpoint: `${microsoftOAuthBase(tenant)}/token`,
        clientId,
        refreshToken,
      });
      output.write("Microsoft mailbox grant stored in the encrypted vault. Restart the gateway to activate it.\n");
      return;
    }
    if (command === "add-google") {
      const details = await mailboxDetails({
        imapHost: "imap.gmail.com",
        imapPort: "993",
        imapSecure: "yes",
        smtpHost: "smtp.gmail.com",
        smtpPort: "465",
        smtpSecure: "yes",
      }, mailboxOverrides);
      const clientId = await ask("Your Google desktop OAuth client ID");
      const clientSecret = await askSecret("Your Google desktop OAuth client secret");
      const refreshToken = await googleAuthorization(clientId, clientSecret);
      store(vault, details, "google-oauth", {
        type: "oauth2",
        tokenEndpoint: "https://oauth2.googleapis.com/token",
        clientId,
        clientSecret,
        refreshToken,
      });
      output.write("Google mailbox grant stored in the encrypted vault. Restart the gateway to activate it.\n");
      return;
    }
    throw new Error("command must be list, revoke, verify, add-password, add-microsoft, add-google, or reset-circuit");
  } finally {
    auditKey.fill(0);
    vault.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main()
    .catch(() => {
      process.stderr.write("giggabit-agent-mail-service-admin could not complete the requested operation.\n");
      process.exitCode = 1;
    })
    .finally(() => prompt?.close());
}
