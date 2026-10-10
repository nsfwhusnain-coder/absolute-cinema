"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@/hooks/use-navigate";
import { tmdbImageUrl, pickTitleLogoUrl, backdropSrcSet, type TmdbImages } from "@/lib/tmdb";
import { Play, Plus, Star, Calendar, Heart, Pause } from "lucide-react";
import { PREFERENCES_QUERY_KEY, fetchPreferences } from "@/lib/preferences-client";
import { MovieCardData } from "@/components/movie-card";
import { EASE_OUT_EXPO, transitionHero } from "@/lib/motion";
import { COMMON_GENRES, COMMON_TV_GENRES } from "@/lib/tmdb";
import { useWatchlist, type WatchlistItem } from "@/hooks/use-watchlist";
import { useSession } from "next-auth/react";
import { useAmbientColor } from "@/hooks/use-ambient-color";
import { useIsTv } from "@/hooks/use-is-tv";
import { yearOf } from "@/lib/utils";
import { resumeTvEpisode } from "@/lib/continue-watching";

const CANVAS = "#0a0a0f";

/** Matches navbar.tsx's FOCUS_RING — floating controls over imagery, not a solid surface. */
const HERO_FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-transparent";

/** Layout height only — paint stack may bleed below this. */
const HERO_LAYOUT_HEIGHT = "clamp(680px, 92vh, 1040px)";
const IMAGE_BLEED_DESKTOP_PX = 200;
const IMAGE_BLEED_MOBILE_PX = 120;
const CONTENT_PAD_BOTTOM_PX = 108;
const DOTS_BOTTOM_PX = 120;
/** Full image alpha through upper hero; soft die through bleed zone. */
const IMAGE_MASK =
  "linear-gradient(to bottom, #000 0%, #000 40%, transparent 98%)";
/** Soft bottom darken only — never opaque tintTop/CANVAS (that was the hard bar). */
const BOTTOM_SCRIM =
  "linear-gradient(to top, rgba(0,0,0,0.52) 0%, rgba(0,0,0,0.22) 28%, transparent 55%)";
const LEFT_SCRIM =
  "linear-gradient(90deg, rgba(10,10,15,0.55) 0%, rgba(10,10,15,0.18) 32%, transparent 58%)";

interface FeaturedItem extends MovieCardData {
  overview: string;
  runtime?: number;
  number_of_seasons?: number;
  genre_ids?: number[];
}

function genreLabel(ids: number[] | undefined, mediaType: string): string | null {
  if (!ids?.length) return null;
  const list = mediaType === "tv" ? COMMON_TV_GENRES : COMMON_GENRES;
  return list.find((g) => g.id === ids[0])?.name ?? null;
}

interface Props {
  items: FeaturedItem[];
}

const SLIDE_INTERVAL_MS = 8000;

interface ProgressRow {
  tmdbId: number;
  mediaType: string;
  progress: number;
  season?: number | null;
  episode?: number | null;
  updatedAt?: string;
}


function HeroTitle({
  item,
  mediaType,
  onOpenInfo,
}: {
  item: FeaturedItem;
  mediaType: string;
  onOpenInfo: () => void;
}) {
  const { data } = useQuery({
    queryKey: ["tmdb", mediaType, "images", item.id],
    queryFn: async () => {
      const res = await fetch(`/api/tmdb/${mediaType}/${item.id}/images`);
      if (!res.ok) return null;
      return res.json() as Promise<TmdbImages>;
    },
    staleTime: 60 * 60 * 1000,
  });

  const logoUrl = pickTitleLogoUrl(data, "original");
  const title = item.title || item.name || "";
  const [logoReady, setLogoReady] = useState(false);
  const [logoFailed, setLogoFailed] = useState(false);

  useEffect(() => {
    setLogoReady(false);
    setLogoFailed(false);
  }, [logoUrl, item.id]);

  const showLogo = Boolean(logoUrl) && logoReady && !logoFailed;

  return (
    // A fixed-height slot for the title, text or logo alike: the logo arrives
    // after the slide does, and growing to fit it pushed the whole block up
    // (a layout shift on every slide), while tall logos could fill the banner.
    <button
      type="button"
      onClick={onOpenInfo}
      className={`flex h-[clamp(5.5rem,17vh,10rem)] max-w-full items-end text-left ${HERO_FOCUS_RING} rounded-md`}
    >
      <h1
        className={
          showLogo
            ? "sr-only"
            : "line-clamp-2 font-display text-[40px] font-extrabold leading-[1.05] tracking-tight text-white drop-shadow-lg md:text-[64px]"
        }
        style={showLogo ? undefined : { fontWeight: 800 }}
      >
        {title}
      </h1>
      {logoUrl && !logoFailed ? (
        <img
          src={logoUrl}
          alt=""
          aria-hidden
          className={
            showLogo
              ? "h-auto max-h-full w-auto object-contain object-left-bottom drop-shadow-lg"
              : "hidden"
          }
          style={{ maxWidth: "min(560px, 42vw)" }}
          ref={(el) => {
            if (el?.complete && el.naturalWidth > 0) {
              queueMicrotask(() => setLogoReady(true));
            }
          }}
          onLoad={() => setLogoReady(true)}
          onError={() => setLogoFailed(true)}
        />
      ) : null}
    </button>
  );
}

function GlassSegmentedActions({
  onAdd,
  inList,
}: {
  onAdd: () => void;
  inList: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onAdd}
      className={`inline-flex h-11 w-11 items-center justify-center rounded-full border border-white/40 text-white transition-colors hover:bg-white/10 ${HERO_FOCUS_RING}`}
      style={{
        background: "rgba(255,255,255,0.16)",
        WebkitBackdropFilter: "blur(12px) saturate(170%) brightness(1.2)",
        backdropFilter: "blur(12px) saturate(170%) brightness(1.2)",
        boxShadow:
          "inset 0 1px 1px rgba(255,255,255,0.5), 0 4px 14px rgba(0,0,0,0.4)",
      }}
      aria-label={inList ? "In watchlist" : "Add to list"}
    >
      {inList ? (
        <span className="text-sm font-semibold">✓</span>
      ) : (
        <Plus className="h-5 w-5" aria-hidden />
      )}
    </button>
  );
}

export function HeroCarousel({ items }: Props) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  /** The viewer pressed pause: stays paused until they press play. */
  const [stopped, setStopped] = useState(false);
  /** Slide changes are announced only when the viewer made them, never every 8 s. */
  const [announce, setAnnounce] = useState(false);
  const hoverSuppressed = useRef(false);
  const navigate = useNavigate();
  const { data: session } = useSession();
  const { isIn, add, remove } = useWatchlist();
  const reduceMotion = useReducedMotion();
  const isTv = useIsTv();
  const staticHero = Boolean(reduceMotion) || isTv;
  const { data: prefs } = useQuery({ queryKey: PREFERENCES_QUERY_KEY, queryFn: fetchPreferences, enabled: !!session?.user?.id, staleTime: 5 * 60_000 });
  // Rotation is off for reduced motion, for profiles that turned it off, and once paused by hand.
  const rotates = items.length > 1 && !reduceMotion && prefs?.heroAutoplay !== false && !stopped;
  const goTo = (i: number) => {
    setAnnounce(true);
    setIndex(i);
  };
  const { data: progressList } = useQuery({
    queryKey: ["progress"],
    queryFn: async () => {
      const res = await fetch("/api/progress");
      if (!res.ok) return [] as ProgressRow[];
      return res.json() as Promise<ProgressRow[]>;
    },
    enabled: !!session?.user?.id,
    staleTime: 60_000,
  });
  const [imageBleedPx, setImageBleedPx] = useState(() =>
    typeof window !== "undefined" &&
    !window.matchMedia("(min-width: 768px)").matches
      ? IMAGE_BLEED_MOBILE_PX
      : IMAGE_BLEED_DESKTOP_PX
  );
  const safeIndex = items.length > 0 ? index % items.length : 0;
  const ambientPath =
    items.length > 0
      ? items[safeIndex]?.backdrop_path ?? items[safeIndex]?.poster_path
      : null;
  // Still drives AmbientBackground (page wash under fully-masked image zone).
  useAmbientColor(ambientPath);

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const apply = () =>
      setImageBleedPx(mq.matches ? IMAGE_BLEED_DESKTOP_PX : IMAGE_BLEED_MOBILE_PX);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  useEffect(() => {
    if (!rotates || paused) return;
    const id = window.setTimeout(() => {
      setIndex((i) => (i + 1) % items.length);
    }, SLIDE_INTERVAL_MS);
    return () => window.clearTimeout(id);
  }, [index, items.length, paused, rotates]);

  if (items.length === 0) return null;
  const current = items[safeIndex];
  // Display image: NO crossOrigin — that was breaking the visible load (black void).
  // Color extraction uses a separate Image() with crossOrigin / API fallback.
  const bgResponsive =
    backdropSrcSet(current.backdrop_path) ?? backdropSrcSet(current.poster_path);
  const bg = bgResponsive?.src ?? null;
  const year =
    current.release_date || current.first_air_date
      ? yearOf(current.release_date || current.first_air_date)
      : null;
  const mediaType = current.media_type || "movie";
  const currentTitle = current.title || current.name || "";
  const primaryGenre = genreLabel(current.genre_ids, mediaType);
  const rating =
    current.vote_average && current.vote_average > 0
      ? (Math.round(current.vote_average * 10) / 10).toFixed(1)
      : null;

  const watchlistItem: WatchlistItem = {
    tmdbId: current.id,
    mediaType,
    title: currentTitle,
    poster: current.poster_path,
    backdrop: current.backdrop_path,
    voteAverage: current.vote_average,
    releaseDate: current.release_date || current.first_air_date,
  };
  const inList = session?.user?.id ? isIn(current.id, mediaType) : false;

  return (
    <div
      className="relative w-full"
      style={{
        height: HERO_LAYOUT_HEIGHT,
        backgroundColor: "transparent",
      }}
      onMouseEnter={() => {
        if (!hoverSuppressed.current) setPaused(true);
      }}
      onMouseLeave={(e) => {
        hoverSuppressed.current = false;
        // Keyboard focus inside the banner keeps it paused after the pointer leaves.
        if (!e.currentTarget.contains(document.activeElement)) setPaused(false);
      }}
      onFocus={(e) => {
        // Focus on the banner's own pause/play button is not a reason to hold the slide.
        if (!(e.target as HTMLElement).closest("[data-hero-pause]")) setPaused(true);
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setPaused(false);
      }}
    >
      <div aria-live={announce ? "polite" : "off"} className="sr-only">
        Now showing: {currentTitle}
      </div>

      {/*
        Paint stack: taller than layout, mask-fades into page ambient.
        overflow-hidden here clips Ken Burns; outer is visible so bleed paints under rails.
        pointer-events-none so Continue Watching cards remain clickable over bleed.
      */}
      <div
        aria-hidden
        className="pointer-events-none absolute left-0 right-0 top-0 z-0"
        style={{
          height: `calc(100% + ${imageBleedPx}px)`,
          overflow: "hidden",
          WebkitMaskImage: IMAGE_MASK,
          maskImage: IMAGE_MASK,
          WebkitMaskSize: "100% 100%",
          maskSize: "100% 100%",
          WebkitMaskRepeat: "no-repeat",
          maskRepeat: "no-repeat",
        }}
      >
        <AnimatePresence mode="sync">
          {bg ? (
            <motion.img
              key={current.id}
              src={bg}
              srcSet={bgResponsive?.srcSet}
              sizes={bgResponsive?.sizes}
              alt=""
              // LCP element — never lazy, hint the browser to fetch it first.
              fetchPriority="high"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{
                opacity: {
                  duration: staticHero ? 0.4 : 1.05,
                  ease: EASE_OUT_EXPO,
                },
              }}
              className="absolute inset-0 h-full w-full object-cover"
              style={{
                objectPosition: "center 18%",
              }}
            />
          ) : (
            <div className="absolute inset-0" style={{ backgroundColor: CANVAS }} />
          )}
        </AnimatePresence>

        {/* Soft scrims inside mask — dissolve with image; never opaque color wall */}
        <div className="absolute inset-0" style={{ background: BOTTOM_SCRIM }} />
        <div className="absolute inset-0" style={{ background: LEFT_SCRIM }} />
      </div>

      {/* Content — layout box only (not masked); pb keeps Play clear of first rail.
          The box spans the whole banner (content sits at its bottom) so its own
          rectangle never changes: sized to each slide's content, it grew and
          shrank with every logo and synopsis, and each rotation registered as
          a layout shift (up to 0.17 per slide, measured). */}
      <div
        data-tv-safe
        className="pointer-events-none absolute inset-0 z-[2] flex flex-col justify-end pl-14 pr-6"
        style={{ paddingBottom: CONTENT_PAD_BOTTOM_PX }}
      >
        <AnimatePresence mode="wait">
          <motion.div
            key={current.id}
            className="pointer-events-auto max-w-[620px]"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={transitionHero}
          >
            <HeroTitle
              item={current}
              mediaType={mediaType}
              onOpenInfo={() => navigate(`/${mediaType}/${current.id}`)}
            />

            <div
              className="hero-meta mt-5 flex flex-wrap items-center gap-x-3 gap-y-1"
              style={{ fontSize: 16, color: "rgba(255,255,255,0.9)" }}
            >
              {rating ? (
                <span className="inline-flex items-center gap-1.5">
                  <Star
                    className="h-3.5 w-3.5"
                    style={{ color: "rgba(255,255,255,0.85)" }}
                    strokeWidth={1.75}
                    fill="none"
                    aria-hidden
                  />
                  {rating}/10
                </span>
              ) : null}
              {year ? (
                <span className="inline-flex items-center gap-1.5">
                  <Calendar
                    className="h-3.5 w-3.5"
                    style={{ color: "rgba(255,255,255,0.85)" }}
                    strokeWidth={1.75}
                    aria-hidden
                  />
                  {year}
                </span>
              ) : null}
              {primaryGenre ? (
                <span className="inline-flex items-center gap-1.5">
                  <Heart
                    className="h-3.5 w-3.5"
                    style={{ color: "rgba(255,255,255,0.85)" }}
                    strokeWidth={1.75}
                    aria-hidden
                  />
                  {primaryGenre}
                </span>
              ) : null}
            </div>

            <p
              className="mt-4"
              style={{
                fontSize: 18,
                lineHeight: 1.6,
                color: "rgba(255,255,255,0.92)",
                textShadow: "0 1px 8px rgba(0,0,0,0.5)",
                display: "-webkit-box",
                WebkitLineClamp: 3,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }}
            >
              {current.overview}
            </p>

            <div className="mt-7 flex flex-wrap items-center gap-3">
              <button
                type="button"
                data-tv-first-focus
                onClick={() => {
                  if (mediaType === "tv") {
                    const resume = resumeTvEpisode(progressList, current.id);
                    const s = resume?.season ?? 1;
                    const e = resume?.episode ?? 1;
                    navigate(`/watch/tv/${current.id}?season=${s}&episode=${e}`);
                  } else {
                    navigate(`/watch/movie/${current.id}`);
                  }
                }}
                className={`inline-flex h-11 items-center gap-2 rounded-full border-0 bg-white px-6 text-[0.9rem] font-semibold uppercase tracking-wide text-black shadow-lg transition-colors hover:bg-white/90 active:scale-[0.98] ${HERO_FOCUS_RING}`}
              >
                <Play className="h-4 w-4 fill-current" aria-hidden />
                Play
              </button>

              <GlassSegmentedActions
                inList={inList}
                onAdd={() => {
                  if (!session?.user?.id) {
                    navigate(`/${mediaType}/${current.id}`);
                    return;
                  }
                  if (inList) {
                    remove.mutate({ tmdbId: current.id, mediaType });
                  } else {
                    add.mutate(watchlistItem);
                  }
                }}
              />
            </div>
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Dots — horizontal, lower-right of banner; stay in layout box */}
      {items.length > 1 ? (
        <div
          data-tv-safe
          className="absolute right-4 z-[2] flex items-center gap-1.5 sm:right-10"
          style={{ bottom: DOTS_BOTTOM_PX }}
        >
          {items.map((_, i) => (
            <button
              key={i}
              type="button"
              onClick={() => goTo(i)}
              className={`flex h-6 items-center justify-center rounded-full px-0.5 ${HERO_FOCUS_RING}`}
              aria-label={`Go to slide ${i + 1}`}
              aria-current={i === index ? "true" : undefined}
            >
              <span
                className="relative block overflow-hidden rounded-full"
                style={{
                  height: 6,
                  width: i === index ? 28 : 6,
                  background: "rgba(255,255,255,0.32)",
                  transition: "width 280ms cubic-bezier(0.16, 1, 0.3, 1)",
                }}
              >
                {i === index ? (
                  <span
                    key={`${current.id}-${index}`}
                    className="absolute inset-y-0 left-0 rounded-full bg-white"
                    style={{
                      width: "100%",
                      transformOrigin: "left center",
                      animation: rotates ? `hero-slide-fill ${SLIDE_INTERVAL_MS}ms linear forwards` : "none",
                      animationPlayState: paused ? "paused" : "running",
                    }}
                  />
                ) : null}
              </span>
            </button>
          ))}
          {(rotates || stopped) && !reduceMotion && prefs?.heroAutoplay !== false ? (
            <button
              type="button"
              data-hero-pause
              onClick={() => {
                setStopped((v) => !v);
                setPaused(false);
                // Pressing play with the pointer still on the banner must play it:
                // the icon swap under the pointer re-fires "mouse enter", which
                // would pause it again at once. Hover pausing resumes after the
                // pointer leaves.
                hoverSuppressed.current = true;
              }}
              aria-label={stopped ? "Play the banner" : "Pause the banner"}
              title={stopped ? "Play the banner" : "Pause the banner"}
              className={`ml-1 flex h-6 w-6 items-center justify-center rounded-full text-white/70 transition hover:text-white ${HERO_FOCUS_RING}`}
            >
              {stopped ? <Play className="h-3 w-3 fill-current" /> : <Pause className="h-3 w-3 fill-current" />}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
