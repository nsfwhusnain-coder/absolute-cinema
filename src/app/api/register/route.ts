import { NextRequest, NextResponse } from "next/server";
import { defaultAvatarColor, isAvatarColor, signupsOpen } from "@/lib/profiles";
import { defaultAvatar, isAvatarId } from "@/lib/avatars";
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
 * POST /api/register  { name, pin?, avatar?, avatarColor? }
 *
 * Creates a profile: a display name and picture, no email. A 4-10 digit PIN
 * is optional; with one, the profile asks for it when opened. The
 * first profile becomes the admin. After that, anyone may create a profile
 * while sign-ups are open (Settings → Server, on by default) and an admin
 * always may. Rate-limited per name and IP, like sign-in.
 */
export async function POST(req: NextRequest) {
  try {
    const { name, pin, avatar, avatarColor } = (await req.json()) as {
      name?: string;
      pin?: string;
      avatar?: string;
      avatarColor?: string;
    };

    const requester = await getAuthenticatedUser();
    const isAdminCreating = Boolean(requester?.isAdmin);

    const gate = checkRegistrationGate({
      isAdminCreating,
      isFirstUser: (await db.user.count()) === 0,
      signupsOpen: await signupsOpen(),
    });
    if (!gate.allowed) {
      return NextResponse.json({ error: gate.error }, { status: 403 });
    }

    if (!name) {
      return NextResponse.json({ error: "Missing name" }, { status: 400 });
    }
    if (name.trim().length < 2 || name.trim().length > 24) {
      return NextResponse.json({ error: "Name must be 2 to 24 characters" }, { status: 400 });
    }
    if (pin !== undefined && pin !== "" && !/^\d{4,10}$/.test(pin)) {
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
    const pinHash = pin ? await bcrypt.hash(pin, 10) : null;

    const user = await db.user.create({
      data: {
        name: trimmedName,
        pinHash,
        pinRequired: Boolean(pinHash),
        isAdmin: userCount === 0, // first user is admin
        avatarColor: isAvatarColor(avatarColor) ? avatarColor : defaultAvatarColor(userCount),
        avatar: isAvatarId(avatar) ? avatar : defaultAvatar(userCount),
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
