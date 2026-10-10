/**
 * How to ask a CDN that only answers some clients.
 *
 * Most stream CDNs want the embed site's Referer and a browser User-Agent.
 * MovieBox's (hakunaymatata.com, which serves VidLink's files) wants the
 * opposite: it answers 429 to any Referer and 428 to a browser User-Agent,
 * and serves the same signed link to a plain client. Dressed as a browser,
 * every VidLink file failed before its first frame.
 */

const PLAIN_CLIENT_USER_AGENT = "AbsoluteCinema";
const PLAIN_CLIENT_DOMAINS: readonly string[] = ["hakunaymatata.com"];

/** True when `url` is on a CDN that refuses requests dressed as a browser. */
export function wantsPlainClient(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return PLAIN_CLIENT_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/** Request headers for such a CDN: no Referer, no Origin, no cookies. */
export function plainClientHeaders(range?: string | null): Record<string, string> {
  const headers: Record<string, string> = { Accept: "*/*", "User-Agent": PLAIN_CLIENT_USER_AGENT };
  if (range) headers.Range = range;
  return headers;
}
