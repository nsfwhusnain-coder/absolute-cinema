/**
 * Which loading scene suits a title. Each scene has weights for TMDB genres;
 * a title's genres add up to a score per scene and the pick is random,
 * favouring the strongest matches. Every scene keeps a small base chance so
 * the same film does not always open the same way.
 */

export const LOADER_SCENES = ["stars", "ribbons", "vortex", "currents", "aurora", "city"] as const;
export type LoaderSceneId = (typeof LOADER_SCENES)[number];

export const LOADER_SCENE_LABELS: Record<LoaderSceneId, string> = {
  stars: "Star passage",
  ribbons: "Light ribbons",
  vortex: "Orbital vortex",
  currents: "Atmospheric currents",
  aurora: "Liquid aurora",
  city: "City lights",
};

/** Device override: always show this scene instead of choosing by genre. */
export const LOADER_SCENE_KEY = "absolute-cinema:loader-scene";

export function readSceneOverride(): LoaderSceneId | null {
  try {
    const value = window.localStorage.getItem(LOADER_SCENE_KEY);
    return (LOADER_SCENES as readonly string[]).includes(value ?? "") ? (value as LoaderSceneId) : null;
  } catch {
    return null;
  }
}

/** Atmospheric currents come as embers, dust or mist. */
export type CurrentsMode = "embers" | "dust" | "mist";

const BASE_WEIGHT = 0.35;

// TMDB genre ids (movie and TV lists).
const G = {
  action: 28, adventure: 12, animation: 16, comedy: 35, crime: 80, documentary: 99, drama: 18, family: 10751,
  fantasy: 14, history: 36, horror: 27, music: 10402, mystery: 9648, romance: 10749, scifi: 878, thriller: 53,
  war: 10752, western: 37, actionAdventure: 10759, kids: 10762, scifiFantasy: 10765, warPolitics: 10768,
} as const;

const WEIGHTS: Record<LoaderSceneId, Partial<Record<number, number>>> = {
  stars: { [G.scifi]: 3, [G.scifiFantasy]: 2, [G.adventure]: 2, [G.actionAdventure]: 1, [G.action]: 1 },
  ribbons: { [G.action]: 3, [G.actionAdventure]: 3, [G.adventure]: 1, [G.scifi]: 1, [G.comedy]: 1, [G.thriller]: 1, [G.music]: 1 },
  vortex: { [G.scifi]: 2, [G.scifiFantasy]: 2, [G.mystery]: 2, [G.fantasy]: 1, [G.horror]: 1, [G.thriller]: 1 },
  currents: {
    [G.fantasy]: 3, [G.horror]: 3, [G.western]: 3, [G.mystery]: 2, [G.thriller]: 2, [G.war]: 2, [G.warPolitics]: 2,
    [G.history]: 2, [G.drama]: 1, [G.documentary]: 1,
  },
  aurora: {
    [G.romance]: 3, [G.drama]: 2, [G.animation]: 2, [G.family]: 2, [G.kids]: 2, [G.music]: 2, [G.documentary]: 1, [G.comedy]: 1,
  },
  city: { [G.crime]: 3, [G.thriller]: 2, [G.drama]: 1, [G.romance]: 1, [G.mystery]: 1, [G.comedy]: 1 },
};

export function sceneWeights(genres: readonly number[]): Record<LoaderSceneId, number> {
  const out = {} as Record<LoaderSceneId, number>;
  for (const scene of LOADER_SCENES) {
    out[scene] = BASE_WEIGHT + genres.reduce((sum, g) => sum + (WEIGHTS[scene][g] ?? 0), 0);
  }
  return out;
}

/** `random` is injectable so the choice is testable. */
export function pickScene(genres: readonly number[], random: () => number = Math.random): LoaderSceneId {
  const weights = sceneWeights(genres);
  // Squaring sharpens the preference for strong matches without ruling others out.
  const entries = LOADER_SCENES.map((scene) => [scene, weights[scene] ** 2] as const);
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let roll = random() * total;
  for (const [scene, w] of entries) {
    roll -= w;
    if (roll <= 0) return scene;
  }
  return entries[entries.length - 1]![0];
}

export function currentsMode(genres: readonly number[]): CurrentsMode {
  const has = (...ids: number[]) => ids.some((id) => genres.includes(id));
  if (has(G.western, G.history, G.documentary)) return "dust";
  if (has(G.action, G.actionAdventure, G.war, G.warPolitics, G.fantasy)) return "embers";
  return "mist";
}
