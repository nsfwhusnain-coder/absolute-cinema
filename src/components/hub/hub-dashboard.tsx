"use client";

/**
 * The live dashboard (/hub, docs/HUB.md): who is watching what right now, at
 * what quality, how it plays and what it costs the server; the machine's load
 * and the capacity governor's state; the last hour; the latest moments.
 * Asks the server every two seconds while the page is in view.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { HubPoint, HubSnapshot, HubViewer } from "@/lib/hub/live-snapshot";
import { ago, audioWords, clock, deliveryWords, gigabytes, mbps, percent, rangeWords, span } from "@/lib/hub/format";
import { ChartLegend, HubChart } from "./hub-chart";

const POLL_MS = 2_000;
const POSTER = "https://image.tmdb.org/t/p/w154";

type Range = 15 | 60;

function useSnapshot(key: string | null) {
  const [snapshot, setSnapshot] = useState<HubSnapshot | null>(null);
  const [error, setError] = useState<{ status: number; message: string } | null>(null);
  const [fetchedAt, setFetchedAt] = useState(0);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      if (stopped) return;
      if (document.visibilityState === "visible") {
        try {
          const res = await fetch(`/api/hub/live${key ? `?key=${encodeURIComponent(key)}` : ""}`, { cache: "no-store" });
          if (res.ok) {
            setSnapshot((await res.json()) as HubSnapshot);
            setError(null);
            setFetchedAt(Date.now());
          } else {
            const body = (await res.json().catch(() => ({}))) as { error?: string };
            setError({ status: res.status, message: body.error ?? `The server answered ${res.status}` });
          }
        } catch {
          setError({ status: 0, message: "The server cannot be reached" });
        }
      }
      if (!stopped) timer = setTimeout(load, POLL_MS);
    };
    void load();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [key]);
  return { snapshot, error, fetchedAt };
}

/** Re-renders every second, so "12 s ago" stays true between answers. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

const LEVEL = {
  ok: { text: "Healthy", detail: "letting viewers in", tone: "bg-emerald-500/15 text-emerald-300 ring-emerald-400/30", dot: "bg-emerald-400" },
  busy: { text: "At capacity", detail: "new viewers wait in the queue", tone: "bg-amber-500/15 text-amber-300 ring-amber-400/30", dot: "bg-amber-400" },
  critical: { text: "Protecting the server", detail: "stopping streams one at a time", tone: "bg-red-500/15 text-red-300 ring-red-400/30", dot: "bg-red-400" },
} as const;

const REASON_WORDS: Record<string, string> = {
  temperature: "CPU temperature",
  cpu: "CPU",
  memory: "memory",
  network: "internet link",
  playback: "viewers buffering",
  seats: "seats",
  starts: "starts spaced",
};

function Card({ title, aside, children, className = "" }: { title?: string; aside?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-2xl border border-white/10 bg-white/[0.04] p-4 backdrop-blur ${className}`}>
      {(title || aside) && (
        <div className="mb-3 flex items-center justify-between gap-3">
          {title && <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-white/50">{title}</h2>}
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}

function Bar({ value, warn = 0.8, bad = 0.95 }: { value: number; warn?: number; bad?: number }) {
  const width = Math.max(0, Math.min(1, value));
  const color = value >= bad ? "bg-red-400" : value >= warn ? "bg-amber-400" : "bg-emerald-400";
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
      <div className={`h-full rounded-full ${color} transition-[width] duration-700`} style={{ width: `${width * 100}%` }} />
    </div>
  );
}

function Stat({ label, value, sub, bar, tone }: { label: string; value: string; sub?: React.ReactNode; bar?: number; tone?: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
      <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-white/45">{label}</div>
      <div className={`mt-1 font-display text-2xl font-semibold tabular-nums ${tone ?? "text-white"}`}>{value}</div>
      {bar !== undefined && (
        <div className="mt-2">
          <Bar value={bar} />
        </div>
      )}
      {sub && <div className="mt-1.5 text-xs text-white/50">{sub}</div>}
    </div>
  );
}

function Badge({ children, tone = "bg-white/10 text-white/80" }: { children: React.ReactNode; tone?: string }) {
  return <span className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${tone}`}>{children}</span>;
}

const STATE = {
  playing: { text: "Playing", tone: "bg-emerald-500/15 text-emerald-300" },
  paused: { text: "Paused", tone: "bg-white/10 text-white/70" },
  buffering: { text: "Buffering", tone: "bg-amber-500/15 text-amber-300" },
  starting: { text: "Starting", tone: "bg-sky-500/15 text-sky-300" },
} as const;

function qualityTone(label: string): string {
  if (label === "4K") return "bg-fuchsia-500/20 text-fuchsia-200";
  if (label === "1080p" || label === "1440p") return "bg-sky-500/20 text-sky-200";
  if (label === "720p" || label === "SD") return "bg-amber-500/20 text-amber-200";
  return "bg-white/10 text-white/60";
}

function ViewerCard({ viewer, open, onToggle }: { viewer: HubViewer; open: boolean; onToggle: () => void }) {
  const state = STATE[viewer.state];
  const range = rangeWords(viewer.server?.dynamicRange);
  const progress = viewer.positionS !== null && viewer.durationS ? Math.min(1, viewer.positionS / viewer.durationS) : null;
  const titleText = viewer.title ? viewer.title.name : (viewer.label ?? "Unknown stream");
  const episode = viewer.title?.season ? `S${viewer.title.season} E${viewer.title.episode}` : null;
  return (
    <article className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.04]">
      <button type="button" onClick={onToggle} className="flex w-full gap-3 p-3 text-left hover:bg-white/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40">
        <div className="relative h-[84px] w-14 shrink-0 overflow-hidden rounded-lg bg-white/10">
          {viewer.title?.poster ? (
            <img src={`${POSTER}${viewer.title.poster}`} alt="" className="h-full w-full object-cover" loading="lazy" />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-[10px] text-white/40">{viewer.person.simulated ? "TEST" : "—"}</div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="truncate font-semibold text-white">
                {titleText}
                {viewer.title?.year && <span className="font-normal text-white/45"> ({viewer.title.year})</span>}
                {episode && <span className="font-normal text-white/60"> · {episode}</span>}
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-white/60">
                <span className="inline-flex items-center gap-1">
                  <span className="h-2 w-2 rounded-full" style={{ background: viewer.person.color ?? "#64748b" }} />
                  {viewer.person.name}
                </span>
                {viewer.person.owner && <Badge tone="bg-yellow-500/20 text-yellow-200">Owner</Badge>}
                {viewer.person.simulated && <Badge tone="bg-indigo-500/25 text-indigo-200">Simulated</Badge>}
                {viewer.device && <span className="text-white/40">· {viewer.device === "tv" ? "TV" : "computer"}</span>}
              </div>
            </div>
            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${state.tone}`}>{state.text}</span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Badge tone={qualityTone(viewer.quality.label)}>{viewer.quality.label}</Badge>
            {range && <Badge tone="bg-violet-500/20 text-violet-200">{range}</Badge>}
            <span className="text-xs text-white/55">
              {[viewer.provider, deliveryWords(viewer.delivery)].filter(Boolean).join(" · ")}
              {viewer.quality.bitrateBps ? ` · ${mbps(viewer.quality.bitrateBps)}` : ""}
            </span>
          </div>
          {progress !== null && (
            <div className="mt-2 flex items-center gap-2 text-[11px] tabular-nums text-white/45">
              <span>{clock(viewer.positionS)}</span>
              <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/10">
                <div className="h-full rounded-full bg-white/60" style={{ width: `${progress * 100}%` }} />
              </div>
              <span>{clock(viewer.durationS)}</span>
            </div>
          )}
          <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] text-white/55 sm:grid-cols-4">
            <span>
              Buffer <b className="font-semibold text-white/80">{viewer.bufferAheadS !== null ? `${Math.round(viewer.bufferAheadS)} s` : "—"}</b>
            </span>
            <span>
              Stalls <b className={`font-semibold ${viewer.stalls ? "text-amber-300" : "text-white/80"}`}>{viewer.stalls}</b>
            </span>
            <span>
              Server CPU <b className="font-semibold text-white/80">{viewer.server ? percent(viewer.server.cpuCores) : "—"}</b>
            </span>
            <span>
              Capacity <b className="font-semibold text-white/80">{viewer.seat ? percent(viewer.seat.share, 1) : "—"}</b>
            </span>
          </div>
        </div>
      </button>
      {open && (
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 border-t border-white/10 bg-black/20 px-4 py-3 text-xs text-white/60 sm:grid-cols-3">
          <Detail label="Watching for" value={span(viewer.watchingS)} />
          <Detail label="Picture" value={viewer.quality.width && viewer.quality.height ? `${viewer.quality.width}×${viewer.quality.height}` : viewer.quality.label} />
          <Detail label="Player's bandwidth" value={mbps(viewer.bandwidthBps)} />
          <Detail label="Time stalled" value={`${viewer.stalledS} s`} />
          <Detail label="Player" value={viewer.engine ?? "—"} />
          <Detail label="Seat" value={viewer.seat ? `${viewer.seat.class}, ${viewer.seat.cpuCores.toFixed(2)} cores planned${viewer.seat.owner ? ", owner" : ""}` : "none"} />
          {viewer.server && (
            <>
              <Detail label="Sent to the viewer" value={mbps(viewer.server.servedBps)} />
              <Detail label="Read from the CDN" value={`${mbps(viewer.server.upstreamBps)} (${viewer.server.cdn})`} />
              <Detail label="Remux runs" value={`${viewer.server.runs}${viewer.server.pausedRuns ? ` (${viewer.server.pausedRuns} resting)` : ""}`} />
              <Detail label="Made ahead of the viewer" value={`${Math.round(viewer.server.aheadS)} s`} />
              <Detail label="File" value={`${viewer.server.videoCodec?.replace(/^V_MPEG(4\/ISO\/)?/, "") ?? "—"} · ${mbps(viewer.server.fileBitrateBps)}`} />
              <Detail label="Sound" value={audioWords(viewer.server.audio)} />
            </>
          )}
        </div>
      )}
    </article>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wider text-white/35">{label}</div>
      <div className="truncate text-white/80">{value}</div>
    </div>
  );
}

function series(history: HubPoint[], range: Range, now: number) {
  const points = history.filter((p) => now - p.at <= range * 60_000);
  return {
    times: points.map((p) => p.at),
    seats: points.map((p) => p.seats),
    viewers: points.map((p) => p.viewers),
    queue: points.map((p) => p.queue),
    cpu: points.map((p) => p.cpuCores),
    temp: points.map((p) => p.temperatureC),
    rx: points.map((p) => p.rxBps / 1e6),
    tx: points.map((p) => p.txBps / 1e6),
    memory: points.map((p) => p.memoryBytes / 1024 ** 3),
    limit: points.at(-1)?.cpuLimitCores ?? 0,
  };
}

export function HubDashboard() {
  const key = useMemo(() => (typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("key")), []);
  const { snapshot, error, fetchedAt } = useSnapshot(key);
  const now = useNow();
  const [range, setRange] = useState<Range>(15);
  const [open, setOpen] = useState<string | null>(null);
  const [hideSimulated, setHideSimulated] = useState(false);
  const first = useRef(true);
  useEffect(() => {
    if (snapshot && first.current) {
      first.current = false;
      document.title = `Live · ${snapshot.label ?? "Absolute Cinema"}`;
    }
  }, [snapshot]);

  if (!snapshot) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-[#07070a] p-6 text-white">
        <div className="max-w-md text-center">
          <h1 className="font-display text-xl font-semibold">Absolute Cinema · Live</h1>
          <p className="mt-2 text-sm text-white/60">
            {error ? (error.status === 401 || error.status === 403 ? `${error.message}.` : error.message) : "Connecting…"}
          </p>
          {error && (error.status === 401 || error.status === 403) && (
            <p className="mt-4 text-xs text-white/40">Open it from a browser signed in to an owner profile, or with the dashboard's link that carries its key.</p>
          )}
        </div>
      </main>
    );
  }

  const level = LEVEL[snapshot.gate.level];
  const m = snapshot.machine;
  const s = series(snapshot.history, range, now);
  const viewers = snapshot.viewers
    .filter((v) => !hideSimulated || !v.person.simulated)
    .sort((a, b) => Number(b.person.owner) - Number(a.person.owner) || Number(a.person.simulated) - Number(b.person.simulated) || b.watchingS - a.watchingS);
  const fullest = Object.entries(snapshot.budgets).sort((a, b) => b[1] - a[1])[0];
  const tempTone = m.temperatureC === null ? undefined : m.temperatureC >= 92 ? "text-red-300" : m.temperatureC >= 85 ? "text-amber-300" : undefined;
  const stale = fetchedAt && now - fetchedAt > 10_000;
  const quality = Object.entries(snapshot.totals.byQuality)
    .filter(([label]) => label !== "—")
    .sort((a, b) => b[1] - a[1])
    .map(([label, count]) => `${count} × ${label}`)
    .join(" · ");

  return (
    <main className="min-h-dvh bg-[#07070a] bg-[radial-gradient(ellipse_at_top,rgba(120,60,200,0.12),transparent_60%)] px-4 pb-10 pt-[max(1rem,env(safe-area-inset-top))] text-white sm:px-6">
      <div className="mx-auto max-w-[1600px] space-y-4">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="relative flex h-2.5 w-2.5">
              <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${stale ? "bg-white/30" : "bg-red-500"}`} />
              <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${stale ? "bg-white/40" : "bg-red-500"}`} />
            </span>
            <h1 className="font-display text-lg font-semibold tracking-wide sm:text-xl">Absolute Cinema · Live</h1>
            {snapshot.label && <Badge tone="bg-white/10 text-white/70">{snapshot.label}</Badge>}
            {snapshot.version && <span className="text-xs text-white/35">v{snapshot.version}</span>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold ring-1 ${level.tone}`}>
              <span className={`h-2 w-2 rounded-full ${level.dot}`} />
              {level.text}
              <span className="font-normal opacity-75">· {snapshot.gate.enabled ? level.detail : "capacity gate off"}</span>
            </span>
            {snapshot.gate.reasons.length > 0 && (
              <span className="text-xs text-white/50">because of {snapshot.gate.reasons.map((r) => REASON_WORDS[r] ?? r).join(", ")}</span>
            )}
            <span className={`text-xs ${stale ? "text-amber-300" : "text-white/35"}`}>{stale ? "not updating" : `updated ${ago(fetchedAt, now)}`}</span>
          </div>
        </header>

        {!snapshot.remuxer && (
          <div className="rounded-xl border border-amber-400/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-200">
            The remuxer is not answering: streams, the server's load and the queue cannot be shown.
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
          <Stat
            label="Watching now"
            value={String(snapshot.totals.watching)}
            sub={
              <>
                {snapshot.totals.playing} playing · {snapshot.totals.paused} paused
                {snapshot.totals.buffering ? ` · ${snapshot.totals.buffering} loading` : ""}
                {snapshot.totals.simulated ? <span className="text-indigo-300"> · {snapshot.totals.simulated} simulated</span> : null}
              </>
            }
          />
          <Stat
            label="Queue"
            value={String(snapshot.totals.queue)}
            tone={snapshot.totals.queue ? "text-amber-300" : undefined}
            sub={snapshot.queue.length ? `longest wait ${span(Math.max(...snapshot.queue.map((q) => q.waitedS)))}` : "nobody waiting"}
          />
          <Stat
            label="CPU"
            value={`${m.cpuCores.toFixed(1)} / ${m.cpuLimitCores || "—"}`}
            bar={m.cpuLimitCores ? m.cpuCores / m.cpuLimitCores : 0}
            sub={`cores · remuxer's main thread ${percent(m.remuxerCores)} · loop ${Math.round(m.loopLagMs)} ms (longest ${Math.round(m.loopFreezeMs)} ms)`}
          />
          <Stat label="CPU temperature" value={m.temperatureC === null ? "—" : `${Math.round(m.temperatureC)}°C`} tone={tempTone} sub="busy at 85 · critical at 92" />
          <Stat label="Memory" value={gigabytes(m.memoryBytes)} bar={m.memoryLimitBytes ? m.memoryBytes / m.memoryLimitBytes : 0} sub={`of ${gigabytes(m.memoryLimitBytes)} (page cache not counted)`} />
          <Stat label="Download" value={mbps(m.downBps)} sub={`from CDNs · ${mbps(snapshot.totals.upstreamBps)} for streams`} />
          <Stat label="Upload" value={mbps(m.upBps)} sub={`to viewers · ${mbps(snapshot.totals.servedBps)} of video`} />
          <Stat
            label="Capacity used"
            value={fullest ? percent(fullest[1]) : "—"}
            bar={fullest ? fullest[1] : 0}
            sub={
              fullest
                ? `fullest budget: ${{ downlink: "download", uplink: "upload", remuxer: "remuxer thread", cpu: "CPU", memory: "memory" }[fullest[0]] ?? fullest[0]}`
                : undefined
            }
          />
        </div>

        <div className="grid gap-3 lg:grid-cols-3">
          <Card
            title="Viewers and queue"
            aside={
              <div className="flex gap-1 text-xs">
                {([15, 60] as const).map((r) => (
                  <button key={r} type="button" onClick={() => setRange(r)} className={`rounded-md px-2 py-0.5 ${range === r ? "bg-white/15 text-white" : "text-white/50 hover:text-white"}`}>
                    {r === 15 ? "15 min" : "1 h"}
                  </button>
                ))}
              </div>
            }
          >
            <HubChart
              times={s.times}
              series={[
                { name: "Streams (seats)", color: "#a78bfa", values: s.seats, area: true },
                { name: "Remux viewers", color: "#38bdf8", values: s.viewers },
                { name: "Queue", color: "#fbbf24", values: s.queue },
              ]}
              leftFloor={4}
            />
            <ChartLegend series={[{ name: "Streams (seats)", color: "#a78bfa" }, { name: "Remux viewers", color: "#38bdf8" }, { name: "Queue", color: "#fbbf24" }]} />
          </Card>
          <Card title="CPU and temperature">
            <HubChart
              times={s.times}
              series={[
                { name: "CPU cores", color: "#34d399", values: s.cpu, area: true },
                { name: "Temperature °C", color: "#f87171", values: s.temp, right: true },
              ]}
              leftMax={s.limit || undefined}
              rightMax={105}
              limit={s.limit ? { value: s.limit, label: `quota ${s.limit} cores` } : undefined}
              bands={[
                { from: 85, to: 92, color: "rgba(251,191,36,0.08)", right: true },
                { from: 92, to: 105, color: "rgba(248,113,113,0.10)", right: true },
              ]}
              leftFormat={(v) => v.toFixed(v < 10 ? 1 : 0)}
              rightFormat={(v) => `${Math.round(v)}°`}
            />
            <ChartLegend series={[{ name: "CPU cores", color: "#34d399" }, { name: "Temperature (busy 85°, critical 92°)", color: "#f87171" }]} />
          </Card>
          <Card title="Network">
            <HubChart
              times={s.times}
              series={[
                { name: "Download", color: "#60a5fa", values: s.rx, area: true },
                { name: "Upload", color: "#f472b6", values: s.tx },
              ]}
              leftFloor={10}
              leftFormat={(v) => `${Math.round(v)}`}
            />
            <ChartLegend series={[{ name: "Download Mbit/s (from CDNs)", color: "#60a5fa" }, { name: "Upload Mbit/s (to viewers)", color: "#f472b6" }]} />
          </Card>
        </div>

        <Card
          title={`Now watching${quality ? ` · ${quality}` : ""}`}
          aside={
            <label className="flex cursor-pointer items-center gap-2 text-xs text-white/55">
              <input type="checkbox" checked={hideSimulated} onChange={(e) => setHideSimulated(e.target.checked)} className="accent-indigo-400" />
              Hide simulated
            </label>
          }
        >
          {viewers.length === 0 ? (
            <p className="py-6 text-center text-sm text-white/45">Nobody is watching right now.</p>
          ) : (
            <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
              {viewers.map((viewer) => (
                <ViewerCard key={viewer.key} viewer={viewer} open={open === viewer.key} onToggle={() => setOpen(open === viewer.key ? null : viewer.key)} />
              ))}
            </div>
          )}
        </Card>

        <div className="grid gap-3 lg:grid-cols-2">
          <Card title="Capacity">
            <div className="space-y-3">
              {(
                [
                  ["CPU", snapshot.budgets.cpu],
                  ["Remuxer's main thread (every remuxed byte passes through it)", snapshot.budgets.remuxer],
                  ["Memory", snapshot.budgets.memory],
                  ["Download", snapshot.budgets.downlink],
                  ["Upload (viewers outside the home)", snapshot.budgets.uplink],
                ] as const
              ).map(([label, use]) => (
                <div key={label}>
                  <div className="mb-1 flex justify-between text-xs text-white/60">
                    <span>{label}</span>
                    <span className="tabular-nums">{percent(use)}</span>
                  </div>
                  <Bar value={use} />
                </div>
              ))}
              <p className="text-xs text-white/40">
                Planned use of each budget: what the seats held are expected to take, or what is measured when that is more. A new viewer is let in only while their stream fits under
                100%.
              </p>
              {snapshot.queue.length > 0 && (
                <div>
                  <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-white/45">In the queue</div>
                  <ol className="space-y-1 text-sm">
                    {snapshot.queue.map((q) => (
                      <li key={q.position} className="flex justify-between text-white/75">
                        <span>
                          #{q.position} {q.name}
                          {q.owner && <span className="text-yellow-200"> · owner</span>} · {q.class}
                        </span>
                        <span className="tabular-nums text-white/45">{span(q.waitedS)}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </div>
          </Card>
          <Card title="Activity">
            {snapshot.events.length === 0 ? (
              <p className="py-6 text-center text-sm text-white/45">Nothing has happened yet.</p>
            ) : (
              <ol className="max-h-80 space-y-1.5 overflow-y-auto pr-1 text-sm">
                {snapshot.events.map((e, i) => (
                  <li key={`${e.at}-${i}`} className="flex gap-3">
                    <span className="w-16 shrink-0 text-right text-xs tabular-nums text-white/35">{ago(e.at, now)}</span>
                    <span
                      className={
                        e.tone === "bad" ? "text-red-300" : e.tone === "warn" ? "text-amber-200" : e.tone === "good" ? "text-emerald-200" : "text-white/75"
                      }
                    >
                      {e.text}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </div>
      </div>
    </main>
  );
}
