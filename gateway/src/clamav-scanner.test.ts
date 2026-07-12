import { describe, expect, it, vi } from "vitest";

import { ClamAvScanner } from "./clamav-scanner.js";

describe("ClamAV scanner", () => {
  it("fails closed on scanner errors and distinguishes infected attachments", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 0, output: "OK" })
      .mockResolvedValueOnce({ exitCode: 1, output: "Eicar-Test-Signature FOUND" })
      .mockResolvedValueOnce({ exitCode: 2, output: "database unavailable" });
    const scanner = new ClamAvScanner({ command: "/usr/bin/clamdscan", execute });

    await expect(scanner.scan("/quarantine/clean.pdf")).resolves.toEqual({ clean: true });
    await expect(scanner.scan("/quarantine/eicar.txt")).resolves.toMatchObject({ clean: false });
    await expect(scanner.scan("/quarantine/unknown.bin")).rejects.toThrow("malware scanner failed closed");
    expect(execute).toHaveBeenCalledWith("/usr/bin/clamdscan", ["--no-summary", "/quarantine/clean.pdf"]);
  });
});
