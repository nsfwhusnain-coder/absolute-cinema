# The live dashboard (`/hub`)

One page for everything happening on the server right now: who is watching
what, at what quality, how it plays and what it costs the machine; the
server's load and the capacity governor's state (docs/CAPACITY.md); the last
hour of readings; and the latest moments. It updates every two seconds while
it is open.

## Opening it

- **Signed in as an owner profile** (an admin): open `/hub` on the site, for
  example `http://your-server:3000/hub`.
- **On a screen that is not signed in** (a wall tablet, a CasaOS tile): add
  the dashboard's key, `/hub?key=…`. The key is `HUB_KEY` from the site's
  `.env`, or `METRICS_TOKEN` when no `HUB_KEY` is set. Anyone with the link
  sees what everyone watches, so treat it like a password.

The page itself is an empty shell; everything it shows comes from
`GET /api/hub/live`, which answers only an owner's session or the key.

`HUB_LABEL` (optional) names the site at the top of the page, such as
"Production" or "Staging", for when you run more than one.

### As a CasaOS tile

CasaOS adds apps from containers, so the simplest tile is a link: in CasaOS,
add a custom app (or a bookmark widget) whose address is the dashboard's link
with its key. Nothing else needs to run; the dashboard is part of the site.

## What it shows

**Top row.** Viewers now (playing, paused, loading, and how many of them are
simulated), the queue and its longest wait, the site's CPU (cores used of its
quota, and the remuxer's own thread, which every remuxed byte passes through),
the CPU's temperature (new viewers wait from 85 C, streams stop from 92 C),
memory held (page cache left out), the internet download (from the debrid
CDNs) and upload (to viewers), and the fullest capacity budget.

**Charts** (15 minutes or an hour): streams and the queue; CPU and
temperature with the busy and critical zones shaded; the network down and up.

**Now watching.** A card for each viewer: the poster and title (with the
season and episode), who it is (the owner and simulated viewers are marked),
the device, the picture's quality (4K, 1080p, ...) and HDR or Dolby Vision,
the source and how it is delivered, where they are in it, the buffer ahead,
stalls, the server CPU their stream takes and its share of capacity. A click
opens the details: the picture size, the player's bandwidth, time stalled,
their seat, what the server sends them and reads from the CDN for them, its
remux runs and how far ahead they are, the file's codec and bitrate, and
whether the sound is the original or converted.

Streams with no player reporting for them (a load test's, or a page from
before the reports) appear too, marked as simulated.

**Capacity.** Each budget's planned use (CPU, the remuxer's thread, memory,
download, upload), and the queue with each person's wait.

**Activity.** Who started and stopped watching what, who joined the queue or
was let in, streams stopped to protect the server, and each change of the
server's level.

## Where it comes from

- The players' own reports (every 30 s, and at their first picture, a stall
  and their end), kept in memory by `src/lib/hub/live-players.ts`.
- The remuxer's `GET /capacity/live`: its sessions and runs (with each ffmpeg's
  CPU), the governor's seats and queue, an hour of readings every 5 s, and its
  latest moments (`mini-services/remuxer/live.ts`).
- Profiles from the database, titles and posters from the catalogue.

Nothing here is written down: the event log and Prometheus are the record
(docs/TELEMETRY.md). A server restart starts the dashboard's hour afresh.
