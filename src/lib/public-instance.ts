/**
 * A copy of the site run for people outside the home, reached only through a
 * tunnel (PUBLIC_INSTANCE=1, docs/SHARING.md). On it:
 *
 *  - every viewer is outside the home, so every stream crosses the upload
 *    (the capacity gate, docs/CAPACITY.md);
 *  - debrid files play only through this server, remuxed, and their links
 *    never reach a browser: the debrid services allow one home address, and a
 *    tester's browser reading a link would be a second
 *    (src/lib/playback/served-sources.ts);
 *  - nothing is downloaded whole: a download would take the tunnel's whole
 *    width for an hour, with no seat to account for it;
 *  - the profile switches start locked (src/lib/profiles.ts).
 *
 * Any server can also hold the picture to what its connection carries, with
 * PLAYBACK_MAX_HEIGHT and PLAYBACK_MAX_MBPS.
 */

const ON = new Set(["1", "on", "true"]);

/** The settings read here: the process's environment, or a test's. */
export type Env = Record<string, string | undefined>;

export function isPublicInstance(env: Env = process.env): boolean {
  return ON.has(env.PUBLIC_INSTANCE?.trim().toLowerCase() ?? "");
}

export interface PlaybackCaps {
  /** The tallest picture offered, in lines; null for no limit. */
  maxHeight: number | null;
  /** The heaviest file offered, by its average bitrate; null for no limit. */
  maxBitrateBps: number | null;
}

function bounded(raw: string | undefined, min: number, max: number): number | null {
  const text = raw?.trim();
  const value = Number(text);
  return text && Number.isFinite(value) && value >= min && value <= max ? value : null;
}

export function playbackCaps(env: Env = process.env): PlaybackCaps {
  const mbps = bounded(env.PLAYBACK_MAX_MBPS, 1, 1000);
  return { maxHeight: bounded(env.PLAYBACK_MAX_HEIGHT, 360, 4320), maxBitrateBps: mbps === null ? null : Math.round(mbps * 1e6) };
}

/** No 4K file is ever offered here: the player need not wait for one, nor the server look. */
export function capsRuleOutFourK(caps: PlaybackCaps): boolean {
  return caps.maxHeight !== null && caps.maxHeight < 2160;
}
