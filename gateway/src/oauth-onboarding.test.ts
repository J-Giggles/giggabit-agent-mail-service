import { describe, expect, it, vi } from "vitest";

import { googleAuthorization, microsoftDeviceAuthorization } from "./admin-main.js";

describe("operator-owned OAuth onboarding seams", () => {
  it("uses an operator Microsoft client with the least required delegated mail scopes", async () => {
    const present = vi.fn(async () => undefined);
    const wait = vi.fn(async () => undefined);
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = new URLSearchParams(String(init?.body));
      if (url.endsWith("/devicecode")) {
        expect(url).toBe("https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode");
        expect(body.get("client_id")).toBe("operator-microsoft-client");
        expect(body.get("scope")?.split(" ").sort()).toEqual([
          "https://outlook.office.com/IMAP.AccessAsUser.All",
          "https://outlook.office.com/SMTP.Send",
          "offline_access",
        ].sort());
        return Response.json({
          device_code: "synthetic-device-code",
          user_code: "SYNTHETIC",
          verification_uri: "https://microsoft.com/devicelogin",
          expires_in: 60,
          interval: 0,
        });
      }
      expect(url).toBe("https://login.microsoftonline.com/consumers/oauth2/v2.0/token");
      expect(body.get("client_id")).toBe("operator-microsoft-client");
      expect(body.get("device_code")).toBe("synthetic-device-code");
      return Response.json({ refresh_token: "synthetic-microsoft-refresh" });
    });

    await expect(microsoftDeviceAuthorization("operator-microsoft-client", "consumers", {
      now: () => 0,
      present,
      request,
      wait,
    })).resolves.toBe("synthetic-microsoft-refresh");
    expect(present).toHaveBeenCalledWith("https://microsoft.com/devicelogin", "SYNTHETIC");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("uses an operator Google Desktop client with loopback PKCE and offline mail access", async () => {
    let authorizationUrl: URL | undefined;
    const present = vi.fn(async (value: string) => {
      authorizationUrl = new URL(value);
      const callback = new URL(authorizationUrl.searchParams.get("redirect_uri") ?? "");
      callback.searchParams.set("state", authorizationUrl.searchParams.get("state") ?? "");
      callback.searchParams.set("code", "synthetic-google-code");
      const response = await fetch(callback);
      expect(response.status).toBe(200);
    });
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://oauth2.googleapis.com/token");
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("client_id")).toBe("operator-google-client.apps.example.invalid");
      expect(body.get("client_secret")).toBe("synthetic-client-secret");
      expect(body.get("code")).toBe("synthetic-google-code");
      expect(body.get("code_verifier")).toBeTruthy();
      expect(body.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);
      return Response.json({ refresh_token: "synthetic-google-refresh" });
    });

    await expect(googleAuthorization(
      "operator-google-client.apps.example.invalid",
      "synthetic-client-secret",
      { present, request },
    )).resolves.toBe("synthetic-google-refresh");
    expect(authorizationUrl?.origin).toBe("https://accounts.google.com");
    expect(authorizationUrl?.searchParams.get("scope")).toBe("https://mail.google.com/");
    expect(authorizationUrl?.searchParams.get("access_type")).toBe("offline");
    expect(authorizationUrl?.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizationUrl?.searchParams.get("client_id")).toBe("operator-google-client.apps.example.invalid");
  });
});
