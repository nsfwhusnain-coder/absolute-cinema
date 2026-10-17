import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import { deleteFeedback, listFeedback } from "@/lib/feedback";

export const dynamic = "force-dynamic";

/**
 * Feedback from testers, for the admin (Settings → Server → Feedback from viewers).
 *
 * GET    /api/admin/feedback          — every item, newest first
 * DELETE /api/admin/feedback?id=…     — remove one
 */

export async function GET() {
  const admin = await getAuthenticatedUser();
  if (!admin?.isAdmin) return NextResponse.json({ error: "Admin only" }, { status: 403 });
  return NextResponse.json({ items: await listFeedback() }, { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(req: NextRequest) {
  const admin = await getAuthenticatedUser();
  if (!admin?.isAdmin) return NextResponse.json({ error: "Admin only" }, { status: 403 });
  const id = req.nextUrl.searchParams.get("id") ?? "";
  if (!id || !(await deleteFeedback(id))) return NextResponse.json({ error: "No such feedback" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
