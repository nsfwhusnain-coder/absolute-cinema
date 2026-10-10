import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { UPLOAD_FILE, UPLOAD_PREFIX } from "@/lib/avatars";

/** Uploaded profile photos live next to the database, so they survive rebuilds and are backed up with it. */
export function avatarDir(): string {
  if (process.env.AVATAR_DIR) return process.env.AVATAR_DIR;
  return existsSync("/app/db") ? "/app/db/avatars" : join(process.cwd(), "db", "avatars");
}

/** What a photo is stored as: a 384 px square, enough for a retina profile tile. */
const STORED_SIZE = 384;
/** Uploads above this are refused before any decoding. */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

function fileFor(userId: string): string {
  const owner = userId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 40).padEnd(8, "0");
  return `${owner}-${randomBytes(6).toString("hex")}.webp`;
}

/**
 * Re-encodes an uploaded image as a square WebP. Decoding with sharp both
 * normalises it (EXIF rotation, colour) and proves it really is an image;
 * anything sharp cannot read is rejected. Returns the avatar value to store.
 */
export async function saveUploadedAvatar(userId: string, input: Buffer): Promise<string> {
  const image = sharp(input, { limitInputPixels: 50_000_000, failOn: "error" }).rotate();
  const meta = await image.metadata();
  if (!meta.width || !meta.height) throw new Error("That file isn't an image.");
  const webp = await image
    .resize(STORED_SIZE, STORED_SIZE, { fit: "cover", position: "attention" })
    .webp({ quality: 84 })
    .toBuffer();
  const dir = avatarDir();
  await mkdir(dir, { recursive: true });
  const file = fileFor(userId);
  await writeFile(join(dir, file), webp);
  return `${UPLOAD_PREFIX}${file}`;
}

/** Removes the stored photo behind an avatar value (no-op for any other kind). */
export async function deleteUploadedAvatar(value: string | null | undefined): Promise<void> {
  if (!value?.startsWith(UPLOAD_PREFIX)) return;
  const file = value.slice(UPLOAD_PREFIX.length);
  if (!UPLOAD_FILE.test(file)) return;
  await unlink(join(avatarDir(), file)).catch(() => undefined);
}

export async function readUploadedAvatar(file: string): Promise<Buffer | null> {
  if (!UPLOAD_FILE.test(file)) return null;
  return readFile(join(avatarDir(), file)).catch(() => null);
}
