import { describe, expect, it, vi } from "vitest";

import { TailscaleCliVerifier } from "./tailnet.js";

describe("Tailnet source seam", () => {
  it("resolves a stable node identity with tailscale whois and rejects non-tailnet peers", async () => {
    const lookup = vi.fn(async () =>
      JSON.stringify({
        Node: {
          StableID: "n7VutwQp2D11CNTRL",
          Name: "mail-host.example.ts.net.",
        },
      }),
    );
    const lookupLocal = vi.fn(async () =>
      JSON.stringify({ Self: { ID: "n7VutwQp2D11CNTRL", DNSName: "mail-host.example.ts.net." } }),
    );
    const verifier = new TailscaleCliVerifier({ lookup, lookupLocal });

    await expect(verifier.identify("100.114.48.17")).resolves.toEqual({
      nodeId: "n7VutwQp2D11CNTRL",
      nodeName: "mail-host.example.ts.net",
    });
    expect(lookup).toHaveBeenCalledWith("100.114.48.17");
    await expect(verifier.identifyLocal()).resolves.toEqual({
      nodeId: "n7VutwQp2D11CNTRL",
      nodeName: "mail-host.example.ts.net",
    });
    expect(lookupLocal).toHaveBeenCalledOnce();

    await expect(verifier.identify("127.0.0.1")).rejects.toThrow("tailnet peer");
    expect(lookup).toHaveBeenCalledTimes(1);
  });
});
