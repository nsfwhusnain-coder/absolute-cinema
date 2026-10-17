/**
 * Whether a viewer is outside the home network, from their address: a stream
 * to them crosses the upload side of the internet link, which is a fraction of
 * the download side (see docs/CAPACITY.md, CAPACITY_UPLINK_MBPS).
 *
 * Loopback, private, link-local and carrier-grade NAT ranges (Tailscale gives
 * its devices addresses in 100.64.0.0/10) count as home; so does no address at
 * all, so a missing header never turns the owner into a stranger.
 */

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isHomeIpv4(a: number, b: number): boolean {
  if (a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

export function isRemoteAddress(ip: string | null | undefined): boolean {
  if (!ip) return false;
  let address = ip.trim().toLowerCase();
  // An IPv4 address carried in IPv6 (::ffff:192.168.1.5).
  if (address.startsWith("::ffff:")) address = address.slice(7);
  const v4 = address.match(IPV4);
  if (v4) return !isHomeIpv4(Number(v4[1]), Number(v4[2]));
  if (!address.includes(":")) return false;
  if (address === "::1") return false;
  // Unique local (fc00::/7) and link-local (fe80::/10) IPv6.
  if (/^f[cd][0-9a-f]{2}:/.test(address) || /^fe[89ab][0-9a-f]:/.test(address)) return false;
  return true;
}
