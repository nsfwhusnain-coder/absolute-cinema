import { logEvent, recordEvent } from "@/lib/event-log";
import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUserId } from "@/lib/auth";
import { isRefusedLink, refuseSource } from "@/lib/playback/debrid/refused-releases";
import { assessMediaDuration } from "@/lib/playback/media-duration";
import { resolveRemuxSourceUrl } from "@/lib/playback/remux-source";
import { rememberRemuxSession } from "@/lib/playback/remux-sessions";
import { REMUXER_URL, UNUSABLE_HEADER, watcherOf } from "@/lib/playback/remuxer";
import { titleRuntimeMinutes, type RuntimeQuestion } from "@/lib/playback/title-runtime";
import { recordVodOpen, vodOpenOutcome, type VodOpenAnswer } from "@/lib/telemetry/vod-open";

export const dynamic = "force-dynamic";

const OPEN_TIMEOUT_MS = 30_000;
const LANGUAGE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/;
const AUDIO_CAPS = /^[a-z0-9.]{1,40}$/;

const SECONDS_PER_MINUTE = 60;

/**
 * Whether an opened file runs nowhere near as long as the title it was offered
 * as: an episode filed under a film of the same name, a film under an
 * episode, a clip. Its name passed every check, or had nothing to check; its
 * length is the last thing that can tell. The link is forgotten and the
 * release remembered, so the next viewer is not offered it.
 */
async function isAnotherLength(title: RuntimeQuestion, sourceId: string, durationS: number | undefined): Promise<boolean> {
  const runtime = durationS ? await titleRuntimeMinutes(title) : null;
  if (!durationS || !runtime) return false;
  const length = assessMediaDuration(durationS, runtime * SECONDS_PER_MINUTE, title.mediaType);
  if (length.plausible) return false;
  logEvent("vod_other_length_rejected", { ...title, sourceId, durationS: Math.round(durationS), runtimeS: runtime * SECONDS_PER_MINUTE });
  await refuseSource(sourceId, title);
  return true;
}

/**
 * GET /api/vod/open?type=&id=&sourceId=&ticket=&season=&episode=&startAt=
 *                  &audioPreference=&originalLanguage=&audioLanguage=&dolbyVision=&audioCaps=&prewarm=
 *
 * Opens a seekable video-on-demand remux of an MKV source and returns the
 * playlist URL plus the title's real duration.
 */
export async function GET(req: NextRequest) {
  if (process.env.REMUX_ENABLED === "0") {
    return NextResponse.json({ error: "Remuxing is disabled on this server" }, { status: 503 });
  }
  const userId = await getAuthenticatedUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const params = req.nextUrl.searchParams;
  const type = params.get("type");
  const tmdbId = Number(params.get("id"));
  const sourceId = params.get("sourceId") ?? "";
  if ((type !== "movie" && type !== "tv") || !tmdbId || !sourceId) {
    return NextResponse.json({ error: "Missing type, id or sourceId" }, { status: 400 });
  }
  const optionalInt = (name: string) => {
    const value = Number(params.get(name));
    return params.get(name) && Number.isFinite(value) ? value : undefined;
  };
  const title: RuntimeQuestion = { mediaType: type, tmdbId, season: optionalInt("season"), episode: optionalInt("episode") };
  const prewarm = params.get("prewarm") === "1";
  const url = await resolveRemuxSourceUrl({ ...title, userId, sourceId, ticket: params.get("ticket") });
  if (!url) {
    recordVodOpen(vodOpenOutcome({ status: 409 }), prewarm);
    return NextResponse.json({ error: "Source expired" }, { status: 409 });
  }
  // An answer given before the file was found out still offers it.
  if (isRefusedLink(url)) {
    recordVodOpen(vodOpenOutcome({ status: 415 }), prewarm);
    return NextResponse.json({ error: "Source does not play" }, { status: 415 });
  }

  const worker = new URLSearchParams({ u: url, startAt: String(Math.max(0, optionalInt("startAt") ?? 0)) });
  worker.set("w", watcherOf(userId));
  // The link changes with every answer; the source does not, so a prewarm and Play meet in one session.
  worker.set("k", sourceId);
  const pref = params.get("audioPreference");
  worker.set("audioPreference", pref === "english" || pref === "preferred" ? pref : "original");
  for (const name of ["originalLanguage", "audioLanguage"]) {
    const value = (params.get(name) ?? "").toLowerCase();
    if (LANGUAGE.test(value)) worker.set(name, value);
  }
  const audioIndex = optionalInt("audioIndex");
  if (audioIndex !== undefined && Number.isInteger(audioIndex) && audioIndex >= 0) worker.set("audioIndex", String(audioIndex));
  // The viewer's browser said it decodes Dolby Vision.
  if (params.get("dolbyVision") === "1") worker.set("dolbyVision", "1");
  // The surround audio the viewer can take (see audioCapsParam).
  const audioCaps = params.get("audioCaps") ?? "";
  if (AUDIO_CAPS.test(audioCaps)) worker.set("audioCaps", audioCaps);
  // Asked for ahead of Play: made ready, but never at a viewer's expense.
  if (params.get("prewarm") === "1") worker.set("prewarm", "1");
  // The file's size, when the source said it: the remuxer plans its first reads from it.
  const size = params.get("size") ?? "";
  if (/^[1-9]\d{0,14}$/.test(size)) worker.set("size", size);

  const asked = Date.now();
  /** How long the open took and how it ended: the largest part of a start that is not the search. */
  const opened = (outcome: string, answer: VodOpenAnswer, session?: string) => {
    recordEvent("web", "vod_open", { userId, ...title, sourceId, prewarm: worker.has("prewarm"), startAt: Number(worker.get("startAt")), tookMs: Date.now() - asked, outcome, session });
    recordVodOpen(vodOpenOutcome(answer), prewarm, (Date.now() - asked) / 1000);
  };
  const res = await fetch(`${REMUXER_URL}/vod/open?${worker}`, { signal: AbortSignal.timeout(OPEN_TIMEOUT_MS) }).catch(
    () => null
  );
  if (!res) {
    opened("remuxer unavailable", { status: null });
    return NextResponse.json({ error: "Remuxer unavailable" }, { status: 502 });
  }
  const body = (await res.json().catch(() => ({}))) as {
    id?: string;
    durationS?: number;
    bitrateBps?: number | null;
    maxKeyframeGapS?: number | null;
    seekPoints?: number[];
    dynamicRange?: string;
    audio?: unknown;
    audioIndex?: number | null;
    audioTracks?: unknown[];
    subtitles?: unknown[];
    error?: string;
  };
  if (!res.ok || !body.id) {
    // Found out since it was last opened (by a prewarm, or a player that had stopped waiting).
    if (res.headers.has(UNUSABLE_HEADER)) await refuseSource(sourceId, title);
    opened(body.error ?? `remuxer ${res.status}`, { status: res.status, unusable: res.headers.has(UNUSABLE_HEADER) });
    return NextResponse.json({ error: body.error ?? `remuxer ${res.status}` }, { status: res.status === 415 ? 415 : 502 });
  }
  if (await isAnotherLength(title, sourceId, body.durationS)) {
    opened("another length", { status: 415, opened: true });
    return NextResponse.json({ error: "Not the length of the title asked for" }, { status: 415 });
  }
  opened("ok", { status: 200, opened: true }, body.id);
  rememberRemuxSession(body.id, { sourceId, title });
  return NextResponse.json(
    {
      playlistUrl: `/api/vod/${body.id}/index.m3u8`,
      // The same stream in short slices, for players built on Media Source
      // Extensions, with the times a jump into it may land on.
      slicedPlaylistUrl: `/api/vod/${body.id}/slices.m3u8`,
      seekPoints: body.seekPoints ?? [],
      durationS: body.durationS,
      // The file's average bitrate: the player sizes its buffer's seconds from it.
      bitrateBps: body.bitrateBps ?? null,
      // Its longest keyframe gap: the player keeps at least that much behind the playhead.
      maxKeyframeGapS: body.maxKeyframeGapS ?? null,
      dynamicRange: body.dynamicRange ?? "SDR",
      audio: body.audio ?? null,
      audioIndex: body.audioIndex ?? null,
      audioTracks: body.audioTracks ?? [],
      subtitles: body.subtitles ?? [],
      subtitleBase: `/api/vod/${body.id}/`,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
