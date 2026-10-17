# What Absolute Cinema records, and why

Everything here stays on the server that runs the site: nothing is sent
anywhere. A viewer is written as a 16-character tag (an HMAC of their
account), never their account, address or name. A link to a file is never
written: they are signed, and they would let anyone play it.

The point is to look back. When the site is picked up again (a new feature,
a new provider, a complaint that "it stutters"), the history should already
answer: what did searches find, how often was there a 4K file, which service
failed and why, how long did starts take on which devices, how much did it
buffer, at what bit rate, how fast were the CDNs, how busy was the server.

There are four records, each for its own kind of question.

| Record | Where | Kept | Answers |
|---|---|---|---|
| Event log | `db/events/<source>-YYYY-MM-DD.jsonl` | 400 days | What happened, one line per event: each search, start, stall, jump, failure, remux session |
| Daily rollups | `db/rollups/YYYY-MM-DD.json` | for good | One summary per day, from the event log: the numbers to compare month with month |
| Live metrics | Prometheus (`/api/metrics`, scraped every 15 s) and Grafana | 400 days | How things moved over time: bandwidth, viewers, runs, CDN speeds, buffering, start times |
| Client analytics | `db/analytics/events-*.jsonl` (server-only code) | 400 days | The browser's own view: page speed, script errors, the `<video>` element |

`bun scripts/playback-report.ts --days 30` reads the event log and the
rollups and prints the answers (see "Reading it" below).

## Live metrics

`GET /api/metrics` returns every process's metrics in Prometheus' text
format: the web app's own, then the remuxer's and the scraper's, which it
fetches from their ports inside the container. It needs
`Authorization: Bearer $METRICS_TOKEN`, the token the server was given: it
says how busy the site is, which is nobody else's business. With no
`METRICS_TOKEN` set the endpoint answers 404; with the wrong token, 401. A
process that does not answer within 2 s is left out of that scrape, and
`ac_web_metrics_source_up{source="remuxer"|"scraper"}` reads 0 for it.

Labels come only from small fixed sets (a service, a quality bucket, a
device class, a reason class), never a title, a viewer or a link: every
distinct label value is a series kept for 400 days.

Quality buckets: `2160`, `1440`, `1080`, `720`, `sd`, `unknown` (see
`qualityBucket` in `src/lib/metrics.ts`; a scope film is bucketed by width).
Devices: `desktop`, `tablet`, `phone`, `tv`, `other`. Deliveries: `remux`
(an MKV the remuxer serves), `native` (a file the browser plays itself),
`web` (a web provider's HLS stream).

### Web app (`src/lib/telemetry/web-metrics.ts`)

| Metric | Type | Labels | Counted when |
|---|---|---|---|
| `ac_web_playback_answers_total` | counter | mode, cache, status (available, requestable, external, not_configured, error, empty, other) | every answer to "what can play this" |
| `ac_web_playback_answer_seconds` | histogram | mode, cache | same |
| `ac_web_discovery_outcomes_total` | counter | media, outcome (2160/1080/720/sd/web_only/nothing) | once per title, when its search has settled |
| `ac_web_discovery_sources_total` | counter | provider, origin, quality | same: every file and stream it found |
| `ac_web_discovery_judged_total` | counter | provider, verdict (tier3/tier2/tier1, upscaled, starved, hardsub, interpolated, dvOnly) | same: what the release judge said of each debrid file |
| `ac_web_debrid_resolve_seconds` | histogram | service (realdebrid/alldebrid/torbox), stage (first1080/first2160/total) | every debrid search |
| `ac_web_vod_opens_total`, `ac_web_vod_open_seconds` | counter, histogram | outcome (ok, expired, refused, remuxer_unavailable, error), prewarm | every remux open |
| `ac_web_player_first_frame_seconds` | histogram | device, delivery, service, quality | a player's first picture (from choosing the file) |
| `ac_web_player_open_to_frame_seconds` | histogram | device, delivery, quality | same (from opening the title: the viewer's wait) |
| `ac_web_player_start_failures_total` | counter | device, delivery, service, reason | a start that failed |
| `ac_web_player_stalls_total`, `ac_web_player_stall_seconds_total` | counter | device, delivery, service | a stall after the first picture, and how long |
| `ac_web_player_watch_seconds_total` | counter | device, delivery, quality | each heartbeat's playback |
| `ac_web_player_seek_seconds` | histogram | device, delivery | a jump |
| `ac_web_player_bitrate_bits` | histogram | delivery | each heartbeat: bytes loaded over the time spent loading them |
| `ac_web_player_bandwidth_bits` | histogram | device | each heartbeat: the player's own download-speed estimate |
| `ac_web_player_buffer_ahead_seconds` | histogram | device, delivery | each heartbeat |
| `ac_web_player_dropped_frames_total`, `..._decoded_frames_total` | counter | device, quality | each heartbeat |
| `ac_web_player_active_sessions` | gauge | device, delivery | players heard from in the last minute |
| `ac_web_cdn_rate_bits`, `ac_web_cdn_measurements_total` | gauge, counter | service, outcome (ok/failed) | each CDN speed measurement (cdn-rate.ts) |
| `ac_web_metrics_source_up` | gauge | source (remuxer, scraper) | each scrape of `/api/metrics`: 1 when that process was read, 0 when it was left out |

### Remuxer (`mini-services/remuxer/remux-metrics.ts`)

| Metric | Type | Labels | Counted when |
|---|---|---|---|
| `ac_remux_sessions` | gauge | | sessions open |
| `ac_remux_runs` | gauge | paused | ffmpeg runs alive |
| `ac_remux_viewers` | gauge | | viewers heard from in the last 30 s |
| `ac_remux_session_opens_total`, `ac_remux_index_seconds` | counter, histogram | outcome, cdn | a file indexed |
| `ac_remux_runs_started_total`, `ac_remux_runs_ended_total` | counter | cdn / reason | a run starting and ending |
| `ac_remux_first_fragment_seconds` | histogram | cdn | a run's first fragment |
| `ac_remux_bytes_served_total` | counter | kind (fragment/init) | bytes handed to players |
| `ac_remux_cache_bytes`, `ac_remux_disk_free_bytes` | gauge | | at each scrape |
| `ac_proxy_upstream_bytes_total` | counter | cdn | bytes read from a CDN |
| `ac_proxy_upstream_requests_total` | counter | cdn, outcome (ok/refused/error/silent/wrong_range) | each range request |
| `ac_proxy_open_requests` | gauge | cdn | range requests in flight |
| `ac_proxy_first_byte_seconds` | histogram | cdn | a CDN's time to first byte |
| `ac_proxy_lane_bits` | histogram | cdn | each measured speed of one connection |
| `ac_proxy_lanes` | gauge | cdn | connections in use for the files being read |
| `ac_proxy_turn_wait_seconds` | histogram | cdn | a request's wait for its link's turn (paced CDNs) |
| `ac_container_network_bytes` | gauge | direction (rx/tx) | the container's own traffic since it started (rate() gives up/down speed) |
| `ac_process_resident_bytes`, `ac_process_cpu_seconds` | gauge | process | at each scrape |

`cdn` is the CDN's domain (`real-debrid.com`, `debrid.it`, ...), the same as
`cdnDomainOf` in `link-pacer.ts`.

### Scraper (`mini-services/stream-scraper/scraper-metrics.ts`)

| Metric | Type | Labels |
|---|---|---|
| `ac_scraper_provider_results_total` | counter | provider, status (hit/empty/error), mode |
| `ac_scraper_provider_seconds` | histogram | provider, mode |
| `ac_scraper_provider_streams_total` | counter | provider, quality |
| `ac_scraper_requests_total` | counter | mode, cache |
| `ac_scraper_browser_scrapes_total` | counter | outcome |

## The event log

One JSON object per line: `at` (ms since the epoch), `event`, then fields.
Writer: `src/lib/event-log.ts` (`logEvent` for the web app, `recordEvent`
from any process). The events that were there before this file are listed
in the server's OPERATIONS.md; the ones below are new.

### `web` / `discovery_summary`

Once per title, when its full search has settled (the debrid services have
answered), at most once per title every ten minutes.

| Field | |
|---|---|
| `mediaType`, `tmdbId`, `season`, `episode` | the title |
| `viewer` | who asked |
| `want4k`, `qualityHint` | what the viewer's quality setting asked for |
| `outcome` | `2160`, `1080`, `720`, `sd`: the best debrid file's effective height (a 4K judged upscaled or starved is 1080; a 1440 reads as 1080; a file with no known height reads as sd), then `web_only` (web streams and no debrid file), `nothing` |
| `found` | per service: count of files/streams per quality bucket of their effective height, e.g. `{"realdebrid":{"2160":2,"1080":4},"alldebrid":{"2160":1},"vixsrc":{"1080":1}}`. A flagged 4K is counted as the 1080 it shows (its `judged` upscaled count says so) |
| `best` | the best debrid file, ranked by effective height, then tier, then score: `provider`, `height` (the height its release name claims), `effectiveHeight`, `tier`, `score`, `flags`, `bitrateBps` (the file's average bit rate), `sizeBytes`, `codec`, `container`, `releaseTitle` (a release name is not a link: a name that holds one is left out) |
| `judged` | per service: count of debrid files per verdict (`tier3`, `tier2`, `tier1`, then one each for `upscaled`, `starved`, `hardsub`, `interpolated`, and `dvOnly` for a file flagged `dv-only`) |
| `cache` | whether the answer came from the cache |
| `indexFailed` | the torrent index did not answer. Always false in a written summary for now: a search whose index failed never settles, so it is not written (the `torrentio_fetch` events record the failure) |
| `timings` | `realDebridMs` (the Real-Debrid roster's time; when it was cut short, the time it was given up), `allDebridMs`, `first1080Ms`, `first2160Ms`, `providersMs` (the web providers' time, when the answer waited for them). A time that was not reached is left out |

### `web` / `player_feedback`, new `feedbackEvent` values

`heartbeat`: every 30 s while a player is open on a title.

| Field | |
|---|---|
| `sourceId`, `provider`, `engine`, `delivery` | what is playing |
| `positionS`, `durationS` | where |
| `playing`, `paused`, `buffering` | its state now |
| `bufferAheadS` | seconds buffered ahead of the playhead |
| `decodedWidth`, `decodedHeight` | the picture now |
| `levelBitrateBps` | the rendition's declared bit rate (web streams), or the file's (remux) |
| `bytesLoaded`, `loadMs` | bytes the player downloaded since the last heartbeat, and the time spent downloading them |
| `bandwidthBps` | the player's own estimate of its download speed |
| `droppedFrames`, `decodedFrames` | since the last heartbeat |
| `stalls`, `stalledMs` | since the last heartbeat |
| `watchedMs` | playback since the last heartbeat |
| `audioLanguage`, `subtitleLanguage` | what is heard and shown (null when off) |
| `platform` | the device, as in every player report |

`session_end`: once, when the player leaves a title (sent with
`navigator.sendBeacon`, so it survives closing the tab).

| Field | |
|---|---|
| `sourceId`, `provider`, `engine`, `delivery` | the last file played |
| `endReason` | `ended`, `left`, `failed`, `switched` (another title) |
| `watchedMs`, `stalledMs`, `stalls`, `seeks` | totals for the title |
| `startupMs` | open to first picture (null when it never started) |
| `maxHeight`, `avgBitrateBps`, `bytesLoaded` | what was delivered |
| `sourcesTried` | how many files it took |

### `remux` / `remux_session_summary`

When a session ends (no one has asked for it for a while, or it was replaced).

| Field | |
|---|---|
| `session`, `cdn` | the session, and its CDN's domain |
| `durationS`, `sizeBytes`, `bitrateBps`, `videoCodec`, `dynamicRange`, `audioDelivery` | the file |
| `openMs`, `indexReads` | indexing it |
| `runs`, `runEnds` | runs started, and how each ended (counts by reason) |
| `firstFragmentMs` | the first run's first fragment |
| `bytesUpstream`, `bytesServed` | read from the CDN, handed to players |
| `laneBps` | per-connection speed seen: `min`, `median`, `max` |
| `maxLanes`, `refusals`, `silences`, `wrongRanges` | how hard the CDN was |
| `viewers` | distinct viewers who watched it |
| `openForS` | how long the session lived |

### `remux` / `capacity_snapshot`

Every 60 s while the remuxer runs: how busy the site was, for capacity planning.

| Field | |
|---|---|
| `sessions`, `runs`, `pausedRuns`, `viewers` | |
| `rxBps`, `txBps` | the container's own network, down and up, over the last minute |
| `upstreamBps`, `servedBps` | read from CDNs, handed to players, over the last minute |
| `cpuPercent` | the remuxer process; `loadAvg1` for the machine |
| `rssBytes` | the remuxer process |
| `cacheBytes`, `diskFreeBytes` | the remux cache |

## Daily rollups

After each UTC day, `db/rollups/YYYY-MM-DD.json` sums that day's event log:
searches by outcome and service, start times (median and 90th percentile) by
device and delivery, failures by reason, stalls per hour watched, hours
watched by quality, bit rates, CDN speeds, the busiest minute (viewers,
runs, bandwidth). Kept for good: a year from now the event log is gone, and
the rollups are how this month compares with that one.

## Reading it

```bash
docker exec absolute-cinema bun scripts/playback-report.ts               # the last 7 days
docker exec absolute-cinema bun scripts/playback-report.ts --days 90 --json
```

Grafana's "Absolute Cinema" dashboard shows the live metrics.
