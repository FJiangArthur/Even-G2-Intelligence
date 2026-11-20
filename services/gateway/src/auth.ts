import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

export const HELIX_WEBSOCKET_PROTOCOL = "helix.v2";
const AUTH_PREFIX = "helix-auth.";

function offeredProtocols(headers: IncomingHttpHeaders): readonly string[] {
  const value = headers["sec-websocket-protocol"];
  if (typeof value !== "string") return [];
  return value.split(",").map((protocol) => protocol.trim()).filter(Boolean);
}

function decodeBase64Url(value: string): string | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  try {
    return Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return undefined;
  }
}

function securelyEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left, "utf8").digest();
  const rightDigest = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

export function authorizeWebSocket(
  headers: IncomingHttpHeaders,
  requiredToken: string | undefined,
): { readonly accepted: true } | { readonly accepted: false; readonly status: 401 | 426 } {
  const protocols = offeredProtocols(headers);
  if (!protocols.includes(HELIX_WEBSOCKET_PROTOCOL)) {
    return { accepted: false, status: 426 };
  }
  if (requiredToken === undefined) return { accepted: true };

  const encodedToken = protocols
    .find((protocol) => protocol.startsWith(AUTH_PREFIX))
    ?.slice(AUTH_PREFIX.length);
  const suppliedToken = encodedToken === undefined ? undefined : decodeBase64Url(encodedToken);
  return suppliedToken !== undefined && securelyEqual(suppliedToken, requiredToken)
    ? { accepted: true }
    : { accepted: false, status: 401 };
}
