/**
 * Audio and subtitle choices remembered per show (this device), so picking
 * Japanese audio with English subtitles once carries on to the next episode.
 */

const KEY = "absolute-cinema:title-language";
const MAX_TITLES = 200;

export interface TitleLanguage {
  /** Audio language code the viewer picked. */
  audio?: string;
  /** Subtitle language code, or null for "off". Undefined: never chosen. */
  subtitle?: string | null;
  updatedAt: number;
}

type Store = Record<string, TitleLanguage>;

function readStore(): Store {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(KEY) ?? "{}") as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Store) : {};
  } catch {
    return {};
  }
}

export function titleLanguageKey(mediaType: string, tmdbId: number): string {
  return `${mediaType}:${tmdbId}`;
}

export function getTitleLanguage(key: string): TitleLanguage | null {
  if (typeof window === "undefined") return null;
  return readStore()[key] ?? null;
}

export function rememberTitleLanguage(key: string, patch: Partial<Omit<TitleLanguage, "updatedAt">>): void {
  if (typeof window === "undefined") return;
  const store = readStore();
  store[key] = { ...store[key], ...patch, updatedAt: Date.now() };
  const keys = Object.keys(store);
  if (keys.length > MAX_TITLES) {
    keys
      .sort((a, b) => store[a]!.updatedAt - store[b]!.updatedAt)
      .slice(0, keys.length - MAX_TITLES)
      .forEach((k) => delete store[k]);
  }
  try {
    window.localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* private mode: the choice applies to this episode only */
  }
}
