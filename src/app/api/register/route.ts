import { NextRequest, NextResponse } from "next/server";
import { defaultAvatarColor, isAvatarColor, requirePin, signupsOpen } from "@/lib/profiles";
import { checkInvite, consumeInvite, normalizeInviteCode, refundInvite } from "@/lib/invites";
import { defaultAvatar, isAvatarValue } from "@/lib/avatars";
import bcrypt from "bcryptjs";
import { db, withSqliteRetry } from "@/lib/db";
import { getAuthenticatedUser } from "@/lib/auth";
import {
  checkAuthRateLimit,
  clearAuthFailures,
  clientIpFromHeaders,
  recordIpAuthFailure,
} from "@/lib/login-rate-limit";
import { checkRegistrationGate } from "@/lib/registration-gate";
import { RateLimiter } from "@/lib/rate-limit";

/** New profiles per address per hour (an admin creating them in Settings is exempt). */
const signupLimiter = new RateLimiter({ limit: 6, windowMs: 60 * 60 * 1000 });
/**
 * Sign-up attempts per invite per hour, made or refused: behind a tunnel every
 * tester has an address of their own, so this is what keeps one link from
 * filling the server in a burst, or from trying name after name to learn
 * which profiles exist while the profile list is hidden.
 */
const inviteLimiter = new RateLimiter({ limit: 20, windowMs: 60 * 60 * 1000 });
/** A household server, not a public sign-up page: past this, nobody can add more. */
const MAX_PROFILES = 60;

/**
 * POST /api/register  { name, pin?, avatar?, avatarColor?, invite? }
 *
 * Creates a profile: a display name and picture, no email. A 4-10 digit PIN
 * is optional (unless the server requires one); with one, the profile asks
 * for it when opened. The first profile becomes the admin. After that,
 * anyone may create a profile while sign-ups are open (Settings → Server, on
 * by default), whoever holds a valid invite link may while they are not, and
 * an admin always may. Rate-limited per name and IP, like sign-in.
 */
export async function POST(req: NextRequest) {
  /** An invite whose use was taken for a profile not yet made. */
  let refundable: string | null = null;
  try {
    const body = (await req.json().catch(() => null)) as {
      name?: unknown;
      pin?: unknown;
      avatar?: unknown;
      avatarColor?: unknown;
      invite?: unknown;
    } | null;
    if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    const name = typeof body.name === "string" ? body.name : undefined;
    const pin = typeof body.pin === "string" ? body.pin : undefined;
    const { avatar, avatarColor } = body;

    const requester = await getAuthenticatedUser();
    const isAdminCreating = Boolean(requester?.isAdmin);
    const invite = normalizeInviteCode(body.invite);
    const gate = checkRegistrationGate({
      isAdminCreating,
      isFirstUser: (await db.user.count()) === 0,
      signupsOpen: await signupsOpen(),
      inviteValid: invite ? (await checkInvite(invite)) === "valid" : false,
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
    // The first profile too: on a server that requires PINs it is the admin, and a profile without one is anyone's.
    if (!pin && (await requirePin())) {
      return NextResponse.json({ error: "Profiles on this server need a PIN (4-10 digits)" }, { status: 400 });
    }

    const trimmedName = name.trim();
    const ip = clientIpFromHeaders(req.headers);

    if (!isAdminCreating) {
      // Successful sign-ups were never throttled (only failures were), so a
      // script could fill the public profile picker with names. An invite's own
      // uses bound the profiles it makes (behind a tunnel, every tester shares one address).
      if (gate.reason !== "invite" && !signupLimiter.consume(ip ?? "unknown").allowed) {
        return NextResponse.json({ error: "Too many new profiles from here. Try again later." }, { status: 429 });
      }
      if (gate.reason === "invite" && !inviteLimiter.consume(invite!).allowed) {
        return NextResponse.json({ error: "Too many sign-ups with this invite link. Try again in an hour." }, { status: 429 });
      }
      if ((await db.user.count()) >= MAX_PROFILES) {
        return NextResponse.json({ error: "This server has as many profiles as it can hold. Ask the admin to remove one." }, { status: 403 });
      }
    }

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

    const pinHash = pin ? await bcrypt.hash(pin, 10) : null;

    // The invite's use is taken first, so two people on its last use cannot both get in: the one whose write
    // loses the race reads the list again, and finds it used up.
    if (gate.reason === "invite") {
      if (!(await withSqliteRetry(() => consumeInvite(invite!)))) {
        return NextResponse.json({ error: "This invite link has expired or been used up. Ask for a new one." }, { status: 403 });
      }
      refundable = invite;
    }

    // Counting and creating in one transaction: two first-run sign-ups at the
    // same moment could otherwise both see zero profiles and both become admin.
    const user = await db.$transaction(async (tx) => {
      const userCount = await tx.user.count();
      return tx.user.create({
        data: {
          name: trimmedName,
          pinHash,
          pinRequired: Boolean(pinHash),
          isAdmin: userCount === 0, // first user is admin
          avatarColor: isAvatarColor(avatarColor) ? avatarColor : defaultAvatarColor(userCount),
          avatar: isAvatarValue(avatar) ? avatar : defaultAvatar(userCount),
        },
      });
    });

    refundable = null;
    clearAuthFailures(trimmedName, ip);

    return NextResponse.json({
      ok: true,
      user: { id: user.id, name: user.name, isAdmin: user.isAdmin },
    });
  } catch (e: unknown) {
    // The invite's use goes back when the profile it was taken for was not made.
    if (refundable) await refundInvite(refundable).catch((err) => console.warn("[register] an invite's use was not given back:", err));
    // A name taken in the moment between the check and the insert.
    if ((e as { code?: string })?.code === "P2002") return NextResponse.json({ error: "That name is already taken" }, { status: 409 });
    console.error("[register] failed:", e);
    return NextResponse.json({ error: "Registration failed" }, { status: 500 });
  }
}
