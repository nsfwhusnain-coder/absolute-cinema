import { createHash, timingSafeEqual } from "node:crypto";

/**
 * "disabled": no METRICS_TOKEN is set, so the endpoint does not exist (404).
 * "denied": a token is set and the request does not carry it (401).
 * "allowed": the request carries the token.
 */
export type MetricsAccess = "disabled" | "denied" | "allowed";

const BEARER = /^Bearer\s+(\S+)\s*$/i;

/** The digest of a token: equal length for any token, so the comparison leaks nothing about its length. */
function digestOf(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

/**
 * Whether a request may read the metrics: its `Authorization: Bearer` header
 * must carry the token the server was given. The comparison takes the same
 * time whatever the guess, so a wrong token cannot be found one character at a time.
 */
export function checkMetricsAccess(authorization: string | null | undefined, token: string | undefined): MetricsAccess {
  const expected = token?.trim();
  if (!expected) return "disabled";
  const match = BEARER.exec(authorization ?? "");
  if (!match) return "denied";
  return timingSafeEqual(digestOf(match[1]!), digestOf(expected)) ? "allowed" : "denied";
}
