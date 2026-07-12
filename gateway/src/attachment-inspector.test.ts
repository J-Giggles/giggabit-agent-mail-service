import { describe, expect, it, vi } from "vitest";

import { BwrapAttachmentInspector } from "./attachment-inspector.js";

describe("sandboxed attachment inspector", () => {
  it("opens text only through a networkless read-only bubblewrap sandbox", async () => {
    const execute = vi.fn().mockResolvedValueOnce("text/plain\n").mockResolvedValueOnce("untrusted text");
    const inspector = new BwrapAttachmentInspector({ execute });

    await expect(inspector.inspect("/private/quarantine/item.txt")).resolves.toEqual({
      contentType: "text/plain",
      text: "untrusted text",
    });
    for (const [command, args] of execute.mock.calls) {
      expect(command).toBe("/usr/bin/bwrap");
      expect(args).toEqual(expect.arrayContaining(["--unshare-all", "--ro-bind", "/private/quarantine/item.txt", "/input"]));
    }
  });
});
