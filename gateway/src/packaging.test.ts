import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("system package templates", () => {
  it("runs every installed runtime entrypoint from the root-owned /opt payload", async () => {
    const templates = await Promise.all(
      [
        "giggabit-agent-mail-service.in",
        "giggabit-agent-mail-service-agent.in",
        "giggabit-agent-mail-service-admin-root.in",
      ].map((name) =>
        readFile(join(packageRoot, "bin", name), "utf8"),
      ),
    );
    expect(templates.join("\n")).not.toContain(".local/lib/giggabit-agent-mail-service");
    expect(templates[0]).toContain("/opt/giggabit-agent-mail-service/dist/service-main.js");
    expect(templates[1]).toContain("/opt/giggabit-agent-mail-service/dist/launcher-main.js");
    expect(templates[2]).toContain("/opt/giggabit-agent-mail-service/dist/admin-main.js");
  });

  it("uses one canonical identity for package, service, state, and runtime paths", async () => {
    const [manifestText, unit] = await Promise.all([
      readFile(join(packageRoot, "package.json"), "utf8"),
      readFile(join(packageRoot, "systemd", "giggabit-agent-mail-service.service.in"), "utf8"),
    ]);
    const manifest = JSON.parse(manifestText) as { name: string; bin: Record<string, string> };

    expect(manifest.name).toBe("@giggabit/agent-mail-service");
    expect(Object.keys(manifest.bin)).toEqual([
      "giggabit-agent-mail-service",
      "giggabit-agent-mail-service-agent",
      "giggabit-agent-mail-service-admin",
    ]);
    expect(unit).toContain("Description=Giggabit Agent Mail Service");
    expect(unit).toContain("StateDirectory=giggabit-agent-mail-service");
    expect(unit).toContain("RuntimeDirectory=giggabit-agent-mail-service");
    expect(unit).toContain("/opt/giggabit-agent-mail-service/bin/giggabit-agent-mail-service");
  });

  it("installs idempotently with protected host-bound credentials on supported package families", async () => {
    const installer = await readFile(join(packageRoot, "scripts", "install-system-service.sh"), "utf8");

    expect(installer).toContain("command -v pacman");
    expect(installer).toContain("command -v apt-get");
    expect(installer).toContain("systemd 250 or newer is required");
    expect(installer).toContain("systemd-creds encrypt --with-key=auto");
    expect(installer).toContain('if [ ! -e "$CREDENTIAL" ]');
    expect(installer).not.toMatch(/password.*(?:argument|environment)/i);
  });

  it("requires operator-owned provider registrations", async () => {
    const skill = await readFile(
      join(packageRoot, "..", "plugin", "skills", "onboard-mailboxes", "SKILL.md"),
      "utf8",
    );

    expect(skill).toContain("operator creates and controls every Provider Registration");
    expect(skill).toMatch(/Do not supply\s+a shared Microsoft or Google client identity/);
    expect(skill).toContain("echo-disabled local terminal prompt");
    expect(skill).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
  });

  it("packages the production-safe magic-link workflow", async () => {
    const skill = await readFile(
      join(packageRoot, "..", "plugin", "skills", "complete-magic-link-auth", "SKILL.md"),
      "utf8",
    );

    expect(skill).toContain("name: complete-magic-link-auth");
    expect(skill).toContain("collaborative browser");
    expect(skill).toContain("ephemeral bearer credential");
    expect(skill).toContain("expected HTTPS hostname");
    expect(skill).toContain("untrusted email content");
    expect(skill).toContain("magic_link");
    expect(skill).not.toMatch(/print|console\.log|clipboard/i);
  });

  it("packages the loopback-only staging harness entrypoint and workflow contract", async () => {
    const [entrypoint, skill] = await Promise.all([
      readFile(join(packageRoot, "src", "magic-link-staging-main.ts"), "utf8"),
      readFile(
        join(packageRoot, "..", "plugin", "skills", "complete-magic-link-auth", "SKILL.md"),
        "utf8",
      ),
    ]);

    expect(entrypoint).toContain('"127.0.0.1"');
    expect(entrypoint).toContain("--public-origin");
    expect(entrypoint).toContain("--control-socket");
    expect(skill).toContain("loopback staging harness");
    expect(skill).toContain("Unix control socket");
  });
});
