import { createClient } from "@farcaster/quick-auth";

export const FARCASTER_AUTH_DOMAIN = "snapmeter.ael-dev3.workers.dev";
export const FARCASTER_AUTH_ISSUER = "https://auth.farcaster.xyz";
export const FARCASTER_AUTH_ORIGIN = `https://${FARCASTER_AUTH_DOMAIN}`;

const MAX_TOKEN_BYTES = 8 * 1024;
const MAX_TOKEN_LIFETIME_SECONDS = 60 * 60;
const MAX_FUTURE_IAT_SKEW_SECONDS = 60;
const COMPACT_JWT_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const RESPONSE_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "vary": "Authorization, Origin",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer"
};

export type FarcasterJwtClaims = Readonly<{
  iss: unknown;
  aud: unknown;
  sub: unknown;
  iat: unknown;
  exp: unknown;
}>;

export type FarcasterJwtVerifier = (options: Readonly<{
  token: string;
  domain: string;
}>) => Promise<unknown>;

const quickAuthClient = createClient();

export const verifyFarcasterJwt: FarcasterJwtVerifier = (options) =>
  quickAuthClient.verifyJwt(options);

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: RESPONSE_HEADERS });
}

function unauthorized(): Response {
  return json({ schemaVersion: 1, authenticated: false, error: "unauthorized" }, 401);
}

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  const prefix = "Bearer ";
  if (!authorization || authorization.length > MAX_TOKEN_BYTES + prefix.length) return null;
  if (!authorization.startsWith(prefix)) return null;
  const token = authorization.slice(prefix.length);
  if (!COMPACT_JWT_PATTERN.test(token)) return null;
  return new TextEncoder().encode(token).byteLength <= MAX_TOKEN_BYTES ? token : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validatedFid(value: unknown, nowSeconds: number): number | null {
  if (!isRecord(value) || !Number.isFinite(nowSeconds)) return null;
  try {
    const { iss, aud, sub, iat, exp } = value as FarcasterJwtClaims;
    if (iss !== FARCASTER_AUTH_ISSUER || aud !== FARCASTER_AUTH_DOMAIN) return null;
    if (typeof sub !== "number" || !Number.isSafeInteger(sub) || sub <= 0) return null;
    if (typeof iat !== "number" || !Number.isFinite(iat) || iat <= 0) return null;
    if (typeof exp !== "number" || !Number.isFinite(exp) || exp <= nowSeconds) return null;
    if (iat > nowSeconds + MAX_FUTURE_IAT_SKEW_SECONDS) return null;
    const lifetime = exp - iat;
    if (lifetime <= 0 || lifetime > MAX_TOKEN_LIFETIME_SECONDS) return null;
    return sub;
  } catch {
    return null;
  }
}

export async function handleFarcasterMe(
  request: Request,
  verifier: FarcasterJwtVerifier = verifyFarcasterJwt,
  nowSeconds = Math.floor(Date.now() / 1000)
): Promise<Response> {
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== FARCASTER_AUTH_ORIGIN) return unauthorized();
  const token = bearerToken(request);
  if (!token) return unauthorized();
  try {
    const fid = validatedFid(await verifier({ token, domain: FARCASTER_AUTH_DOMAIN }), nowSeconds);
    if (fid === null) return unauthorized();
    return json({ schemaVersion: 1, authenticated: true, fid }, 200);
  } catch {
    return unauthorized();
  }
}
