import type { SubtitleOption } from "./store";

const ENGLISH = /^(en|eng|english)\b/i;

export function isEnglishLanguage(language: string | null | undefined): boolean {
  return Boolean(language && ENGLISH.test(language));
}

/**
 * Subtitles are not optional when the viewer cannot follow the audio: an
 * anime or foreign film in its original language. An unknown audio language
 * on a non-English title counts as the original one, since embed servers
 * rarely say and the original audio is what they almost always carry.
 */
export function subtitlesRequired(originalLanguage: string | null | undefined, audioLanguage: string | null | undefined): boolean {
  if (!originalLanguage || isEnglishLanguage(originalLanguage)) return false;
  return !isEnglishLanguage(audioLanguage);
}

/** A complete English track the viewer can read (not signs/songs only). */
export function hasFullEnglish(options: readonly SubtitleOption[]): boolean {
  return options.some((o) => isEnglishLanguage(o.language) && !o.partial);
}

/**
 * Tracks inside the release are timed to that exact release; downloaded ones
 * are matched by episode number, which anime numbering often gets wrong. So
 * an in-file English track replaces a downloaded one the viewer did not pick.
 */
export function betterThanExternal(options: readonly SubtitleOption[], activeId: string | null): SubtitleOption | undefined {
  const active = options.find((o) => o.id === activeId);
  if (!active || active.origin !== "external") return undefined;
  return options.find(
    (o) => (o.origin === "embedded" || o.origin === "stream") && !o.partial && isEnglishLanguage(o.language) === isEnglishLanguage(active.language)
  );
}
