import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readOperatorConfig } from "./operator-config.js";

describe("Operator Configuration file seam", () => {
  it("keeps the Magic-Link Capability disabled when configuration is absent or disabled", async () => {
    const directory = await mkdtemp(join(tmpdir(), "operator-config-disabled-"));
    const path = join(directory, "operator.json");

    await expect(readOperatorConfig(undefined)).resolves.toEqual({});
    await writeFile(path, JSON.stringify({ magic_link: { enabled: false } }));
    await expect(readOperatorConfig(path)).resolves.toEqual({});
  });

  it("loads only an explicit grant, sender, and exact-host allowlist", async () => {
    const directory = await mkdtemp(join(tmpdir(), "operator-config-enabled-"));
    const path = join(directory, "operator.json");
    await writeFile(path, JSON.stringify({
      magic_link: {
        enabled: true,
        rules: [{
          grant_id: "test-grant",
          expected_senders: ["Login@Example.Invalid"],
          expected_hostnames: ["STAGING.EXAMPLE.INVALID"],
        }],
      },
    }));

    await expect(readOperatorConfig(path)).resolves.toEqual({
      magicLinkPolicy: {
        rules: [{
          grantId: "test-grant",
          expectedSenders: ["login@example.invalid"],
          expectedHostnames: ["staging.example.invalid"],
        }],
      },
    });
  });

  it("rejects unknown or incomplete security configuration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "operator-config-invalid-"));
    const path = join(directory, "operator.json");

    await writeFile(path, JSON.stringify({ magic_link: { enabled: true, rules: [] } }));
    await expect(readOperatorConfig(path)).rejects.toThrow("operator configuration is invalid");

    await writeFile(path, JSON.stringify({ password: "not-allowed" }));
    await expect(readOperatorConfig(path)).rejects.toThrow("operator configuration is invalid");
  });
});
