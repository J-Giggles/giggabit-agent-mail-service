#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const command = "/usr/local/bin/giggabit-agent-mail-service-agent";
const expectedName = "giggabit-agent-mail-service";
const expectedVersion = JSON.parse(
  readFileSync(new URL("../gateway/package.json", import.meta.url), "utf8"),
).version;
const timeoutMs = 15_000;

const child = spawn(command, [], { stdio: ["pipe", "pipe", "pipe"] });
let stdout = "";
let stderr = "";
let timedOut = false;

const timer = setTimeout(() => {
  timedOut = true;
  child.kill("SIGKILL");
}, timeoutMs);

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdout += chunk;
  if (stdout.length > 64 * 1024) child.kill("SIGKILL");
});

child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr = `${stderr}${chunk}`.slice(-4096);
});

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "giggabit-agent-mail-service-verifier", version: "1.0.0" },
  },
};
child.stdin.end(`${JSON.stringify(initialize)}\n`);

const exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", (code) => resolve(code));
});
clearTimeout(timer);

if (timedOut) throw new Error("initialize process timed out");
if (exitCode !== 0) {
  const stage = stderr.includes("could not establish a protected service session")
    ? "agent enrollment or session cleanup failed"
    : "agent process failed";
  throw new Error(`${stage} with exit code ${exitCode}`);
}
const lines = stdout.split("\n").filter((line) => line.trim());
if (lines.length !== 1) throw new Error("initialize process returned an unexpected number of responses");
let response;
try {
  response = JSON.parse(lines[0]);
} catch {
  throw new Error("initialize response was not valid JSON");
}
if (response.jsonrpc !== "2.0" || response.id !== 1) {
  throw new Error("initialize response did not match the request identity");
}
const serverInfo = response.result?.serverInfo;
if (!serverInfo) throw new Error("initialize response did not contain serverInfo");
if (serverInfo.name !== expectedName || serverInfo.version !== expectedVersion) {
  throw new Error("initialize response reported an unexpected server identity");
}

process.stdout.write(`${JSON.stringify(serverInfo)}\n`);
