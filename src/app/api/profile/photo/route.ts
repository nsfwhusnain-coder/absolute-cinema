import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { MAX_UPLOAD_BYTES, deleteUploadedAvatar, saveUploadedAvatar } from "@/lib/avatar-store";
import { RateLimiter } from "@/lib/rate-limit";

export const runtime = "nodejs";

const limiter = new RateLimiter({ limit: 20, windowMs: 10 * 60 * 1000 });

async function readBody(req: NextRequest): Promise<Buffer | null> {
  const declared = Number(req.headers.get("content-length") || 0);
  if (declared > MAX_UPLOAD_BYTES) return null;
  const reader = req.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_UPLOAD_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** POST /api/profile/photo — body: the image bytes. Sets it as the signed-in profile's picture. */
export async function POST(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!limiter.consume(user.id).allowed) return NextResponse.json({ error: "Too many uploads, try again in a few minutes" }, { status: 429 });
  const body = await readBody(req);
  if (!body?.length) return NextResponse.json({ error: "Pick an image up to 8 MB" }, { status: 413 });

  let avatar: string;
  try {
    avatar = await saveUploadedAvatar(user.id, body);
  } catch {
    return NextResponse.json({ error: "That file isn't an image we can use. Try a JPG, PNG or WebP photo." }, { status: 415 });
  }
  const previous = await db.user.findUnique({ where: { id: user.id }, select: { avatar: true } });
  await db.user.update({ where: { id: user.id }, data: { avatar } });
  await deleteUploadedAvatar(previous?.avatar);
  return NextResponse.json({ ok: true, avatar });
}

/** DELETE /api/profile/photo — back to an illustrated picture. */
export async function DELETE() {
  const user = await getAuthenticatedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const record = await db.user.findUnique({ where: { id: user.id }, select: { avatar: true } });
  if (record?.avatar.startsWith("upload:")) {
    await db.user.update({ where: { id: user.id }, data: { avatar: "" } });
    await deleteUploadedAvatar(record.avatar);
  }
  return NextResponse.json({ ok: true, avatar: "" });
}
