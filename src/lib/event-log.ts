import { createHmac } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

/**
 * A durable record of what the service did: every search, every start, every
 * failure, as one JSON line each under `db/events`. The container's own log
 * holds the same lines and is thrown away with the container on every update,
 * which is exactly when they are wanted: "was it like this before?" could not
 * be answered. Read them with `scripts/playback-report.ts`.
 *
 * Nothing leaves the machine. `EVENT_LOG=0` turns it off.
 */

/** Which process wrote the line; each has its own file, so no two processes share one. */
export type EventSource = "web" | "remux" | "scraper";

export const EVENT_RETENTION_DAYS = 30;
const MAX_DAILY_BYTES = 64 * 1024 * 1024;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const DAY_MS = 86_400_000;
const VIEWER_TAG_LENGTH = 16;
const FILE_NAME = /^(web|remux|scraper)-(\d{4}-\d{2}-\d{2})\.jsonl$/;

const day = (at: number) => new Date(at).toISOString().slice(0, 10);

export function eventLogDir(): string {
  if (process.env.EVENT_LOG_DIR) return process.env.EVENT_LOG_DIR;
  // Next to the database in the container; under ./db when run outside Docker.
  return existsSync("/app/db") ? "/app/db/events" : join(process.cwd(), "db", "events");
}

export function eventFileName(source: EventSource, at: number): string {
  return `${source}-${day(at)}.jsonl`;
}

/** True for an event file older than the days kept; false for any other file. */
export function isExpiredEventFile(name: string, now: number): boolean {
  const written = FILE_NAME.exec(name)?.[2];
  return written !== undefined && written < day(now - EVENT_RETENTION_DAYS * DAY_MS);
}

/**
 * A viewer as a short tag: the same person reads the same across lines, and
 * across the client analytics beside this log, without their account id being
 * written down.
 */
export function viewerTag(userId: string): string {
  return createHmac("sha256", process.env.NEXTAUTH_SECRET || "absolute-cinema").update(userId).digest("hex").slice(0, VIEWER_TAG_LENGTH);
}

/** One line of the log. A `userId` among the fields is written as its tag. */
export function eventLine(event: string, fields: Record<string, unknown>, at: number): string {
  const { userId, ...rest } = fields;
  const viewer = typeof userId === "string" && userId ? { viewer: viewerTag(userId) } : {};
  return `${JSON.stringify({ at, event, ...viewer, ...rest })}\n`;
}

const enabled = () => process.env.EVENT_LOG !== "0" && (process.env.NODE_ENV !== "test" || Boolean(process.env.EVENT_LOG_DIR));

let queue: Promise<void> = Promise.resolve();
let lastPrunedAt = 0;
const written = new Map<string, number>();

async function sizeSoFar(path: string): Promise<number> {
  const known = written.get(path);
  if (known !== undefined) return known;
  const size = await stat(path).then((s) => s.size, () => 0);
  written.set(path, size);
  return size;
}

async function prune(dir: string, now: number): Promise<void> {
  if (now - lastPrunedAt < PRUNE_INTERVAL_MS) return;
  lastPrunedAt = now;
  for (const name of await readdir(dir)) if (isExpiredEventFile(name, now)) await unlink(join(dir, name));
  for (const path of written.keys()) if (!path.endsWith(`${day(now)}.jsonl`)) written.delete(path);
}

async function append(source: EventSource, line: string, now: number): Promise<void> {
  const dir = eventLogDir();
  const path = join(dir, eventFileName(source, now));
  await mkdir(dir, { recursive: true });
  const size = await sizeSoFar(path);
  if (size + line.length > MAX_DAILY_BYTES) return;
  await appendFile(path, line, "utf8");
  written.set(path, size + Buffer.byteLength(line));
  await prune(dir, now);
}

/** Writes an event to the durable log. Never throws and is never waited on: a full disk must not stop a film. */
export function recordEvent(source: EventSource, event: string, fields: Record<string, unknown> = {}, now = Date.now()): void {
  if (!enabled()) return;
  const line = eventLine(event, fields, now);
  queue = queue.then(() => append(source, line, now)).catch(() => undefined);
}

/** Resolves once everything recorded so far is on disk. */
export function eventLogSettled(): Promise<void> {
  return queue;
}

/** An event of the web app: to the container's log as before, and to the durable one. */
export function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  console.info(JSON.stringify({ event, ...fields }));
  recordEvent("web", event, fields);
}
