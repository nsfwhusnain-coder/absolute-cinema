import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { assignLegacyAvatarColors, profilePickerEnabled, signupsOpen } from "@/lib/profiles";

export const dynamic = "force-dynamic";

/**
 * GET /api/profiles — what the sign-in screen shows. Public by design (it is
 * the "Who's watching?" screen); returns names and colours only, and an
 * empty list when the admin has turned the picker off.
 */
export async function GET() {
  await assignLegacyAvatarColors().catch(() => undefined);
  const [count, picker, open] = await Promise.all([db.user.count(), profilePickerEnabled(), signupsOpen()]);
  const profiles = picker
    ? await db.user.findMany({ select: { name: true, avatarColor: true }, orderBy: { createdAt: "asc" } })
    : [];
  return NextResponse.json(
    { firstRun: count === 0, signupsOpen: open || count === 0, pickerEnabled: picker, profiles },
    { headers: { "Cache-Control": "no-store" } }
  );
}
