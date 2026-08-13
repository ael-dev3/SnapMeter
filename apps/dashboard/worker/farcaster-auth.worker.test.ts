import { SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  FARCASTER_AUTH_DOMAIN,
  FARCASTER_AUTH_ISSUER,
  FARCASTER_AUTH_ORIGIN,
  handleFarcasterMe,
  type FarcasterJwtVerifier
} from "./farcaster-auth";

const NOW_SECONDS = 1_800_000_000;
const TOKEN = "header.payload.signature";

function request(authorization?: string, origin?: string): Request {
  return new Request("https://snapmeter.test/api/v1/farcaster/me", {
    headers: {
      ...(authorization ? { authorization } : {}),
      ...(origin ? { origin } : {})
    }
  });
}

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: FARCASTER_AUTH_ISSUER,
    aud: FARCASTER_AUTH_DOMAIN,
    sub: 539_854,
    iat: NOW_SECONDS - 30,
    exp: NOW_SECONDS + 300,
    ...overrides
  };
}

function verifier(result: unknown): ReturnType<typeof vi.fn<FarcasterJwtVerifier>> {
  return vi.fn<FarcasterJwtVerifier>().mockResolvedValue(result);
}

async function expectUnauthorized(response: Response): Promise<void> {
  expect(response.status).toBe(401);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("vary")).toBe("Authorization, Origin");
  expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
  expect(await response.json()).toEqual({ schemaVersion: 1, authenticated: false, error: "unauthorized" });
}

describe("Farcaster Quick Auth", () => {
  it("routes GET /api/v1/farcaster/me through the Worker", async () => {
    await expectUnauthorized(await SELF.fetch("https://snapmeter.test/api/v1/farcaster/me"));
  });

  it("rejects a missing or malformed exact Bearer compact JWT before verification", async () => {
    const verify = verifier(claims());
    const malformed = [
      undefined,
      "Basic header.payload.signature",
      "bearer header.payload.signature",
      "Bearer",
      "Bearer header.payload",
      "Bearer header.payload.signature.extra",
      "Bearer header.payload.sign+ature",
      `Bearer a.${"a".repeat(8_190)}.a`
    ];
    for (const authorization of malformed) {
      await expectUnauthorized(await handleFarcasterMe(request(authorization), verify, NOW_SECONDS));
    }
    expect(verify).not.toHaveBeenCalled();
  });

  it("returns only a verified positive FID and pins the exact audience domain", async () => {
    const verify = verifier(claims());
    const response = await handleFarcasterMe(
      request(`Bearer ${TOKEN}`, FARCASTER_AUTH_ORIGIN),
      verify,
      NOW_SECONDS
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("vary")).toBe("Authorization, Origin");
    expect(await response.json()).toEqual({ schemaVersion: 1, authenticated: true, fid: 539_854 });
    expect(verify).toHaveBeenCalledOnce();
    expect(verify).toHaveBeenCalledWith({ token: TOKEN, domain: FARCASTER_AUTH_DOMAIN });
  });

  it("rejects a present Origin unless it is the exact production origin", async () => {
    const verify = verifier(claims());
    await expectUnauthorized(await handleFarcasterMe(
      request(`Bearer ${TOKEN}`, "https://attacker.example"),
      verify,
      NOW_SECONDS
    ));
    expect(verify).not.toHaveBeenCalled();

    const directResponse = await handleFarcasterMe(request(`Bearer ${TOKEN}`), verify, NOW_SECONDS);
    expect(directResponse.status).toBe(200);
  });

  it.each([
    ["wrong issuer", { iss: "https://attacker.example" }],
    ["wrong audience", { aud: "attacker.example" }],
    ["audience array", { aud: [FARCASTER_AUTH_DOMAIN] }],
    ["zero FID", { sub: 0 }],
    ["negative FID", { sub: -1 }],
    ["string FID", { sub: "539854" }],
    ["unsafe FID", { sub: Number.MAX_SAFE_INTEGER + 1 }],
    ["missing issued-at", { iat: undefined }],
    ["non-finite issued-at", { iat: Number.POSITIVE_INFINITY }],
    ["non-positive issued-at", { iat: 0 }],
    ["issued too far in the future", { iat: NOW_SECONDS + 61, exp: NOW_SECONDS + 300 }],
    ["missing expiry", { exp: undefined }],
    ["non-finite expiry", { exp: Number.NaN }],
    ["expired token", { exp: NOW_SECONDS }],
    ["expiry before issuance", { iat: NOW_SECONDS - 10, exp: NOW_SECONDS - 20 }],
    ["lifetime over one hour", { iat: NOW_SECONDS - 10, exp: NOW_SECONDS + 3_591 }]
  ])("rejects independently invalid claims: %s", async (_label, overrides) => {
    await expectUnauthorized(await handleFarcasterMe(
      request(`Bearer ${TOKEN}`),
      verifier(claims(overrides)),
      NOW_SECONDS
    ));
  });

  it("fails closed without leaking verifier errors or bearer material", async () => {
    const verify = vi.fn<FarcasterJwtVerifier>().mockRejectedValue(
      new Error(`upstream rejected secret ${TOKEN}`)
    );
    const response = await handleFarcasterMe(request(`Bearer ${TOKEN}`), verify, NOW_SECONDS);
    expect(response.status).toBe(401);
    const body = await response.text();
    expect(body).toBe('{"schemaVersion":1,"authenticated":false,"error":"unauthorized"}');
    expect(body).not.toContain(TOKEN);
    expect(body).not.toContain("upstream");
    expect(body).not.toContain("secret");
  });
});
