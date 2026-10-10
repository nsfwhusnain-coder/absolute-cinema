/**
 * Profile pictures.
 *
 * A profile's `avatar` is one of:
 *  - ""                  the name's initials on the profile colour
 *  - a bundled id        an illustration in public/avatars (DiceBear sets; see public/avatars/CREDITS.md)
 *  - "emoji:<emoji>"     any emoji, large, on the profile colour
 *  - "tmdb:/<path>.jpg"  a famous face: a person's photo from TMDB
 *  - "upload:<file>"     the profile's own photo, uploaded in Settings and stored on the server
 *
 * Client-safe: no server imports.
 */

export interface AvatarGroup {
  label: string;
  ids: readonly string[];
  /** Artwork that fills its square edge to edge (no colour around it). */
  fullBleed?: boolean;
}

export const AVATAR_GROUPS: readonly AvatarGroup[] = [
  { label: "Adventurers", ids: ["adventurer-ripley", "adventurer-neo", "adventurer-marty", "adventurer-leia", "adventurer-indy", "adventurer-rocky", "adventurer-amelie", "adventurer-ferris", "adventurer-trinity", "adventurer-maverick", "adventurer-juno", "adventurer-wednesday"] },
  { label: "Toons", ids: ["avataaars-rocky", "avataaars-amelie", "avataaars-ferris", "avataaars-trinity", "avataaars-maverick", "avataaars-juno", "avataaars-wednesday", "avataaars-groot", "avataaars-elio", "avataaars-mia", "avataaars-tony", "avataaars-clarice"] },
  { label: "Robots", ids: ["bottts-juno", "bottts-wednesday", "bottts-groot", "bottts-elio", "bottts-mia", "bottts-tony", "bottts-clarice", "bottts-eleven", "bottts-arya", "bottts-walter", "bottts-moana", "bottts-sarah"] },
  { label: "Pixel", ids: ["pixel-neo", "pixel-marty", "pixel-leia", "pixel-indy", "pixel-rocky", "pixel-amelie", "pixel-ferris", "pixel-trinity", "pixel-maverick", "pixel-juno", "pixel-wednesday", "pixel-groot"] },
  { label: "People", ids: ["lorelei-aria", "lorelei-blake", "lorelei-cleo", "lorelei-dante", "lorelei-ezra", "lorelei-freya", "lorelei-luna", "lorelei-nova", "lorelei-quinn", "lorelei-sage"] },
  { label: "Sketches", ids: ["sketch-moana", "sketch-sarah", "sketch-ellie", "sketch-kubo", "sketch-ripley", "sketch-neo", "sketch-marty", "sketch-leia", "sketch-indy", "sketch-rocky", "sketch-amelie", "sketch-ferris"] },
  { label: "Big smiles", ids: ["smile-wednesday", "smile-groot", "smile-elio", "smile-mia", "smile-tony", "smile-clarice", "smile-eleven", "smile-arya", "smile-walter", "smile-moana", "smile-sarah", "smile-ellie"] },
  { label: "Toon heads", ids: ["toon-clarice", "toon-eleven", "toon-arya", "toon-walter", "toon-moana", "toon-sarah", "toon-ellie", "toon-kubo", "toon-ripley", "toon-neo", "toon-marty", "toon-leia"] },
  { label: "Portraits", ids: ["micah-amelie", "micah-ferris", "micah-trinity", "micah-maverick", "micah-juno", "micah-wednesday", "micah-groot", "micah-elio", "micah-mia", "micah-tony", "micah-clarice", "micah-eleven"] },
  { label: "Personas", ids: ["persona-sarah", "persona-ellie", "persona-kubo", "persona-ripley", "persona-neo", "persona-marty", "persona-leia", "persona-indy", "persona-rocky", "persona-amelie", "persona-ferris", "persona-trinity"] },
  { label: "Smileys", ids: ["emoji-tony", "emoji-clarice", "emoji-eleven", "emoji-arya", "emoji-walter", "emoji-moana", "emoji-sarah", "emoji-ellie", "emoji-kubo", "emoji-ripley", "emoji-neo", "emoji-marty"], fullBleed: true },
  { label: "Characters", ids: ["peeps-aria", "peeps-cleo", "peeps-dante", "peeps-ezra", "peeps-freya", "peeps-hana", "peeps-luna", "peeps-milo", "peeps-otto", "peeps-sage"] },
  { label: "Blobs", ids: ["thumbs-blake", "thumbs-ezra", "thumbs-gus", "thumbs-hana", "thumbs-nova", "thumbs-quinn"] },
];

/** Emoji offered in the picker; any other emoji can be typed. */
export const AVATAR_EMOJI = [
  "🎬", "🍿", "🎞️", "📽️", "🎭", "🎟️", "🦖", "👽", "🤖", "👾", "🦄", "🐉",
  "🦊", "🐼", "🐯", "🐸", "🐙", "🦈", "🦉", "🐺", "🦁", "🐨", "🐧", "🐝",
  "👻", "💀", "🎃", "🧙", "🥷", "🦸", "🧛", "🧜", "🌙", "⭐", "🔥", "⚡",
  "🌈", "🌊", "🍕", "🍩", "🌮", "🍣", "🎮", "🎸", "🎧", "🚀", "🛸", "🏎️",
  "⚽", "🏀", "👑", "💎", "🌵", "🍄", "🌸", "🧸",
] as const;

export const EMOJI_PREFIX = "emoji:";
export const TMDB_PREFIX = "tmdb:";
export const UPLOAD_PREFIX = "upload:";
const TMDB_FACE_BASE = "https://image.tmdb.org/t/p/w185";
/** Uploaded photos are served by /api/avatar/<file>. */
export const UPLOAD_FILE = /^[a-z0-9]{8,40}-[a-z0-9]{6,24}\.webp$/;
const TMDB_PATH = /^\/[A-Za-z0-9_-]{4,64}\.(?:jpe?g|png|webp)$/;

const BUNDLED = new Map<string, AvatarGroup>(AVATAR_GROUPS.flatMap((g) => g.ids.map((id) => [id, g] as const)));

/** One emoji (with skin tones, flags and ZWJ sequences), nothing else. */
export function isSingleEmoji(value: string): boolean {
  if (!value || value.length > 16) return false;
  const segments = typeof Intl !== "undefined" && "Segmenter" in Intl
    ? [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)]
    : [value];
  return segments.length === 1 && /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(value);
}

export type ResolvedAvatar =
  | { kind: "initials" }
  | { kind: "image"; src: string; fit: "contain" | "cover"; fullBleed: boolean }
  | { kind: "emoji"; emoji: string };

/** How to draw a profile's picture. Unknown values fall back to initials. */
export function resolveAvatar(value: string | null | undefined): ResolvedAvatar {
  if (!value) return { kind: "initials" };
  const group = BUNDLED.get(value);
  if (group) return { kind: "image", src: `/avatars/${value}.svg`, fit: "contain", fullBleed: Boolean(group.fullBleed) };
  if (value.startsWith(EMOJI_PREFIX)) {
    const emoji = value.slice(EMOJI_PREFIX.length);
    return isSingleEmoji(emoji) ? { kind: "emoji", emoji } : { kind: "initials" };
  }
  if (value.startsWith(TMDB_PREFIX)) {
    const path = value.slice(TMDB_PREFIX.length);
    return TMDB_PATH.test(path) ? { kind: "image", src: `${TMDB_FACE_BASE}${path}`, fit: "cover", fullBleed: true } : { kind: "initials" };
  }
  if (value.startsWith(UPLOAD_PREFIX)) {
    const file = value.slice(UPLOAD_PREFIX.length);
    return UPLOAD_FILE.test(file) ? { kind: "image", src: `/api/avatar/${file}`, fit: "cover", fullBleed: true } : { kind: "initials" };
  }
  return { kind: "initials" };
}

/**
 * Whether a profile may be given this picture through the API. Uploaded
 * photos are set only by the upload endpoint, so "upload:" values are
 * accepted only when they are the profile's current picture (unchanged).
 */
export function isAvatarValue(value: unknown, current?: string | null): value is string {
  if (typeof value !== "string") return false;
  if (value === "" || BUNDLED.has(value)) return true;
  if (value.startsWith(UPLOAD_PREFIX)) return value === current;
  return resolveAvatar(value).kind !== "initials";
}

/** Kept for older callers: the bundled picture's URL, or null. */
export function avatarSrc(id: string): string | null {
  return BUNDLED.has(id) ? `/avatars/${id}.svg` : null;
}

/** A varied default so a household's new profiles don't all look alike. */
export function defaultAvatar(existingCount: number): string {
  const picks = AVATAR_GROUPS.filter((g) => !g.fullBleed).flatMap((g) => g.ids.slice(0, 3));
  return picks[(existingCount * 7) % picks.length]!;
}

/** Every bundled picture, for "Surprise me". */
export function allBundledAvatars(): string[] {
  return [...BUNDLED.keys()];
}
