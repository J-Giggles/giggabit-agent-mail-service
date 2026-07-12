#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { SqliteGatewayAudit } from "./audit.js";
import { deriveAuditKey } from "./audit-key.js";
import { BwrapAttachmentInspector } from "./attachment-inspector.js";
import { MailCircuitBreaker, SqliteMailCircuitStateStore } from "./circuit-breaker.js";
import { commandOption } from "./cli-options.js";
import { ClamAvScanner } from "./clamav-scanner.js";
import { readSystemdCredential } from "./credential-file.js";
import { HostMailGateway } from "./gateway.js";
import { GatewayHttpServer } from "./http-server.js";
import { AgentIdentityAuthority } from "./identity.js";
import { AgentIdentityRegistrationHandler } from "./identity-registration.js";
import { IdentityUnixServer } from "./identity-unix-server.js";
import { ImapSmtpProvider } from "./imap-smtp-provider.js";
import { GatewayMcpHandler } from "./mcp-handler.js";
import { VaultMailboxConnectionSource } from "./oauth-connection-source.js";
import { readOutboundLimits } from "./outbound-limits.js";
import { readOperatorConfig } from "./operator-config.js";
import { AttachmentQuarantine } from "./quarantine.js";
import { AgentRunEndHandler } from "./run-end-handler.js";
import { TailscaleCliVerifier } from "./tailnet.js";
import { CredentialVault } from "./vault.js";

function requiredOption(name: string): string {
  const value = commandOption(process.argv, name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const stateDirectory = requiredOption("--state-dir");
  const runtimeDirectory = requiredOption("--runtime-dir");
  const host = requiredOption("--host");
  const port = Number.parseInt(commandOption(process.argv, "--port") ?? "45873", 10);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) throw new Error("--port is invalid");

  const masterKey = readSystemdCredential("mail-vault-master");
  const auditKey = deriveAuditKey(masterKey);
  const vault = new CredentialVault({ databasePath: join(stateDirectory, "vault.sqlite"), masterKey });
  masterKey.fill(0);
  const audit = new SqliteGatewayAudit({ path: join(stateDirectory, "audit.sqlite"), hashKey: auditKey });
  auditKey.fill(0);
  const circuitStore = new SqliteMailCircuitStateStore(join(stateDirectory, "outbound-state.sqlite"));
  const circuitBreaker = new MailCircuitBreaker({ stateStore: circuitStore });
  const quarantine = new AttachmentQuarantine({
    root: join(runtimeDirectory, "attachments"),
    scanner: new ClamAvScanner(),
  });
  await quarantine.cleanupExpired();

  const connections = new VaultMailboxConnectionSource({ vault });
  const operatorConfig = await readOperatorConfig(commandOption(process.argv, "--operator-config"));
  const providers = vault.list().map((grant) => {
    const outboundLimits = readOutboundLimits(vault, grant.grantId);
    return new ImapSmtpProvider({
        grant: {
          grantId: grant.grantId,
          label: grant.label,
          provider: grant.provider,
          ...(outboundLimits ? { outboundLimits } : {}),
        },
        connections,
      });
  });
  const gateway = new HostMailGateway({
    providers,
    audit: (event) => audit.record(event),
    circuitBreaker,
    quarantine,
    attachmentInspector: new BwrapAttachmentInspector(),
    ...(operatorConfig.magicLinkPolicy ? { magicLinkPolicy: operatorConfig.magicLinkPolicy } : {}),
  });
  const tailnet = new TailscaleCliVerifier();
  const authority = new AgentIdentityAuthority({ signingKey: randomBytes(32) });
  const identityServer = new IdentityUnixServer({
    socketPath: join(runtimeDirectory, "identity.sock"),
    handler: new AgentIdentityRegistrationHandler({ authority, nodeIdentity: tailnet }),
  });
  await identityServer.start();
  const server = new GatewayHttpServer({
    host,
    port,
    handler: new GatewayMcpHandler({ authority, gateway, tailnet }),
    runEndHandler: new AgentRunEndHandler({ authority, tailnet, quarantine }),
  });
  try {
    await server.start();
  } catch (error) {
    await identityServer.stop();
    throw error;
  }
  process.stdout.write(`giggabit-agent-mail-service ready; grants=${providers.length}\n`);

  const cleanupTimer = setInterval(() => void quarantine.cleanupExpired().catch(() => undefined), 60 * 60 * 1_000);
  cleanupTimer.unref();
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  clearInterval(cleanupTimer);
  await server.stop();
  await identityServer.stop();
  circuitStore.close();
  audit.close();
  vault.close();
}

void main().catch(() => {
  process.stderr.write("giggabit-agent-mail-service failed to start safely.\n");
  process.exitCode = 1;
});
