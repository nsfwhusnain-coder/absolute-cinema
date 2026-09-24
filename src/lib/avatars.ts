/**
 * Profile pictures in public/avatars — DiceBear "Lorelei", "Open Peeps" and
 * "Thumbs" artwork, all CC0 (public domain). Each is drawn on the profile's colour.
 */
export const AVATAR_GROUPS = [
  {
    label: "People",
    ids: ["lorelei-aria", "lorelei-blake", "lorelei-cleo", "lorelei-dante", "lorelei-ezra", "lorelei-freya", "lorelei-luna", "lorelei-nova", "lorelei-quinn", "lorelei-sage"],
  },
  {
    label: "Characters",
    ids: ["peeps-aria", "peeps-cleo", "peeps-dante", "peeps-ezra", "peeps-freya", "peeps-hana", "peeps-luna", "peeps-milo", "peeps-otto", "peeps-sage"],
  },
  {
    label: "Blobs",
    ids: ["thumbs-blake", "thumbs-ezra", "thumbs-gus", "thumbs-hana", "thumbs-nova", "thumbs-quinn"],
  },
] as const;

export type AvatarId = (typeof AVATAR_GROUPS)[number]["ids"][number];

const ALL = new Set<string>(AVATAR_GROUPS.flatMap((g) => g.ids));

/** "" (no picture: the name's initial) or one of the bundled avatars. */
export function isAvatarId(value: unknown): value is AvatarId | "" {
  return value === "" || (typeof value === "string" && ALL.has(value));
}

export function avatarSrc(id: string): string | null {
  return ALL.has(id) ? `/avatars/${id}.svg` : null;
}

/** A varied default so a household's new profiles don't all look alike. */
export function defaultAvatar(existingCount: number): AvatarId {
  const picks = AVATAR_GROUPS.flatMap((g) => g.ids.slice(0, 4));
  return picks[(existingCount * 5) % picks.length]!;
}
