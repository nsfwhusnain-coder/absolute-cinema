/**
 * How well the service has been finding and playing things, from the durable
 * event log (db/events, see src/lib/event-log.ts), and from the daily rollups
 * kept beside it (db/rollups, see src/lib/telemetry/rollups.ts).
 *
 *   bun scripts/playback-report.ts                      the last 7 days
 *   bun scripts/playback-report.ts --days 1             the last day
 *   bun scripts/playback-report.ts --json               the same numbers as JSON
 *   bun scripts/playback-report.ts --rollups --days 365 a year from the daily rollups, without the event lines
 *   bun scripts/playback-report.ts --dir ./db/events
 *
 * In Docker: docker exec absolute-cinema bun scripts/playback-report.ts
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { eventDayOfFile, eventLogDir } from "../src/lib/event-log";
import { buildPlaybackReport, countedText, parseEventLines, renderFigures, type EventRow, type PlaybackReport, type Quantiles } from "../src/lib/playback-report";
import { parseStoredRollup, summarizeRollups, type StoredRollup } from "../src/lib/telemetry/rollups";

const DAY_MS = 86_400_000;
const DEFAULT_DAYS = 7;

function option(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

function readRows(dir: string, from: number): EventRow[] {
  if (!existsSync(dir)) return [];
  const firstDay = new Date(from).toISOString().slice(0, 10);
  const files = readdirSync(dir).filter((name) => {
    const day = eventDayOfFile(name);
    return day !== null && day >= firstDay;
  });
  return files.flatMap((name) => parseEventLines(readFileSync(join(dir, name), "utf8")));
}

/** The daily rollups of the days from `from` on, oldest first. A file that is not a rollup is passed over. */
function readRollups(dir: string, from: number): StoredRollup[] {
  if (!existsSync(dir)) return [];
  const firstDay = new Date(from).toISOString().slice(0, 10);
  return readdirSync(dir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name) && name.slice(0, 10) >= firstDay)
    .sort()
    .flatMap((name) => {
      const rollup = parseStoredRollup(readFileSync(join(dir, name), "utf8"));
      return rollup ? [rollup] : [];
    });
}

const seconds = (q: Quantiles) => (q.n ? `${(q.p50 / 1000).toFixed(1)} s typical, ${(q.p90 / 1000).toFixed(1)} s at worst tenth (${q.n})` : "none");
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
    `  opening a file to remux: ${r.opens.ok} of ${r.opens.total} opened, ${seconds(r.opens.okMs)}; ${countedText(r.opens.byOutcome)}`,
    `  made ready before Play: ${r.readied.asks} asks from title pages, ${r.readied.fresh} opened a file, ${seconds(r.readied.freshMs)}`,
    `  failed starts by reason: ${countedText(r.failures.byReason)}`,
    `  failed starts by service: ${countedText(r.failures.byProvider)}`,
    "",
    `PLAYING`,
    `  by device: ${countedText(r.starts.byDevice)}`,
    `  by service: ${countedText(r.starts.byProvider)}`,
    `  by picture: ${countedText(r.starts.byPicture)}`,
    `  by engine: ${countedText(r.starts.byEngine)}`,
    `  stalls: ${r.failures.stalls} (${countedText(r.failures.stallsByReason)})`,
    `  jumps: ${r.seeks.total}, ${seconds(r.seeks.seekMs)}`,
    each("jumps", r.seeks.seekMsByProvider),
    `  remuxer: ${r.remux.runsStarted} runs started, ${r.remux.viewersLeft} viewers left, ${r.remux.refusedForCapacity} refused for want of a place`,
    "",
    ...renderFigures(r.figures),
  ].join("\n");
}

const days = Number(option("days")) || DEFAULT_DAYS;
const to = Date.now();
const from = to - days * DAY_MS;
const json = process.argv.includes("--json");
const eventsDir = option("dir") ?? eventLogDir();

if (process.argv.includes("--rollups")) {
  const rollups = readRollups(join(dirname(eventsDir), "rollups"), from);
  const figures = summarizeRollups(rollups);
  if (json) {
    process.stdout.write(`${JSON.stringify({ from, to, days: rollups.length, figures }, null, 2)}\n`);
  } else {
    const span = rollups.length ? `from ${rollups[0]!.day} to ${rollups[rollups.length - 1]!.day}` : "none stored";
    process.stdout.write(`Daily rollups, ${rollups.length} day(s), ${span} (UTC)\n\n${renderFigures(figures).join("\n")}\n`);
  }
} else {
  const report = buildPlaybackReport(readRows(eventsDir, from), from, to);
  const nothingPlayed = report.starts.total + report.failures.failedStarts + report.titles.asked === 0;
  if (nothingPlayed && !json) process.stdout.write("Nothing has been played in this period: the numbers below are empty, not zero.\n\n");
  process.stdout.write(`${json ? JSON.stringify(report, null, 2) : render(report)}\n`);
}
