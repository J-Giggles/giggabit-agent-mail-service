#!/usr/bin/env node

import { readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../gateway/node_modules");
const allowed = new Set([
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "MIT",
  "MIT-0",
  "MPL-2.0",
  "(MIT OR EUPL-1.1+)",
]);
const packages = new Map();
const failures = [];

function visit(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === ".cache") continue;
    const path = join(directory, entry.name);
    if (/(?:\/|^)(?:test|tests|fixtures)(?:\/|$)/.test(path)) continue;
    const manifestPath = join(path, "package.json");
    try {
      const value = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (typeof value.name === "string" && typeof value.version === "string") {
        const licence = typeof value.license === "string"
          ? value.license
          : typeof value.license?.type === "string"
            ? value.license.type
            : undefined;
        const key = `${value.name}@${value.version}`;
        if (!licence || !allowed.has(licence)) failures.push(`${key}: ${licence ?? "missing licence"}`);
        else packages.set(key, licence);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") failures.push(`${basename(path)}: unreadable package metadata`);
    }
    visit(path);
  }
}

try {
  visit(root);
} catch (error) {
  if (error?.code === "ENOENT") {
    process.stderr.write("Installed dependencies are unavailable; run ./scripts/verify.sh first.\n");
    process.exit(1);
  }
  throw error;
}

if (failures.length) {
  process.stderr.write(`${failures.sort().join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Dependency licences passed for ${packages.size} installed package versions.\n`);
}
