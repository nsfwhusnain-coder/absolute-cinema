import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { getAuthenticatedUser } from "@/lib/auth";
import { isAvatarColor } from "@/lib/profiles";
import { isAvatarId } from "@/lib/avatars";

const PIN = /^\d{4,10}$/;

/**
 * PATCH /api/profile — the signed-in profile edits itself.
 * Body: { avatarColor?, avatar?, name?, pinRequired?, newPin?, currentPin? }
 *
 * A locked profile (pinRequired) must confirm its current PIN to rename, to
 * change the PIN or to turn the lock off. Turning the lock on sets a new PIN.
 */
export async function PATCH(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as {
    avatarColor?: unknown;
    avatar?: unknown;
    name?: unknown;
    pinRequired?: unknown;
    newPin?: unknown;
    currentPin?: unknown;
  };
  const record = await db.user.findUnique({ where: { id: user.id } });
  if (!record) return NextResponse.json({ error: "Profile not found" }, { status: 404 });

  const data: { avatarColor?: string; avatar?: string; name?: string; pinHash?: string | null; pinRequired?: boolean } = {};
  if (body.avatarColor !== undefined) {
    if (!isAvatarColor(body.avatarColor)) return NextResponse.json({ error: "Unknown colour" }, { status: 400 });
    data.avatarColor = body.avatarColor;
  }
  if (body.avatar !== undefined) {
    if (!isAvatarId(body.avatar)) return NextResponse.json({ error: "Unknown picture" }, { status: 400 });
    data.avatar = body.avatar;
  }

  const wantsName = typeof body.name === "string" && body.name.trim() !== record.name;
  const wantsPin = body.newPin !== undefined;
  const wantsUnlock = body.pinRequired === false && record.pinRequired;
  if (record.pinRequired && (wantsName || wantsPin || wantsUnlock)) {
    const current = typeof body.currentPin === "string" ? body.currentPin : "";
    if (!record.pinHash || !(await bcrypt.compare(current, record.pinHash))) {
      return NextResponse.json({ error: "Your current PIN isn't right." }, { status: 403 });
    }
  }
  if (wantsName) {
    const name = (body.name as string).trim();
    if (name.length < 2 || name.length > 24) return NextResponse.json({ error: "Name must be 2 to 24 characters" }, { status: 400 });
    if (await db.user.findUnique({ where: { name } })) return NextResponse.json({ error: "That name is already taken" }, { status: 409 });
    data.name = name;
  }
  if (wantsPin) {
    if (typeof body.newPin !== "string" || !PIN.test(body.newPin)) {
      return NextResponse.json({ error: "PIN must be 4-10 digits" }, { status: 400 });
    }
    data.pinHash = await bcrypt.hash(body.newPin, 10);
    data.pinRequired = true;
  } else if (body.pinRequired === true && !record.pinRequired) {
    return NextResponse.json({ error: "Choose a PIN to lock this profile" }, { status: 400 });
  }
  if (wantsUnlock) {
    data.pinRequired = false;
    data.pinHash = null;
  }

  if (!Object.keys(data).length) return NextResponse.json({ ok: true });
  const updated = await db.user.update({
    where: { id: user.id },
    data,
    select: { name: true, avatarColor: true, avatar: true, pinRequired: true },
  });
  return NextResponse.json({ ok: true, profile: updated });
}

/** GET /api/profile — the signed-in profile's own lock state (for Settings). */
export async function GET() {
  const user = await getAuthenticatedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const record = await db.user.findUnique({
    where: { id: user.id },
    select: { name: true, avatarColor: true, avatar: true, pinRequired: true },
  });
  return NextResponse.json(record ?? {}, { headers: { "Cache-Control": "no-store" } });
}
