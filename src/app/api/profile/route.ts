import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { getAuthenticatedUser } from "@/lib/auth";
import { isAvatarColor } from "@/lib/profiles";

const PIN = /^\d{4,10}$/;

/**
 * PATCH /api/profile — the signed-in profile edits itself.
 * Body: { avatarColor?, name?, currentPin?, newPin? }
 * Renaming or changing the PIN requires the current PIN.
 */
export async function PATCH(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as {
    avatarColor?: unknown;
    name?: unknown;
    currentPin?: unknown;
    newPin?: unknown;
  };
  const data: { avatarColor?: string; name?: string; pinHash?: string } = {};

  if (body.avatarColor !== undefined) {
    if (!isAvatarColor(body.avatarColor)) return NextResponse.json({ error: "Unknown colour" }, { status: 400 });
    data.avatarColor = body.avatarColor;
  }

  const wantsName = typeof body.name === "string" && body.name.trim() !== user.name;
  const wantsPin = body.newPin !== undefined;
  if (wantsName || wantsPin) {
    const record = await db.user.findUnique({ where: { id: user.id } });
    const current = typeof body.currentPin === "string" ? body.currentPin : "";
    if (!record || !(await bcrypt.compare(current, record.pinHash))) {
      return NextResponse.json({ error: "Your current PIN isn't right." }, { status: 403 });
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
    }
  }

  if (!Object.keys(data).length) return NextResponse.json({ ok: true });
  const updated = await db.user.update({
    where: { id: user.id },
    data,
    select: { name: true, avatarColor: true },
  });
  return NextResponse.json({ ok: true, profile: updated });
}
