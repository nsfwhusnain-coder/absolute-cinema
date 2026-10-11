import type { PlaybackResponse, PlaybackSource } from "./types";

/** What one answer to "what can play this title?" held, in a form small enough to keep. Never a link. */
export interface AnswerFacts {
  status: string;
  sources: number;
  debrid: number;
  web: number;
  /** Tallest picture on offer, and the tallest from a debrid service; 0 when unknown or none. */
  bestHeight: number;
  bestDebridHeight: number;
  providers: Record<string, number>;
  partial: boolean;
  fourKSettled?: boolean;
  debridSettled?: boolean;
}

const tallest = (sources: readonly PlaybackSource[]) => sources.reduce((best, s) => Math.max(best, s.maxHeight ?? 0), 0);

export function answerFacts(response: PlaybackResponse): AnswerFacts {
  const sources = response.sources ?? [];
  const debrid = sources.filter((s) => s.origin === "debrid");
  const providers: Record<string, number> = {};
  for (const source of sources) providers[source.provider] = (providers[source.provider] ?? 0) + 1;
  return {
    status: response.status,
    sources: sources.length,
    debrid: debrid.length,
    web: sources.length - debrid.length,
    bestHeight: tallest(sources),
    bestDebridHeight: tallest(debrid),
    providers,
    partial: response.partial === true,
    ...(response.fourKSettled !== undefined ? { fourKSettled: response.fourKSettled } : {}),
    ...(response.debridSettled !== undefined ? { debridSettled: response.debridSettled } : {}),
  };
}
