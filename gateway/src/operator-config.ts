import { readFile } from "node:fs/promises";

import { z } from "zod";

import type { MagicLinkPolicy } from "./gateway.js";

const sender = z.string().trim().min(3).max(320).refine(
  (value) => /^[^\s@]+@[^\s@]+$/.test(value),
  "expected sender must be an email address",
).transform((value) => value.toLowerCase());

const hostname = z.string().trim().min(1).max(253).refine(
  (value) => /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(value) && !value.includes(".."),
  "expected hostname must be an exact DNS hostname",
).transform((value) => value.toLowerCase());

const rule = z.object({
  grant_id: z.string().trim().min(1).max(128),
  expected_senders: z.array(sender).min(1),
  expected_hostnames: z.array(hostname).min(1),
}).strict();

const configSchema = z.object({
  magic_link: z.union([
    z.object({ enabled: z.literal(false) }).strict(),
    z.object({ enabled: z.literal(true), rules: z.array(rule).min(1) }).strict(),
  ]).optional(),
}).strict();

export interface OperatorConfig {
  magicLinkPolicy?: MagicLinkPolicy;
}

export async function readOperatorConfig(path: string | undefined): Promise<OperatorConfig> {
  if (!path) return {};
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    const config = configSchema.parse(value);
    if (!config.magic_link?.enabled) return {};
    return {
      magicLinkPolicy: {
        rules: config.magic_link.rules.map((value) => ({
          grantId: value.grant_id,
          expectedSenders: value.expected_senders,
          expectedHostnames: value.expected_hostnames,
        })),
      },
    };
  } catch {
    throw new Error("operator configuration is invalid");
  }
}
