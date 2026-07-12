import { readFileSync } from "node:fs";

const metadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version?: unknown;
};

if (typeof metadata.version !== "string" || metadata.version.length === 0) {
  throw new Error("gateway package metadata does not contain a version");
}

export const packageVersion = metadata.version;
