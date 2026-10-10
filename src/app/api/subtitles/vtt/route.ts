import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUserId } from "@/lib/auth";
import { downloadAndConvertVtt, isAllowedSubtitleUrl } from "@/lib/subtitles/subtitles-service";

export async function GET(req: NextRequest) {
  const userId = await getAuthenticatedUserId();
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });

  const url = new URL(req.url);
  const downloadUrl = url.searchParams.get("url");

  if (!downloadUrl) {
    return new NextResponse("Missing url parameter", { status: 400 });
  }
  // Only the subtitle service's own files: this route must never fetch
  // arbitrary addresses (internal ones included) on a viewer's behalf.
  if (!isAllowedSubtitleUrl(downloadUrl)) {
    return new NextResponse("Unsupported subtitle address", { status: 400 });
  }

  const vttText = await downloadAndConvertVtt(downloadUrl);
  if (!vttText) {
    return new NextResponse("WEBVTT\n\n", {
      status: 200,
      headers: { "Content-Type": "text/vtt; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  return new NextResponse(vttText, {
    status: 200,
    headers: {
      "Content-Type": "text/vtt; charset=utf-8",
      "Cache-Control": "private, max-age=86400, immutable",
    },
  });
}
