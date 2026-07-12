import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const packagePath = resolve(process.argv[2] ?? "gateway/package.json");
const pluginPath = resolve(process.argv[3] ?? "plugin/.codex-plugin/plugin.json");
const packageMetadata = JSON.parse(readFileSync(packagePath, "utf8"));
const pluginMetadata = JSON.parse(readFileSync(pluginPath, "utf8"));
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

if (typeof packageMetadata.version !== "string" || !semver.test(packageMetadata.version)) {
  process.stderr.write("gateway package version must be valid semantic versioning\n");
  process.exit(1);
}
if (pluginMetadata.version !== packageMetadata.version) {
  process.stderr.write("gateway package and plugin versions must match\n");
  process.exit(1);
}

process.stdout.write(`${packageMetadata.version}\n`);
