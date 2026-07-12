#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "*.md"], {
  cwd: root,
  encoding: "utf8",
})
  .split("\n")
  .filter(Boolean);
const failures = [];

for (const file of files) {
  if (!existsSync(resolve(root, file))) continue;
  const text = readFileSync(resolve(root, file), "utf8");
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const raw = match[1]?.trim() ?? "";
    if (!raw || raw.startsWith("#") || /^(?:https?:|mailto:)/i.test(raw)) continue;
    const target = decodeURIComponent(raw.split("#", 1)[0] ?? "");
    if (!target || existsSync(resolve(root, dirname(file), target))) continue;
    failures.push(`${file}: missing local link target ${target}`);
  }
}

if (failures.length) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Local Markdown links passed.\n");
}
