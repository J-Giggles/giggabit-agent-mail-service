#!/usr/bin/env node

import { commandOption } from "./cli-options.js";
import { MagicLinkStagingApp } from "./magic-link-staging.js";

const LOOPBACK_HOST = "127.0.0.1";

async function main(): Promise<void> {
  const publicOrigin = commandOption(process.argv, "--public-origin");
  const controlSocketPath = commandOption(process.argv, "--control-socket");
  const portText = commandOption(process.argv, "--port") ?? "45874";
  const port = Number.parseInt(portText, 10);
  if (!publicOrigin) throw new Error("--public-origin is required");
  if (!controlSocketPath) throw new Error("--control-socket is required");
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) throw new Error("--port is invalid");

  const app = new MagicLinkStagingApp({ publicOrigin, controlSocketPath, port });
  const address = await app.start();
  if (!address.url.startsWith(`http://${LOOPBACK_HOST}:`)) {
    await app.stop();
    throw new Error("staging application did not bind to loopback");
  }

  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await app.stop();
}

main().catch(() => {
  process.stderr.write("Magic-link staging application failed.\n");
  process.exitCode = 1;
});
