#!/usr/bin/env node

import { randomUUID } from "node:crypto";

import { SignedGatewaySession } from "./agent-launcher.js";
import { commandOption } from "./cli-options.js";
import { runStdioProxy } from "./stdio-proxy.js";

async function main(): Promise<void> {
  const baseUrl = commandOption(process.argv, "--url");
  if (!baseUrl) throw new Error("--url is required");
  const enrollmentSocketPath = commandOption(process.argv, "--enrollment-socket");
  if (!enrollmentSocketPath) throw new Error("--enrollment-socket is required");
  const runId = commandOption(process.argv, "--run-id") ?? `run-${randomUUID()}`;
  const session = await SignedGatewaySession.connect({ baseUrl, enrollmentSocketPath, runId });
  try {
    await runStdioProxy({ input: process.stdin, output: process.stdout, session });
  } finally {
    await session.close();
  }
}

void main().catch(() => {
  process.stderr.write("giggabit-agent-mail-service-agent could not establish a protected service session.\n");
  process.exitCode = 1;
});
