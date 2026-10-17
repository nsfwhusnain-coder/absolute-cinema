# Capacity: how many can watch at once, and what happens past that

Absolute Cinema runs on one machine, often a home server that does other
work too. A crowd must never overheat it, run it out of memory or make it
reboot under everyone. So the server hands out **seats**: every stream holds
one, a new viewer gets one only while there is room, and past that they wait
in a queue and start by themselves when a seat frees up. If the machine gets
into real trouble anyway, it stops a few streams, one at a time, and tells
those viewers why, rather than failing everyone.

The governor lives in the remuxer (`mini-services/remuxer/governor.ts`,
wired up in `index.ts`); the page's side is `src/lib/playback/capacity.ts`.

## What a viewer sees

| Moment | What the player shows |
|---|---|
| There is room | Nothing: the film starts as it always did. |
| The server is full | **We've reached our limit.** "You're number 2 in the queue. Your film starts by itself as soon as someone finishes and there's room, or you can try again at a different time." A line under it says why when it is not just the seats (the server is cooling down, the internet connection is full...). Waiting for 4K while a 1080p stream would fit now, the card offers **Start now in 1080p**. |
| The queue is full too | **The queue is full.** "Please try again at a different time." |
| The server stopped this stream | **You've been disconnected.** "The server is struggling with capacity at the moment, so some streams had to stop to keep it running. Your place in the film is saved." **Rejoin the queue** picks the film up where it stopped. |

A capacity refusal is never taken for a broken file or server: the player
does not try another server behind it, and nothing is written against the
source (no refusal, no cooldown, no source memory).

## Seats and what they cost

A seat costs what its stream is expected to take of the machine:

| Delivery | CPU | Memory | Internet link |
|---|---|---|---|
| Remuxed here (MKV) | 0.10 core + 0.006 core per Mbit/s, of which 0.0024 per Mbit/s on the remuxer's own thread | 450 MB | download: bitrate x 1.2; upload too when the viewer is outside the home |
| Relayed by the web app (a web stream) | 0.03 core + 0.004 core per Mbit/s | 60 MB | the same |
| Read by the player from its CDN | nothing | nothing | download only, when the viewer is at home (the house shares the link) |

The bitrate is the file's own (its size over its length, refined from the
file's index once it opens); when unknown, a typical one for the picture is
assumed: a 4K remux 50 Mbit/s, a 1080p remux 20, a 4K web stream 16, a 1080p
one 6. So a 4K remux costs about twice a 1080p one in CPU, and two and a
half times in the internet link. The page's own figure is never planned below
40% of the typical one for its picture (a 4K remux at least 20 Mbit/s), so a
wrong or made-up size cannot squeeze in more streams than fit; the file's
real bitrate, read by the remuxer, replaces it once the stream opens.

A seat follows its viewer from source to source (a failover, another
quality): when the stream changes kind, the next renewal says so and the seat
costs what the new stream does. A seat whose viewer has paused for two
minutes counts for 30% of its cost: its stream rests (the remuxer stops a
paused viewer's runs after three minutes), and it comes back in full when they
press play.

**Remux streams are also kept within the remuxer's runs** (`VOD_MAX_RUNS`):
each needs one, and a second for a moment when its viewer seeks, so a quarter
of the runs is kept free for seeks (64 runs give 48 remux seats; the default of
4 gives 3). Should every run still be taken, the refusal is a capacity
refusal like any other, never a broken file.

**Budgets.** Streams are planned into 70% of the CPU the container may use,
80% of the remuxer's own thread, and 85% of its memory ceiling, plus the
internet link's budget each way (see the settings). The remuxer's thread
matters most for heavy files: every remuxed byte passes through its one
JavaScript thread on the way in and out, and on a Ryzen 7 4800H it carries
about 400 Mbit/s of video before it is full, while the CPU's other cores are
still half idle. What the site takes with nobody watching (0.3 core, 1.2 GB) is
counted first. A stream is let in when it fits beside the seats already held,
or beside what is actually measured when that is more: a start not yet felt
still counts, and an estimate that was too low is corrected by the readings.

Memory is judged by what the container holds and cannot drop. The page cache
of the remux cache is left out: the kernel gives it back the moment memory
is wanted (eight viewers showed eleven gigabytes in `memory.current`, of which
2.3 were really in use).

## The machine's level

Every second the remuxer reads its container's cgroup (CPU used, periods its
CPU quota ran out in, memory, pressure), the CPU's temperature (the hwmon
sensor of the CPU die: k10temp on AMD, coretemp on Intel) and how late its own
event loop runs. From them it judges a level, each reading with a line to
enter by and a lower one to leave by, and a time to hold a level once its
readings clear, so it does not flicker:

| Reading | Busy at (leaves below) | Critical at (leaves below) |
|---|---|---|
| CPU temperature, 5 s average | 85 C (80) | 92 C (88) |
| CPU quota ran out, share of periods in 10 s | 25% (10%) | |
| The remuxer's own thread, smoothed over 20 s | 0.9 core (0.75) | |
| Remuxer event loop, 95th percentile of 10 s (critical: its second longest stall) | 300 ms (120) | 2 s (0.8) |
| Remuxer event loop, its longest stall in 10 s | 2 s (0.8) | 5 s (2) |
| Memory held, share of the ceiling | 88% (82%) | 95% (90%) |
| Internet download, share of the budget | 95% (80%) | |
| Viewers playing who stalled in the last minute (with 4 or more playing) | 50% (25%) | |

- **ok**: viewers are let in while their streams fit.
- **busy** (held 20 s after its readings clear): nobody new is let in,
  whatever the estimates said. Everyone already watching carries on.
- **critical** (held 15 s): streams are stopped one at a time: the lowest
  priority first, then a stream playing now before a paused one (which gives
  the machine nothing back), then the one with the heaviest share of a budget,
  then the newest. A stream another viewer of the same file is watching is
  handed to them, not stopped under them. One every 8 s, or every 20 s when it is the heat (which falls
  slowly). The owner's profiles are stopped last, and only if nothing else is
  left: the machine still comes first.

A machine may have its own last resort beyond this (a script that reboots it at
a critical temperature, say): the governor acts well before it.

## The queue

- First come, first served. The owner's profiles (admins) go ahead of
  everyone else's, still in the order they came.
- Nobody jumps the queue: a smaller stream behind waits for the one in front,
  even when it alone would fit.
- Starts are spaced: at most 4 in any 10 s, and **at most two streams warming
  up at once** (the owner's are never held back). A new stream is read as
  fast as its CDN goes until it is a minute ahead of its viewer; five let in
  together raced for their first minute side by side and took 628 Mbit/s of
  an internet link that carries about 550.
- A place nobody asks about for 20 s is given up (the page closed); the page
  asks every 3 s. A better source found while waiting keeps the place.
- 25 places at most; past that, "the queue is full". The owner's profiles
  can always join, at the front.
- A stream that could never fit, even on an idle machine (a budget set too
  low for it), is turned away at once rather than left at the front of the
  queue, holding up everyone behind it.

A seat is renewed by the page every 5 s, and by every slice its stream asks
for. A seat neither renews for 75 s is given up (a closed page that sent no
goodbye). When a player closes, its seat is kept 15 s for the next episode
before it is given back; a page kept for the back button keeps it too. A seat
that lapsed while its stream was still playing (a hidden tab renewing late)
is taken back without the queue, and never more seats than the streams that
viewer has playing. A stopped stream gets nothing more: its requests in flight
end, and no run is started for it again.

A page from before the governor, which asks for no seat, still plays when its
stream fits and nobody is waiting; otherwise it is refused with a 503. A
prewarm (a stream readied before Play) runs only with room to spare.

## Settings

All in the site's `.env`; anything unset keeps its default.

| Setting | Default | |
|---|---|---|
| `CAPACITY_GATE` | `1` | `0` lets everyone in and stops nothing (the readings are still taken, for the metrics). |
| `CAPACITY_CPU_SHARE` | `0.7` | Share of the container's CPU that streams are planned into (the rest is the starts' room to race ahead). |
| `CAPACITY_MEMORY_SHARE` | `0.85` | Share of its memory ceiling. |
| `CAPACITY_REMUXER_CORES` | `0.8` | Of the remuxer's own thread (1 is all of it). |
| `CAPACITY_DOWNLINK_MBPS` | `450` | The internet download budget for streams. `0` for no limit. |
| `CAPACITY_UPLINK_MBPS` | `0` (no limit) | The upload budget, for viewers outside the home. Set it before opening the site to the internet. |
| `CAPACITY_BUSY_TEMP_C` | `85` | CPU temperature that stops new viewers (left 5 below). |
| `CAPACITY_CRITICAL_TEMP_C` | `92` | Temperature that stops streams (left 4 below). |
| `CAPACITY_QUEUE_MAX` | `25` | Places in the queue. |
| `CAPACITY_STARTS_PER_10S` | `4` | Starts let in per 10 s. |
| `CAPACITY_TEMP_PATH` | found | The sensor file, when the CPU's is not found by name. |
| `CAPACITY_DRILL_FILE` | unset | See "Drills". |

The container's own limits (`AC_MEMORY_LIMIT`, and `cpus:` in a
`docker-compose.override.yml`) are what the budgets are shares of.

Who is outside the home is told by their address: loopback, private,
link-local and carrier-grade NAT addresses (which Tailscale uses) are home.

## Drills

To try the queue card and the disconnection on purpose, point
`CAPACITY_DRILL_FILE` at a file (say `/app/db/capacity-drill.json`) and write
the readings to pretend into it; delete it to end the drill (the drill
temperature is the one the governor averages, so it takes a few seconds):

```json
{ "temperatureC": 95 }
```

`memoryCommittedBytes` and `loopLagMs` can be pretended too. Each second's
reading takes them from the file while it exists.

## Telemetry

Metrics (with the remuxer's, at `/api/metrics`): `ac_capacity_level`,
`ac_capacity_reason`, `ac_capacity_seats{class}`, `ac_capacity_queue`,
`ac_capacity_use_ratio{resource}`, `ac_capacity_cpu_cores{kind}`,
`ac_capacity_throttled_ratio`, `ac_capacity_memory_bytes{kind}`,
`ac_capacity_temperature_celsius`, `ac_capacity_loop_lag_seconds`,
`ac_capacity_requests_total{answer}`, `ac_capacity_evictions_total{reason}`,
`ac_capacity_queue_wait_seconds`.

Events (`db/events/remux-*.jsonl`): `capacity_level` (each change of level,
with the readings), `capacity_queue` (someone joined the queue),
`capacity_admit` (let in after waiting, with the wait), `capacity_full`,
`capacity_evict` (a stream stopped, with its class, bitrate, how long it had
played and the readings). The minute's `capacity_snapshot` carries the
governor's readings too. The player's `capacity_stopped` feedback is for the
record only. docs/TELEMETRY.md has the fields.

`GET /capacity` on the remuxer (inside the container) answers its whole
state: level, reasons, seats, queue, planned use of each budget and the
readings.

## Calibration

The cost model's figures come from load tests on a reference server (Ryzen 7 4800H,
8 of its 16 threads and 15 GB given to the site), with simulated viewers
fetching every slice through the web app as browsers do. See "Measured
capacity" below for the numbers they were set from.

## Read-ahead pacing

The remuxer reads a stream's file as fast as its CDN goes until the stream is
a minute ahead of its viewer, then at twice the file's bitrate (never below
8 Mbit/s), until it rests four minutes ahead; below a minute ahead (a seek, a
viewer who fell behind, a slow CDN) it reads at full speed again. Before
this, three viewers starting together read 260 Mbit/s from their CDNs to serve
70: the race took the remuxer's thread and the internet link from everyone
else, and a seek waited behind the read-ahead for its first reads.

## Measured capacity

The reference server, 17 October 2026: Ryzen 7 4800H (boost off, 2.9 GHz), the site
given 8 of its 16 threads and 15 GB, internet about 550 Mbit/s down and
45 Mbit/s up. Viewers fetched every slice through the web app, as browsers do.

| Streams | Smooth | Breaks | What runs out |
|---|---|---|---|
| 4K at 28 Mbit/s, TrueHD and AC-3, from a local test server | 8 (12 with brief stalls) | 16 | the remuxer's main thread (at about 400 Mbit/s of video moved), with the CPU half idle |
| 1080p at 6.4 Mbit/s, its TrueHD re-encoded, local test server | 16 | 24 | the CPU quota (re-encoding TrueHD is about 0.1 core a stream) |
| Real viewers (the simulator): real searches, real debrid 4K and 1080p files | 9 at once, all buffered, one brief stall | | the internet download (455-630 Mbit/s) and the remuxer's main thread (0.9 core) together |

The CPU stayed between 42 and 57 C throughout: the temperature was never the
limit on this machine with its boost off.

For viewers outside the home, the upload is the limit long before any of
this: 45 Mbit/s carries one 4K remux, or two to four 1080p streams. Set
`CAPACITY_UPLINK_MBPS` before opening the site to the internet.

What would raise it: the remuxer's main thread copies every byte of every
stream twice (from the CDN to ffmpeg, from ffmpeg's fragments to the player)
and writes and reads each fragment through the disk synchronously. Serving
fragments from memory or with the kernel's own copying, and moving the
reading off the main thread, would let the same machine carry roughly twice
the streams; past that, the internet link is the ceiling.
