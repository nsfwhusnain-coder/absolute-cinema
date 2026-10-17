import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import { createInvite, inviteState, listInvites, normalizeInviteCode, revokeInvite } from "@/lib/invites";

export const dynamic = "force-dynamic";

/**
 * Invite links, for the admin (Settings → Profiles).
 *
 * GET    /api/admin/invites                                    — every invite with its state, newest first
 * POST   /api/admin/invites  { note?, maxUses?, expiresInDays? } — a new invite
 * DELETE /api/admin/invites?code=…                             — revoke one
 *
 * `publicBase` is the site's own public address (an https NEXTAUTH_URL, as a
 * tunnel gives) when it has one: the links an admin copies point there, even
 * from a page opened at another address (the machine itself). A household's
 * http address is no address for an invite; the page's own is used then.
 */
function publicBase(): string | null {
  const url = process.env.NEXTAUTH_URL?.trim().replace(/\/+$/, "");
  return url && url.startsWith("https://") ? url : null;
}

export async function GET() {
  const admin = await getAuthenticatedUser();
  if (!admin?.isAdmin) return NextResponse.json({ error: "Admin only" }, { status: 403 });
  const now = Date.now();
  const invites = (await listInvites()).map((invite) => ({ ...invite, state: inviteState(invite, now) }));
  return NextResponse.json({ invites, publicBase: publicBase() }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  const admin = await getAuthenticatedUser();
  if (!admin?.isAdmin) return NextResponse.json({ error: "Admin only" }, { status: 403 });
  const body = ((await req.json().catch(() => null)) ?? {}) as { note?: unknown; maxUses?: unknown; expiresInDays?: unknown };
  const invite = await createInvite({
    note: typeof body.note === "string" ? body.note : "",
    maxUses: typeof body.maxUses === "number" ? body.maxUses : null,
    expiresInDays: typeof body.expiresInDays === "number" ? body.expiresInDays : null,
  });
  return NextResponse.json({ invite: { ...invite, state: inviteState(invite) }, publicBase: publicBase() });
}

export async function DELETE(req: NextRequest) {
  const admin = await getAuthenticatedUser();
  if (!admin?.isAdmin) return NextResponse.json({ error: "Admin only" }, { status: 403 });
  const code = normalizeInviteCode(req.nextUrl.searchParams.get("code"));
  if (!code || !(await revokeInvite(code))) return NextResponse.json({ error: "No such invite" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
