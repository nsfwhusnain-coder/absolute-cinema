import { db } from "@/lib/db";
import { AVATAR_COLORS } from "@/lib/avatar-colors";

export { AVATAR_COLORS };


export function isAvatarColor(value: unknown): value is (typeof AVATAR_COLORS)[number] {
  return typeof value === "string" && (AVATAR_COLORS as readonly string[]).includes(value);
}

/** Next colour in the palette for a new profile, so a household's avatars differ. */
export function defaultAvatarColor(existingCount: number): string {
  return AVATAR_COLORS[existingCount % AVATAR_COLORS.length]!;
}

export const SIGNUPS_OPEN_SETTING = "signups_open";
export const PROFILE_PICKER_SETTING = "profile_picker";

async function flag(key: string, fallback: boolean): Promise<boolean> {
  const row = await db.appSetting.findUnique({ where: { key } }).catch(() => null);
  if (!row) return fallback;
  return row.value !== "off";
}

/** Anyone can create a profile from the sign-in screen (default on). */
export function signupsOpen(): Promise<boolean> {
  return flag(SIGNUPS_OPEN_SETTING, true);
}

/** The sign-in screen lists profiles to pick from (default on). */
export function profilePickerEnabled(): Promise<boolean> {
  return flag(PROFILE_PICKER_SETTING, true);
}

const LEGACY_COLORS_SETTING = "avatar_colors_assigned";
let legacyColorsChecked = false;

/**
 * Profiles made before avatar colours existed all got the column default.
 * Once per install, spread them across the palette in creation order so the
 * picker isn't a wall of identical tiles. Profiles already given another
 * colour are left alone.
 */
export async function assignLegacyAvatarColors(): Promise<void> {
  if (legacyColorsChecked) return;
  legacyColorsChecked = true;
  const done = await db.appSetting.findUnique({ where: { key: LEGACY_COLORS_SETTING } });
  if (done) return;
  const users = await db.user.findMany({ select: { id: true, avatarColor: true }, orderBy: { createdAt: "asc" } });
  await db.$transaction([
    ...users
      .map((u, i) => ({ u, color: defaultAvatarColor(i) }))
      .filter(({ u, color }) => u.avatarColor === AVATAR_COLORS[0] && color !== u.avatarColor)
      .map(({ u, color }) => db.user.update({ where: { id: u.id }, data: { avatarColor: color } })),
    db.appSetting.create({ data: { key: LEGACY_COLORS_SETTING, value: "1" } }),
  ]);
}
