import path from "path";
import type { NextConfig } from "next";
import pkg from "./package.json";

/**
 * Security response headers.
 *
 * No Content-Security-Policy: the player stack (hls.js) needs blob:
 * workers and MSE, images come from TMDB's multi-subdomain CDN, and media can
 * be proxied through an optional Cloudflare worker, so a strict CSP would
 * need per-deployment tuning to avoid breaking playback.
 */
const SECURITY_HEADERS = [
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value:
      "camera=(), microphone=(), geolocation=(), usb=(), payment=(), interest-cohort=()",
  },
];

const nextConfig: NextConfig = {
  output: "standalone",
  env: {
    NEXT_PUBLIC_APP_VERSION: pkg.version,
  },
  turbopack: {
    root: path.resolve(__dirname),
  },
  reactStrictMode: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: SECURITY_HEADERS,
      },
    ];
  },
};

export default nextConfig;
