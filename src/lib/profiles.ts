import { db } from "@/lib/db";
import { AVATAR_COLORS, isHexColor } from "@/lib/avatar-colors";
import { isPublicInstance } from "@/lib/public-instance";

export { AVATAR_COLORS };

/** Any #rrggbb: the palette's colours or a custom one from the colour picker. */
export function isAvatarColor(value: unknown): value is string {
  return isHexColor(value);
}

/** Next colour in the palette for a new profile, so a household's avatars differ. */
export function defaultAvatarColor(existingCount: number): string {
  return AVATAR_COLORS[existingCount % AVATAR_COLORS.length]!;
}

export const SIGNUPS_OPEN_SETTING = "signups_open";
export const PROFILE_PICKER_SETTING = "profile_picker";
export const REQUIRE_PIN_SETTING = "require_pin";

/**
 * A setting's value before the admin has chosen one, from the environment:
 * SIGNUPS_OPEN_DEFAULT, PROFILE_PICKER_DEFAULT and REQUIRE_PIN_DEFAULT ("on" or
 * "off") let a server shared on a public address start locked down
 * (docs/SHARING.md). Unset, a household's defaults apply.
 */
function envDefault(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (value === "on" || value === "1" || value === "true") return true;
  if (value === "off" || value === "0" || value === "false") return false;
  return fallback;
}

async function flag(key: string, fallback: boolean): Promise<boolean> {
  const row = await db.appSetting.findUnique({ where: { key } }).catch(() => null);
  if (!row) return fallback;
  return row.value !== "off";
}

/** Anyone can create a profile from the sign-in screen (default on; off on a public instance). */
export function signupsOpen(): Promise<boolean> {
  return flag(SIGNUPS_OPEN_SETTING, envDefault("SIGNUPS_OPEN_DEFAULT", !isPublicInstance()));
}

/** The sign-in screen lists profiles to pick from (default on; off on a public instance). */
export function profilePickerEnabled(): Promise<boolean> {
  return flag(PROFILE_PICKER_SETTING, envDefault("PROFILE_PICKER_DEFAULT", !isPublicInstance()));
}

/** Every new profile must have a PIN (default off; on on a public instance): on a public address, a profile without one is anyone's. */
export function requirePin(): Promise<boolean> {
  return flag(REQUIRE_PIN_SETTING, envDefault("REQUIRE_PIN_DEFAULT", isPublicInstance()));
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
