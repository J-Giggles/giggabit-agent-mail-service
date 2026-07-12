#!/usr/bin/env node

function version(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value);
  if (!match) throw new Error("version must use semantic version syntax");
  return match.slice(1, 4).map(Number);
}

function compare(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

const [mode, first, second] = process.argv.slice(2);
try {
  if (!mode || !first || !second) throw new Error("usage: version-policy.mjs at-least|upgrade FIRST SECOND");
  const comparison = compare(version(first), version(second));
  if (mode === "at-least" && comparison < 0) throw new Error(`${first} is older than required ${second}`);
  if (mode === "upgrade" && comparison > 0) throw new Error(`refusing downgrade from ${first} to ${second}`);
  if (mode !== "at-least" && mode !== "upgrade") throw new Error("unknown version policy");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "version policy failed"}\n`);
  process.exitCode = 1;
}
