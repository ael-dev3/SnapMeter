const encoder = new TextEncoder();

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

export function ingestSigningPayload(timestamp: string, nonce: string, rawBody: string): string {
  return `${timestamp}.${nonce}.${rawBody}`;
}

export async function signIngest(secret: string, timestamp: string, nonce: string, rawBody: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(ingestSigningPayload(timestamp, nonce, rawBody)));
  return `v1=${bytesToHex(new Uint8Array(signature))}`;
}

export async function verifyIngestSignature(
  secret: string,
  timestamp: string,
  nonce: string,
  rawBody: string,
  suppliedSignature: string
): Promise<boolean> {
  const supplied = hexToBytes(suppliedSignature.replace(/^v1=/, ""));
  if (!supplied) return false;
  const expectedHex = (await signIngest(secret, timestamp, nonce, rawBody)).slice(3);
  const expected = hexToBytes(expectedHex);
  return expected !== null && constantTimeEqual(expected, supplied);
}

export function isFreshTimestamp(timestamp: string, nowMs = Date.now(), toleranceMs = 5 * 60_000): boolean {
  if (!/^\d+$/.test(timestamp)) return false;
  const parsed = Number(timestamp);
  return Number.isSafeInteger(parsed) && Math.abs(nowMs - parsed) <= toleranceMs;
}
