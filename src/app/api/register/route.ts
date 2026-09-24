import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { getAuthenticatedUser } from "@/lib/auth";
import {
  checkAuthRateLimit,
  clearAuthFailures,
  clientIpFromHeaders,
  recordIpAuthFailure,
} from "@/lib/login-rate-limit";
import { checkRegistrationGate } from "@/lib/registration-gate";

/**
 * POST /api/register
 * Body: { name, pin, inviteCode? }
 *
 * First user becomes admin automatically.
 * No email — just a display name and a numeric PIN (4-10 digits).
 * Rate-limited per username (+ soft IP) — same window as login.
 *
 * SECURITY: this app is internet-facing and gates the
 * owner's paid Real-Debrid/TorBox subscription behind "sign in required" —
 * open self-registration defeats that entirely. Registration is now closed
 * by default:
 *   - An already-authenticated admin may always create additional accounts
 *     here (mirrors the "admin user-management" path — there is no separate
 *     admin-create-user endpoint today), regardless of the invite code.
 *   - Otherwise, `process.env.REGISTRATION_INVITE_CODE` must be set AND the
 *     request body's `inviteCode` must match it, or the request is rejected.
 *   - If the env var is unset, registration is disabled entirely (even a
 *     correct-looking guess can't pass, since there's nothing to match).
 */
/**
 * GET /api/register — what the sign-in screen should offer.
 * firstRun: no accounts exist, so the next sign-up becomes the admin.
 * inviteEnabled: self sign-up with an invite code is available.
 */
export async function GET() {
  const firstRun = (await db.user.count()) === 0;
  return NextResponse.json(
    { firstRun, inviteEnabled: Boolean(process.env.REGISTRATION_INVITE_CODE) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(req: NextRequest) {
  try {
    const { name, pin, inviteCode } = (await req.json()) as {
      name?: string;
      pin?: string;
      inviteCode?: string;
    };

    const requester = await getAuthenticatedUser();
    const isAdminCreating = Boolean(requester?.isAdmin);

    const gate = checkRegistrationGate({
      isAdminCreating,
      isFirstUser: (await db.user.count()) === 0,
      requiredCode: process.env.REGISTRATION_INVITE_CODE,
      providedCode: inviteCode,
    });
    if (!gate.allowed) {
      return NextResponse.json({ error: gate.error }, { status: 403 });
    }

    if (!name || !pin) {
      return NextResponse.json({ error: "Missing name or PIN" }, { status: 400 });
    }
    if (name.trim().length < 2) {
      return NextResponse.json({ error: "Name must be at least 2 characters" }, { status: 400 });
    }
    if (!/^\d{4,10}$/.test(pin)) {
      return NextResponse.json({ error: "PIN must be 4-10 digits" }, { status: 400 });
    }

    const trimmedName = name.trim();
    const ip = clientIpFromHeaders(req.headers);

    // Admin-initiated creation is already gated by session auth — skip the
    // failed-attempt limiter so a burst of legitimate account creation from
    // the settings/admin UI can never lock itself out.
    if (!isAdminCreating) {
      const limit = checkAuthRateLimit(trimmedName, ip);
      if (!limit.allowed) {
        return NextResponse.json(
          { error: limit.message ?? "Too many failed attempts. Try again in a few minutes." },
          { status: 429 }
        );
      }
    }

    const existing = await db.user.findUnique({ where: { name: trimmedName } });
    if (existing) {
      // IP-only soft throttle — never shares login username lockout (name-taken DoS).
      // Message matches prior behavior (name taken is already disclosed on register).
      recordIpAuthFailure(ip);
      return NextResponse.json({ error: "That name is already taken" }, { status: 409 });
    }

    const userCount = await db.user.count();
    const pinHash = await bcrypt.hash(pin, 10);

    const user = await db.user.create({
      data: {
        name: trimmedName,
        pinHash,
        isAdmin: userCount === 0, // first user is admin
      },
    });

    clearAuthFailures(trimmedName, ip);

    return NextResponse.json({
      ok: true,
      user: { id: user.id, name: user.name, isAdmin: user.isAdmin },
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Registration failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
