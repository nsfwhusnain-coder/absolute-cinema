import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";

/**
 * Route-level authentication gate.
 *
 * Before this file existed, pages like movie/[id] and tv/[id] server-rendered
 * full TMDB data with no session check at all — only individual API routes
 * and client-side `useSession()` gating protected anything, so the entire
 * catalog UI was reachable by anonymous visitors. This middleware defaults
 * to "must be signed in" for every page route and allowlists the handful
 * that must stay public.
 *
 * `getToken` (not `getServerSession`) is used because it's the supported,
 * edge/middleware-safe way to read the NextAuth JWT without pulling in the
 * full NextAuth route handler. It reads the exact same cookie + secret
 * (`NEXTAUTH_SECRET`/`AUTH_SECRET`, defaulting the "secure cookie" name
 * choice off `NEXTAUTH_URL` — see `src/lib/auth.ts`) that already issues and
 * verifies sessions today, so any account that can already sign in continues
 * to work unchanged; nothing here duplicates or changes that logic.
 *
 * `/api/**` is deliberately NOT gated here — every API route already calls
 * `getAuthenticatedUser`/`getAuthenticatedUserId` (or, for the couple that
 * didn't, that's fixed directly in those route files). Gating `/api/auth/*`
 * in particular would break sign-in itself (redirect loop), so the matcher
 * below excludes the whole `/api` tree rather than special-casing it here.
 */

const PUBLIC_PAGE_PATHS = new Set<string>([
  "/login",
  // No dedicated /register page exists today (sign-up is a tab on /login),
  // but this is kept allowlisted defensively in case one is added later —
  // the invite-code gate itself still lives server-side in /api/register.
  "/register",
  "/dmca",
  // The live dashboard's page is an empty shell: everything it shows comes from /api/hub/live, which
  // answers only an owner's session or the dashboard's key (a screen that is not signed in).
  "/hub",
]);

/** Pages under these are public too: an invite link (/join/<code>) is opened by someone who has no profile yet. */
const PUBLIC_PAGE_PREFIXES = ["/join/"];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PAGE_PATHS.has(pathname) || PUBLIC_PAGE_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const { pathname, search } = req.nextUrl;

  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  const token = await getToken({ req });
  if (token) {
    return NextResponse.next();
  }

  const loginUrl = new URL("/login", req.url);
  const callbackUrl = `${pathname}${search}`;
  // Never point the callback at /login itself — avoids any chance of a
  // post-login bounce landing back on a redirect loop.
  if (callbackUrl !== "/login") {
    loginUrl.searchParams.set("callbackUrl", callbackUrl);
  }
  return NextResponse.redirect(loginUrl);
}

export const config = {
  /**
   * Excludes:
   *  - /api/**            — self-gated per-route (see file header)
   *  - /_next/static, /_next/image — Next.js internals
   *  - static files by extension (favicon.ico, manifest.json, sw.js,
   *    robots.txt, images and fonts under /public). Only real file
   *    extensions: excluding every path with a dot let "/movie/603." skip
   *    the gate, because the page reads the id as Number("603.") = 603.
   */
  matcher: [
    "/((?!api|_next/static|_next/image|.*\\.(?:png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|otf|js|mjs|css|map|json|txt|xml|webmanifest)$).*)",
  ],
};
