import { NextRequest, NextResponse } from "next/server";
import { readUploadedAvatar } from "@/lib/avatar-store";

export const runtime = "nodejs";

/**
 * GET /api/avatar/<file> — an uploaded profile photo. Public on purpose: the
 * "Who's watching?" screen shows every profile's picture before anyone signs
 * in, exactly as it shows the illustrated ones. File names are random and
 * never reused, so the response can be cached for good.
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ file: string }> }) {
  const { file } = await ctx.params;
  const data = await readUploadedAvatar(file);
  if (!data) return new NextResponse("Not found", { status: 404 });
  return new NextResponse(new Uint8Array(data), {
    headers: {
      "Content-Type": "image/webp",
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
