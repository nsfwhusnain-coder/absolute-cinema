"use client";

import type { LoaderLook } from "@/components/loader/cinematic-loader";

export function loaderLookQueryKey(mediaType: string, id: number) {
  return ["loader-look", mediaType, id] as const;
}

/** A title's loading-scene colours and genres (see /api/loader-palette). */
export async function fetchLoaderLook(mediaType: string, id: number): Promise<LoaderLook> {
  const res = await fetch(`/api/loader-palette?type=${mediaType}&id=${id}`);
  if (!res.ok) return { genres: [] };
  return (await res.json()) as LoaderLook;
}
