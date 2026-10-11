/**
 * How well the service has been finding and playing things, from the durable
 * event log (db/events, see src/lib/event-log.ts).
 *
 *   bun scripts/playback-report.ts            the last 7 days
 *   bun scripts/playback-report.ts --days 1   the last day
 *   bun scripts/playback-report.ts --json     the same numbers as JSON
 *   bun scripts/playback-report.ts --dir ./db/events
 *
 * In Docker: docker exec absolute-cinema bun scripts/playback-report.ts
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { eventLogDir } from "../src/lib/event-log";
import { buildPlaybackReport, parseEventLines, type Counted, type EventRow, type PlaybackReport, type Quantiles } from "../src/lib/playback-report";

const DAY_MS = 86_400_000;
const DEFAULT_DAYS = 7;

function option(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

function readRows(dir: string, from: number): EventRow[] {
  if (!existsSync(dir)) return [];
  const firstDay = new Date(from).toISOString().slice(0, 10);
  const files = readdirSync(dir).filter((name) => /^(web|remux|scraper)-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) && name.slice(-16, -6) >= firstDay);
  return files.flatMap((name) => parseEventLines(readFileSync(join(dir, name), "utf8")));
}

const seconds = (q: Quantiles) => (q.n ? `${(q.p50 / 1000).toFixed(1)} s typical, ${(q.p90 / 1000).toFixed(1)} s at worst tenth (${q.n})` : "none");
const counted = (c: Counted) => Object.entries(c).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ") || "none";
const each = (title: string, by: Record<string, Quantiles>) => Object.entries(by).map(([k, q]) => `    ${k}: ${seconds(q)}`).join("\n") || `    no ${title}`;

function render(r: PlaybackReport): string {
  const share = (n: number) => (r.titles.asked ? ` (${Math.round((n * 100) / r.titles.asked)}%)` : "");
  return [
    `Playback from ${new Date(r.from).toISOString().slice(0, 16)} to ${new Date(r.to).toISOString().slice(0, 16)} UTC`,
    "",
    `FINDING  titles asked for: ${r.titles.asked}`,
    `  with a 4K file: ${r.titles.with4k}${share(r.titles.with4k)}   debrid 1080p at best: ${r.titles.withDebrid1080}${share(r.titles.withDebrid1080)}   web streams only: ${r.titles.webOnly}${share(r.titles.webOnly)}   nothing: ${r.titles.nothing}${share(r.titles.nothing)}`,
    `  first answer of a fresh search: ${seconds(r.titles.firstAnswerMs)}`,
    `  debrid search: ${seconds(r.search.totalMs)}; first 1080p ${seconds(r.search.first1080Ms)}; first 4K ${seconds(r.search.first2160Ms)}`,
    `  turned away: ${r.rejected.otherTitle} batches of another title, ${r.rejected.otherLength} files of another length, ${r.rejected.unusableLinks} dead or placeholder links`,
    `  web providers: ${Object.entries(r.webProviders).map(([k, v]) => `${k} ${v.found}/${v.asked} in ${(v.medianMs / 1000).toFixed(1)} s`).join(", ") || "none"}`,
    "",
    `STARTING  starts: ${r.starts.total}   failed starts: ${r.failures.failedStarts} (${r.failures.failedStartsPerHundred} per hundred tries)`,
    `  viewer's wait, opening a title to first picture: ${seconds(r.starts.waitMs)}`,
    each("waits", r.starts.waitMsByDevice),
    `  file chosen to first picture: ${seconds(r.starts.startMs)}`,
    each("starts", r.starts.startMsByProvider),
    `  opening a file to remux: ${r.opens.ok} of ${r.opens.total} opened, ${seconds(r.opens.okMs)}; ${counted(r.opens.byOutcome)}`,
    `  failed starts by reason: ${counted(r.failures.byReason)}`,
    `  failed starts by service: ${counted(r.failures.byProvider)}`,
    "",
    `PLAYING`,
    `  by device: ${counted(r.starts.byDevice)}`,
    `  by service: ${counted(r.starts.byProvider)}`,
    `  by picture: ${counted(r.starts.byPicture)}`,
    `  by engine: ${counted(r.starts.byEngine)}`,
    `  stalls: ${r.failures.stalls} (${counted(r.failures.stallsByReason)})`,
    `  jumps: ${r.seeks.total}, ${seconds(r.seeks.seekMs)}`,
    each("jumps", r.seeks.seekMsByProvider),
    `  remuxer: ${r.remux.runsStarted} runs started, ${r.remux.viewersLeft} viewers left, ${r.remux.refusedForCapacity} refused for want of a place`,
  ].join("\n");
}

const days = Number(option("days")) || DEFAULT_DAYS;
const to = Date.now();
const from = to - days * DAY_MS;
const report = buildPlaybackReport(readRows(option("dir") ?? eventLogDir(), from), from, to);
process.stdout.write(`${process.argv.includes("--json") ? JSON.stringify(report, null, 2) : render(report)}\n`);
