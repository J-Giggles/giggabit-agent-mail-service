import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptsDirectory = fileURLToPath(new URL(".", import.meta.url));
const checker = join(scriptsDirectory, "check-release-metadata.mjs");
const fixture = mkdtempSync(join(tmpdir(), "mail-service-release-metadata-"));
const packagePath = join(fixture, "package.json");
const pluginPath = join(fixture, "plugin.json");

function check(packageVersion, pluginVersion) {
  writeFileSync(packagePath, JSON.stringify({ version: packageVersion }));
  writeFileSync(pluginPath, JSON.stringify({ version: pluginVersion }));
  return spawnSync(process.execPath, [checker, packagePath, pluginPath], { encoding: "utf8" });
}

const matching = check("0.1.1", "0.1.1");
if (matching.status !== 0) {
  throw new Error(`matching future versions should pass: ${matching.stderr}`);
}

const mismatch = check("0.1.1", "0.1.0");
if (mismatch.status === 0) {
  throw new Error("mismatched package and plugin versions should fail");
}

const invalid = check("next", "next");
if (invalid.status === 0) {
  throw new Error("non-semver release versions should fail");
}

for (const invalidVersion of ["1.2.3-..", "1.2.3-01"]) {
  const malformed = check(invalidVersion, invalidVersion);
  if (malformed.status === 0) {
    throw new Error(`invalid semantic version passed: ${invalidVersion}`);
  }
}

process.stdout.write("Release metadata behavior passed.\n");
