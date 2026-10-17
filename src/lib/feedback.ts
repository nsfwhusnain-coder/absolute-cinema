/**
 * Feedback from testers: what went wrong, or what would make the site better.
 * It is written from the player's menu or from Settings, and the admin reads
 * it in Settings → Server → Feedback from viewers.
 *
 * Kept as one JSON setting, newest first, like the invite list
 * (src/lib/invites.ts): the admin reads a few dozen at most, and the list is
 * capped, so reading and writing it whole costs nothing.
 */

import { randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import { FEEDBACK_CATEGORIES, FEEDBACK_MESSAGE_MAX, type FeedbackCategory } from "@/lib/feedback-options";

export const FEEDBACK_SETTING = "feedback";

/** Items kept at most; past it the oldest go first. */
const MAX_FEEDBACK = 500;

/** What the page knew when the feedback was sent. Every field is optional. */
export interface FeedbackContext {
  /** The page the form was opened on. */
  path?: string;
  /** The film or show, with the episode when there is one. */
  title?: string;
  mediaType?: "movie" | "tv";
  tmdbId?: number;
  season?: number;
  episode?: number;
  /** Where in the film the report was made, in seconds. */
  positionS?: number;
  /** The picture's height as it was shown, e.g. "1080p". */
  quality?: string;
  /** "remux", "native" or "web" (docs/TELEMETRY.md). */
  delivery?: string;
  provider?: string;
  /** The player engine that was playing the file. */
  engine?: string;
  /** How many times playback had stalled, when the player counts them. */
  stalls?: number;
  device?: string;
  userAgent?: string;
}

export interface FeedbackItem {
  id: string;
  /** Epoch ms. */
  at: number;
  userId: string;
  /** The sender's profile name when they sent it. */
  name: string;
  category: FeedbackCategory;
  message: string;
  context?: FeedbackContext;
}

/** Thrown when feedback cannot be kept. Its message is written for the sender to read. */
export class FeedbackRejected extends Error {}

/** Text fields of a context, each with the most characters it keeps. */
const TEXT_LIMITS = { path: 200, title: 120, quality: 20, delivery: 20, provider: 40, engine: 20, device: 40, userAgent: 200 } as const;
/** Whole numbers: ids, episode numbers and counts. */
const INTEGER_KEYS = ["tmdbId", "season", "episode", "stalls"] as const;
/** Other numbers: where in the film a report was made. */
const NUMBER_KEYS = ["positionS"] as const;

type Tx = Pick<typeof db, "appSetting">;

export function isFeedbackCategory(value: unknown): value is FeedbackCategory {
  return typeof value === "string" && (FEEDBACK_CATEGORIES as readonly string[]).includes(value);
}

/** A new id: twelve hex characters, so no two items in a list of 500 are likely to share one. */
function newFeedbackId(): string {
  return randomBytes(6).toString("hex");
}

/**
 * The context as the page sent it, reduced to the fields this file knows:
 * unknown keys are dropped, text is trimmed and cut, and a number that is not
 * finite (or, for counts and ids, not a whole number), or that is negative, is
 * dropped. Undefined when nothing is left.
 */
export function sanitizeFeedbackContext(raw: unknown): FeedbackContext | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const input = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, limit] of Object.entries(TEXT_LIMITS)) {
    const value = input[key];
    if (typeof value !== "string") continue;
    const text = value.trim().slice(0, limit).trim();
    if (text) out[key] = text;
  }
  if (input.mediaType === "movie" || input.mediaType === "tv") out.mediaType = input.mediaType;
  for (const key of INTEGER_KEYS) {
    const value = input[key];
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) out[key] = value;
  }
  for (const key of NUMBER_KEYS) {
    const value = input[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) out[key] = value;
  }
  return Object.keys(out).length > 0 ? (out as FeedbackContext) : undefined;
}

/** An item as the setting stores it. Anything else in a damaged list is skipped. */
function isItem(value: unknown): value is FeedbackItem {
  const item = value as Partial<FeedbackItem> | null;
  return (
    !!item &&
    typeof item === "object" &&
    typeof item.id === "string" &&
    typeof item.at === "number" &&
    typeof item.message === "string" &&
    isFeedbackCategory(item.category)
  );
}

function parse(value: string | null | undefined): FeedbackItem[] {
  if (!value) return [];
  try {
    const list: unknown = JSON.parse(value);
    return Array.isArray(list) ? list.filter(isItem) : [];
  } catch {
    return [];
  }
}

async function read(tx: Tx = db): Promise<FeedbackItem[]> {
  const row = await tx.appSetting.findUnique({ where: { key: FEEDBACK_SETTING } });
  return parse(row?.value);
}

async function write(list: FeedbackItem[], tx: Tx = db): Promise<void> {
  const value = JSON.stringify(list);
  await tx.appSetting.upsert({ where: { key: FEEDBACK_SETTING }, update: { value }, create: { key: FEEDBACK_SETTING, value } });
}

/** Every item, newest first. */
export async function listFeedback(): Promise<FeedbackItem[]> {
  return read();
}

/**
 * Keeps one piece of feedback and returns it. The category, message and context
 * come straight from a request, so they are checked here: a bad category or an
 * empty or over-long message throws a FeedbackRejected, and the context is
 * sanitised (see sanitizeFeedbackContext).
 */
export async function addFeedback(
  input: { userId: string; name: string; category: unknown; message: unknown; context?: unknown },
  now = Date.now()
): Promise<FeedbackItem> {
  if (!isFeedbackCategory(input.category)) throw new FeedbackRejected("Pick what your feedback is about.");
  const message = typeof input.message === "string" ? input.message.trim() : "";
  if (!message) throw new FeedbackRejected("Write a message first.");
  if (message.length > FEEDBACK_MESSAGE_MAX) throw new FeedbackRejected(`Keep your message to ${FEEDBACK_MESSAGE_MAX} characters.`);
  const context = sanitizeFeedbackContext(input.context);
  const item: FeedbackItem = {
    id: newFeedbackId(),
    at: now,
    userId: input.userId,
    name: input.name,
    category: input.category,
    message,
    ...(context ? { context } : {}),
  };
  await db.$transaction(async (tx) => {
    const list = await read(tx);
    await write([item, ...list].slice(0, MAX_FEEDBACK), tx);
  });
  return item;
}

/** Removes one item. False when there is no such item. */
export async function deleteFeedback(id: string): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const list = await read(tx);
    const kept = list.filter((item) => item.id !== id);
    if (kept.length === list.length) return false;
    await write(kept, tx);
    return true;
  });
}
