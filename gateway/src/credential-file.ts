import { readFileSync } from "node:fs";
import { join } from "node:path";

const MASTER_KEY_BYTES = 32;

export function readSystemdCredential(name: string, environment: NodeJS.ProcessEnv = process.env): Buffer {
  const directory = environment.CREDENTIALS_DIRECTORY;
  if (!directory) throw new Error("systemd credential directory is unavailable");
  const value = readFileSync(join(directory, name));
  if (value.length !== MASTER_KEY_BYTES) throw new Error(`${name} must contain exactly 32 bytes`);
  return value;
}
