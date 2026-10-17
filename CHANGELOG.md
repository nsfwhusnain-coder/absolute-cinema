# Changelog

All notable changes to Absolute Cinema. Versions follow [Semantic Versioning](https://semver.org).

## [2.8.0] - 2026-10-17

### Added
- **A crowd can no longer overheat the server or bring it down.** Every
  stream now holds a seat, and a seat costs what its stream takes of the
  machine: a 4K remux about twice a 1080p one, and the internet link is
  counted too. Past what fits, new viewers wait in a queue ("We've reached our
  limit. You're number 2 in the queue.") and their film starts by itself as
  soon as someone finishes; when the queue is full they are asked to try again
  later. The owner's profiles go to the front of the queue. docs/CAPACITY.md
  explains it all.
  - **The server watches itself every second:** its CPU (and whether its
    quota runs out), its memory, the CPU's temperature, how late the remuxer
    runs, and whether viewers are buffering. When any of them says it is at
    its limit, nobody new is let in, whatever the estimates said.
  - **In real danger it stops streams one at a time** (too hot, out of
    memory, the remuxer starved), newest and heaviest first and the owner's
    last, and those viewers see "You've been disconnected" with their place
    in the film saved and a button to rejoin the queue. Long before the
    machine's own emergency reboot.
  - Waiting for 4K while a 1080p stream would fit now, the queue offers
    "Start now in 1080p".
  - A refusal for capacity never counts against a source: the player tries no
    other server behind it, and nothing is refused or cooled down for it.
  - Settings (`CAPACITY_*` in `.env`) for the budgets, temperatures and queue,
    and a drill file to try the queue and the stops on purpose.
  - Metrics, events and a Grafana row for all of it (docs/TELEMETRY.md).
  - The remuxer's main thread is a budget of its own: every remuxed byte
    passes through its one JavaScript thread, which fills long before the
    CPU's other cores are busy. It is read on its own (the process's figure
    counts its networking and garbage-collection threads too).
  - At most two streams warm up at once: a queue let in faster than that
    raced every new stream for its first minute together and filled the
    internet link.
- **A live dashboard at `/hub`** for the owner: everyone watching right now,
  with the poster and title, who it is, the device, the quality (4K, HDR,
  Dolby Vision), the source, how far in they are, the buffer and stalls, and
  what their stream costs the server; the server's CPU, the remuxer's thread,
  temperature, memory, download and upload; charts of the last hour; the
  queue; and a feed of who started, stopped, waited or was disconnected.
  Open it signed in as an owner profile, or with its key (`HUB_KEY`) on a
  screen that is not, such as a CasaOS tile. docs/HUB.md explains it.

### Changed
- **A stream reads its file at twice its bitrate once it is a minute ahead of
  its viewer**, instead of as fast as the CDN goes. The first minute is still
  made at full speed (a start, a seek, a viewer who fell behind), and the
  stream still rests four minutes ahead, as before; only the race between is
  calmer. Three viewers starting together used to read 260 Mbit/s from their
  CDNs to serve 70, which took the remuxer's thread and the internet link from
  everyone else, and made a seek wait behind the read-ahead.
- The remuxer's run limit (`VOD_MAX_RUNS`) refusing a stream is a capacity
  refusal now: the player shows the queue instead of trying another server.

### Fixed
- `ac_remux_runs_ended_total`'s help named every reason but `session_ended`.

## [2.7.0] - 2026-10-17

### Added
- **The site keeps a history of how well it works, to look back on.** What
  every search found and did not, how starts went on each device, how much
  playback buffered and at what bit rate, how fast each CDN delivered, and how
  busy the server was: the numbers to decide later whether a provider is good
  enough, or what to build next. Nothing leaves the server; viewers are a tag,
  and no link is ever written. docs/TELEMETRY.md lists every number and why.
  - **Live metrics for Prometheus** at `/api/metrics` (with `METRICS_TOKEN`):
    the web app's, the remuxer's and the scraper's, for a Grafana dashboard of
    bandwidth up and down, viewers and remux runs, start times, stalls, bit
    rates, buffer, CDN speeds, search outcomes and the server's load.
  - **Every search's findings** (`discovery_summary`): per service, how many
    files at each quality, what the release judge made of them, the best file
    with its real height and bit rate, and whether the title had 4K, 1080p,
    web streams only, or nothing.
  - **The player reports every 30 s and when it leaves a title:** buffer,
    picture size, bit rate, its own bandwidth estimate, dropped frames,
    stalls, the audio and subtitle language, and a summary of the whole view.
  - **The remuxer reports each session** (bytes from the CDN and to players,
    connection speeds, refusals, runs and how they ended) **and the server's
    load every minute** (viewers, runs, network up and down, CPU, memory).
  - **A summary of each day is kept for good** in `db/rollups/`, and the
    event log for 400 days (it was 30). `scripts/playback-report.ts` prints
    the new numbers, and `--rollups` summarises months from the daily files.

## [2.6.3] - 2026-10-17

### Changed
- **Play goes full screen.** Pressing Play or Resume fills the screen (and
  shows HDR as HDR, which a windowed page does not); a double click leaves
  full screen. Not on iPhone or on TVs. The player's controls hide after
  2.2 s of no movement instead of 3.2 s.
- **Your audio and subtitle settings hold at every start.** With the
  original language chosen, a title plays in the language it was made in,
  even if another track was picked on it before; a dub whose track is named
  for its language ("Castellano", "Italiano") is never taken for English,
  whatever its tag says. Subtitles set to off stay off, even on a title
  where they were turned on once (unless the audio is in a language you do
  not speak).
- **A 4K file comes before a web stream even when its service has just
  failed a few starts,** and for a viewer who chose 4K, before a 1080p file.
  After 2.6.1, Avengers: Endgame started on a 1080p web stream with three 4K
  files on offer.

### Fixed
- **A slow start got a release refused to every viewer for 90 days,** and
  2.6.1's failures refused Avengers: Infinity War's 4K release that way. A
  run that is merely slow no longer condemns the file.
- A stretch of a film where a run had stopped or failed could never be
  played again in that session, or was served short.
- A connection that went silent without closing could hold a film still for
  good; it is now asked again from where it stopped. A CDN answering a
  different byte range than asked is caught instead of corrupting the film.
- Opening a film no longer asks the CDN for data ffmpeg is about to skip.

## [2.6.2] - 2026-10-17

### Fixed
- **Films with Dolby Digital Plus sound would not start in 2.6.1** (they
  loaded for ever). A setting the remuxer needs for that sound was taken
  away along with the 2.6.1 fix. It is back for every film.

## [2.6.1] - 2026-10-17

### Fixed
- **Some 4K films played as a green, blocky mess.** 2.6.0 rebuilt every
  remuxed HEVC film's decoder settings from inside the stream, to rescue the
  few releases that leave them out of the file's header. That rebuild is not
  lossless for every stream: a Dolby Vision UHD Blu-ray remux of Avengers:
  Infinity War came out undecodable. It now applies only to a file whose
  header really has no decoder settings; every other file is copied exactly
  as it was before 2.6.0.

### Changed
- **Web streams start on their sharp picture on Safari and TVs.** Their
  playlists list the renditions from 427p up, and those players start on the
  first one listed. The 1080p rendition (or the best there is) now comes
  first, and none under 1080p is offered when there is 1080p.
- **A 4K film from a slow AllDebrid connection starts sooner and stalls
  less.** A connection that is plainly far too slow is spread over several
  within a fraction of a second, the first seconds of the film are fetched
  over all of them at once, and the pieces after them are sized for how
  often AllDebrid lets one file be asked.

## [2.6.0] - 2026-10-17

### Added
- **A release is judged by the picture in its file, not by its name.** "4K"
  and "1080p" said little: every 4K release of one cartoon was an AI upscale,
  and an iPad played a 2.2 Mbit/s encode while a 10 Mbit/s one of the same
  episode was on offer. Each file is now weighed by how much picture its size
  carries for its length and codec, by its group's record, and by what its
  name admits to (upscaled, interpolated, burnt-in subtitles, Dolby Vision
  only). An upscaled or starved 4K file counts as the 1080p it really is, and
  the sharper real picture is started first; the source menu says
  "upscaled" or "low bitrate" where that is so.
- **A file is read over several connections when one is too slow for it.**
  AllDebrid gives most connections about 2.5 Mbit/s, so a 4K file on it opened
  late and then stalled. The remuxer measures what one connection delivers
  and reads over as many as the file needs (up to twelve), in pieces that
  arrive in the order they are played.
  - AllDebrid refuses a file asked for too often (an answer of "204"); its
    files are now asked no faster than it serves, and a refusal is waited out
    rather than failing the start.
  - A file the service's CDN cannot carry, even over twelve connections, is
    put behind one it can.
- **Surround sound where the viewer can hear it.** A 5.1 track is kept 5.1 for
  a TV or receiver that takes it (as Dolby Digital Plus where the device plays
  it, as 5.1 AAC where it does not) and made stereo only for devices that
  play two channels.
- **Subtitles show in iPhone fullscreen and picture-in-picture,** and no
  longer go missing for a while after a jump.

### Changed
- **A start waits a little for the best file instead of starting low.** Web
  streams are a last resort, used only when no debrid file of 1080p or better
  is to be had, and a start holds up to 20 s for a better file still being
  looked for. A sharper picture now wins over a file that needs no remuxing.
- **Automatic quality keeps to 1080p on a web stream that has it,** where a
  slow first answer could take it down to 427p.
- **The player's buffer is sized in bytes for each kind of device,** not in
  seconds. A 4K film filled a TV's or a browser's memory long before its
  seconds were up, and playback stuttered from then on.
- Starts are quicker: the answer for a title is asked for again every second
  while a debrid service is still deciding (it was every three), and a file
  is indexed a round trip sooner.
- hls.js 1.6.19.

### Fixed
- **Stuttering that began part-way into a film and did not stop.** A 4K file
  read from a slow CDN came in slower than it played, so playback caught up
  with it and stuttered from that point on, while anything already watched
  played smoothly; a buffer sized in seconds also outgrew what a browser or
  TV holds. Reading over several connections and a buffer that fits the
  device (both above) address both.
- **Some releases never started** ("could not be played"): their video kept
  its decoder settings inside the stream, not in the file's header, and the
  player was handed an empty description. They are now rebuilt from the
  stream.
- **A show could start on a web stream while a 4K file was a second away,**
  when the torrent index failed to answer: a failed search was taken for an
  empty one. It is now asked again once, and a failure is never "nothing
  more to come".
- A file labelled 1080p in the 720p place is now treated as 720p.
- Two viewers of one file stopped each other's playback; and a file made
  ready before Play was opened a second time when Play was pressed.
- A start or a jump in a remuxed file could land a hair before the point it
  aimed at and start a second, needless read of the file.

## [2.5.7] - 2026-10-11

### Fixed
- **A title's page left open kept asking for its film to be made ready, for as
  long as it stayed open.** The page renewed the request every minute with no
  end, in a tab nobody was looking at as much as in one somebody was: 36 times
  in 35 minutes for one forgotten tab, holding a place and a paused download
  for a film nobody was about to watch. It now renews only while the page is
  on screen, and only for about four minutes; coming back to the tab makes it
  ready again.
- The playback report counted those requests as files opened by a player
  ("36 of 36 opened, 0.0 s"). They are now a line of their own, and a report
  over a period in which nothing was played says so.

## [2.5.6] - 2026-10-11

### Added
- **A record of how well things are found and played, that outlives an
  update.** What the service did was only in the container's log, which is
  thrown away with the container on every update: the one time "was it like
  this before?" is asked. Every search, start, failure, stall and jump is now
  also one line under `db/events/`, kept for 30 days and never sent anywhere;
  a viewer is written as a tag, not an account, and no link is kept.
  - New in what is recorded: what each answer held (how many files, from
    which service, how tall), how long opening a file took and how it ended,
    each web provider's result, the remuxer's own lines, the title on every
    player report, what the viewer waited from opening a title to its first
    picture, and how long each jump took.
  - `bun scripts/playback-report.ts` turns it into the numbers: how many
    titles had a 4K file, a 1080p one or web streams only; how long searches,
    starts and jumps took, by device and by service; what failed, and why.
  - `EVENT_LOG=0` turns it off.
- A release turned away as another title is logged with the file it was
  judged by, not its name alone.

### Fixed
- **The remux cache grew past its limit with every restart.** The folders of
  files being prepared were only counted, and only cleaned, while the process
  that made them was running; after an update nothing could reach them and
  nothing removed them. One install held 100 GB in 74 folders, the oldest
  weeks old, under a 50 GB limit. They are now removed when the remuxer starts.

## [2.5.5] - 2026-10-11

### Fixed
- **A title that had not been opened before took seven to fifteen seconds to
  start, and one with no 4K release more than twenty.** The search for files
  answered only once all of it was done: every quality, every service, and the
  web providers' slowest scrape, though what would start was known two or
  three seconds in.
  - Each file reaches the player the moment it is known, best first, not when
    the whole group it belongs to has been tried.
  - A viewer who wants 4K is answered as soon as a 4K file is found, or as
    soon as none can be and a 1080p one is.
  - The answer says what can still arrive. The player starts a 1080p file at
    once when no 4K is coming, where it held out up to twenty seconds for one,
    and starts the best web stream when the debrid services have nothing.
  - The web providers' browser scrape, which runs up to twenty seconds, no
    longer holds the answer back once the start is decided.
  Measured on titles opened cold: the answer in 2 to 4 seconds where it took
  6 to 14, and the first picture in Chrome in 6 to 9 seconds where it took 7
  to 24. A title opened from its own page still starts in about a second.
- **AllDebrid's file started where Real-Debrid had the same one.** Between two
  files of the same height the larger started, or the one whose name sorted
  first, and that was AllDebrid's: on a CDN measured at 2.6, 30 and 79 Mbit/s
  within one hour, against a steady 220 to 300 for Real-Debrid.
  - The file on the clearly faster CDN starts; when they are level, or were
    never measured, Real-Debrid's does. A server chosen by hand still wins.
  - For the first seconds of a search only AllDebrid's file could be read
    back, and it went to the player alone and was started. It is now held
    until Real-Debrid has answered.
- **After a few titles tried one after another, or with two people watching,
  the next one started slowly or fell to a web stream.** Nothing told the
  server a viewer had left: it went on downloading the file they had been
  watching, up to four minutes ahead, and kept one of the four places for
  files being prepared. The next title started against that download, and
  with the places taken it was refused one. The player now says when it is
  done with a file, on switching, on closing and as the page goes away; the
  download stops at once and the place is free. Someone else still watching
  the same file is not affected.
- **A file replaced while it was still loading was counted as having played.**
  When a better file arrived before the first picture, the one being replaced
  could show its frame first. That frame was credited to the new file, so a
  failure to start it was handled as trouble mid-film, with retries, and its
  record said it had played.

### Added
- The debrid search logs how long each service took and when its first 1080p
  and 4K files were known.

## [2.5.4] - 2026-10-11

### Fixed
- **Now and then a different film played than the one on the poster, or
  another episode, or another show of the same name.** Releases are looked up
  by the title's IMDb id, and what the index files under an id is not always
  that title: one film out of "Amazing Films 7", The Godfather Part III under
  The Godfather, Dragon Ball Z under House of the Dragon, the 2023 One Piece
  under the 1999 one, episode 640 of a show for its first. Nothing checked,
  so whichever ranked best on size and seeders was played. A release now has
  to be the title that was asked for, judged on its name and year against
  every name the title goes by:
  - another year's film, a sequel, another film of the same series, a
    collection, or an episode filed under a film is dropped;
  - a series release dated after the season asked for first aired is a later
    show of the same name, and is dropped;
  - a file that numbers itself as another episode, or is named for another
    season of the show, or for a side series out of the same batch, is
    dropped;
  - the file's own name outranks the release's: a file named for the film is
    the film whatever collection it sits in, and a file that says it is
    another is not;
  - a file is refused when it is opened if it runs nowhere near as long as
    the title (an episode under a film of the same name, a film under an
    episode, a making-of), on web streams and Phoenix as well.

  Releases that name the title are tried before ones kept only because
  nothing in their name says otherwise, and a link stored before any of this
  is checked when it is read back. With AllDebrid, a file inside a pack is
  now asked for by the name the index gave it: that service lists a
  torrent's files in an order of its own, and the index's file number picked
  the wrong one in two packs out of five.
- **With AllDebrid or TorBox, an anime episode could be one from another
  season.** Anime is cut into seasons differently from one catalogue to the
  next, and those two services asked the index by IMDb season and episode:
  for the third episode of what TMDB calls Bleach's second season, the answer
  was episode 23 of the first. They now look anime up by its own entry, as
  Real-Debrid already did. A season or part released under a name of its own
  ("Bleach: Thousand-Year Blood War") is known as the show.
- **A file could be started on a CDN too slow to carry it.** The debrid
  services' CDNs are not equal: measured side by side on one evening,
  Real-Debrid delivered 43 to 49 Mbit/s and AllDebrid 2.5 to 8.7. Nothing
  told the player, and at equal height the AllDebrid file was often the one
  chosen: it took 8 to 20 seconds to open, then stalled. Each service in use
  is now measured every ten minutes, and a file whose CDN delivers less than
  its height needs is not started while anything else will play. It is still
  played when it is all there is, and comes back by itself when its CDN does.
- **Anime episodes started on a web stream, as low as 480p, with 1080p and 4K
  debrid files in the list.** A file that holds several languages was left
  out of the start whenever a web stream was labelled English. For a file
  that is remuxed that is wrong, since the remuxer picks the language the
  viewer wants, and most anime releases are of this kind. Such a file now
  counts as being in the viewer's language.
- **Episodes started on a 720p or 1080p web stream with 4K debrid files in
  the list.** A debrid source whose name looked like a collection never
  started on its own, a rule written for film trilogies that also matched
  "S02" and "Season 2", which is how nearly every episode is released. It
  now applies to films only.
- **One file that would not play could cost half a minute at the start of a
  title, every time.** Some files give a stream copy their sound and never a
  frame of video, and some AV1 files mark frames as starting points that a
  decoder cannot start from. The player waited out a 25-second timeout on
  them, and the next viewer was sent to the same file. Such a file is now
  given up in a few seconds, and remembered: it is not offered again, to
  anyone, and the same goes for a file refused for its length.
- **A file a device could not decode steadily played a bit, then buffered,
  over and over.** A source that fails while playing is tried again twice
  before the player moves on, and every recovery that showed a frame gave
  both tries back: a file that fails again a second after each recovery was
  never left. The tries now come back only after a minute of play without an
  error, so three failures in a minute move the player to the next source.
- **A file one device could not decode was marked down for every device.**
  What plays well is remembered per title for the whole household, and a
  start that failed because the device had no decoder for the file (an iPad
  without AV1), or no Dolby Vision, counted against the file for the
  television that plays it. Those failures are no longer held against it.
- **A browser with no HEVC decoder tried every HEVC file in turn.** Chromium
  without a hardware decoder (a remote session, a virtual machine, some
  graphics cards) still says it plays HEVC, and each file failed on its first
  frame: 46 seconds to the first picture on one machine. The decoder is now
  asked directly, and a codec it says no to is given up on that device after
  one failed start.
- **In Safari, Phoenix's files failed on the first frame.** Most are HEVC
  stored under the `hev1` name, which Apple's player will not open as a plain
  file, and nothing in their address says so. Their codec is now read off
  the start of each file, and Safari skips the ones it cannot open.

### Changed
- **Remuxed titles start and jump sooner.** A remuxed file was sent one
  keyframe interval at a time, up to 45 MB of 4K to receive before a frame
  showed. Players that can take it now get the same film in two-second
  slices: a jump lands in about four seconds where it took six to nine.
- **A title is made ready before Play is pressed.** A title's page, once
  stayed on, finds its sources and opens the one Play would start; the next
  episode gets the same as the current one nears its end. Pressing Play then
  shows a picture in about a second. This never takes anything from someone
  who is watching.

## [2.5.3] - 2026-10-10

### Fixed
- **On iPads and other devices that cannot decode AV1, playback started on a
  file they could not play, then fell back to a slow web stream.** Files from
  AllDebrid and TorBox carried their codec only when it was H.264 or HEVC,
  and not at all once read back from the link cache, so an AV1 release looked
  like any unlabelled file. It was tried first, failed on its first frame, and
  the title then played from a web source that buffered. The codec is now
  kept, AV1 included, stored with the cached link, and read from the release
  name for links cached before this.
- **One file that would not play took the next server down with it.** When a
  source failed, the player began opening the next one, which takes a few
  seconds for a file that is repackaged, and for those seconds the failed
  source was still attached and still raising errors. They were counted
  against the source being opened, which was dropped before it had loaded, so
  a 4K title could land on a 1080p file or a web stream for the sake of one
  bad release. A source being replaced is no longer listened to. Found in
  Safari's engine, where a 4K AV1 file that failed to decode cost the 4K HEVC
  file behind it; it now plays.
- **A debrid file that needs repackaging lost the start to a web stream of
  the same quality.** At equal height the ranking put anything that plays
  as-is ahead of an MKV, wherever it came from. A debrid file now comes first:
  repackaging costs a second or two at the start, on a CDN that holds its
  speed, and web streams are the ones that stall mid-film.
- **In Safari, an HEVC MP4 was tried before a file sure to play.** Apple's
  player takes HEVC in an MP4 only under the `hvc1` tag, many releases use
  `hev1`, and which one a file uses is not known until it is opened. Where the
  browser refuses `hev1` files, such a file now comes after a remuxed one of
  the same quality, which is always written as `hvc1`.
- **The Phoenix server never played.** Its CDN began refusing any request
  that carried a referrer or a browser's user agent, which is how every
  request through the proxy went out. Every attempt failed, each costing a
  failed start before the next server was tried. That CDN is now asked as a
  plain client, by the proxy and by the checks that verify and measure a
  source.

### Changed
- **A remuxed title opens up to a second sooner.** Opening one reads the
  file's head and then its index at the end, and a debrid CDN takes about two
  seconds to deliver any range, however small. The size of the file arrives
  with the first response's headers, so the end is now requested then and the
  two downloads overlap.

## [2.5.2] - 2026-10-10

### Fixed
- **HDR titles were too dark on laptop screens, and worse with the brightness
  up.** An HDR picture is graded for a screen with headroom above white; a
  laptop LCD has little, and loses the last of it as its brightness rises, so
  everything but the faces sank into black. On screens the browser does not
  report as showing HDR video, HDR titles are now kept to the standard range,
  so they follow the brightness setting like everything else, and their
  shadows and mid-tones are raised with a curve that leaves black at black.
  Picture in the player has **Standard / HDR** for HDR titles and, in
  Standard, **Brightness: Low, Medium, High**; both are remembered per device.
  Checked in Chrome and Opera (and the filter in Safari's engine).
- **Dubbed releases played as if they were the original.** Release names were
  searched for language names, which missed every tag a dub really carries
  (TRUEFRENCH, VFF, iTA, LATINO, "rus", "CZ dab", EN/FR/ES, a Russian
  tracker's name) and took "The French Dispatch" for a French release; and
  anything unrecognised was stamped English.
  - Release names are now read by their tags, against the language the title
    was made in.
  - A dub, or a release with another language's subtitles over the picture,
    no longer takes a quality slot while the original exists.
  - A file with several languages comes after one in the original alone.
  - When a file opens, its real audio tracks are checked: one with no track
    in the wanted language is passed over while another source can play.
  Profiles already default to Original audio; this makes the sources follow it.
- **Search found nothing for a misspelling.** A search that comes back empty
  (or nearly) now offers the closest titles: "intersteller", "inseption",
  "the drak knight" and "braking bad" find what was meant. A search for
  nonsense still finds nothing.
- HDR is recognised from the picture itself, so a file played directly (which
  arrives with no description) gets the same treatment as a remuxed one.

## [2.5.1] - 2026-10-10

### Fixed
- **The remuxer could use all of the server's memory.** It reads each MKV
  through a small local proxy, and that proxy never noticed ffmpeg going away:
  the runtime (Bun) does not report a disconnect on the response, only on the
  request and its socket. Every stopped run (a seek, a finished or abandoned
  episode) left its download going with nobody reading it, and the rest of
  the file arrived in memory: 20 GB in a few hours of viewing, 10 GB in twelve
  minutes with a few episodes open, until the host ran out. The same happened,
  more slowly, whenever ffmpeg was paused for running ahead of the viewer.
  - Disconnects are now detected from the request and socket, for the proxy
    and for the segments sent to the player.
  - The source is fetched in pieces (128 MB, `REMUX_WINDOW_BYTES`), the next
    only once the last has been handed to ffmpeg, so what can wait in memory
    is bounded per run.
  - A piece in flight when ffmpeg leaves is cancelled at once. It is never
    aborted: the runtime does not free an aborted download.

### Changed
- The container has a memory ceiling (`AC_MEMORY_LIMIT`, 8 GB by default), so
  a fault inside it restarts a helper process instead of exhausting the
  machine.

## [2.5.0] - 2026-10-10

### Added
- **TV remote in the player.** With nothing highlighted the picture has the
  remote: OK pauses, Left and Right skip, Up or Down bring up the controls.
  From there the D-pad moves between controls and OK presses the highlighted
  one. Back closes a submenu, then the menu, then hides the controls, then
  leaves. Play, Pause, Stop, Rewind, Fast-forward, Next and Previous work, and
  the colour buttons open Subtitles (red), Audio (green), Episodes (yellow) and
  Settings (blue). Skip Intro, Up Next, Still watching and Try again take focus
  as they appear, so OK answers them.
- **Remote buttons** in the player's Settings menu on a TV, listing all of the
  above.
- **Older TV browsers.** The site runs on smart-TV engines back to Chromium 76
  (Hisense VIDAA) and on LG webOS (Chromium 87 to 108). Before this, 76 to 87
  showed a blank page and 94 and below had no styling.
- Back on a Hisense remote (it sends Backspace) is recognised everywhere.

### Changed
- On a TV, a page focuses its main action once it has loaded: Play on Home and
  on a title, your profile on "Who's watching?".
- Back closes an open menu or dialog before it leaves the page.
- In a text field, Left and Right move the caret until it reaches the end, and
  only then move to the next control.

### Fixed
- The dark scrims behind titles and descriptions were missing on every browser
  older than Chromium 111 or Safari 16.2 (so on every TV, and on older iPads):
  gradients written for a newer colour syntax were dropped whole.
- Opening a title on a TV and pressing OK left the player: the page had put
  focus on the Back button.
- A profile deleted on another device, or a database restored from before it
  existed, left that browser on loading screens for good. It is now signed out
  and returned to the profile picker.
- The loading screen showed "UNTITLED" until the title's details arrived.
- On a TV the Search heading slid under the navigation bar.
- `scripts/update.sh` could delete the rollback image it had just printed and
  keep a stale one. The running image and the newest rollback are now kept.
- The stream scraper's runtime cache is no longer tracked in the repository.

## [2.4.0] - 2026-10-10

### Added
- **Profile pictures:** 59 characters drawn for the app (The Classics, Animals,
  Creatures, The Cast, Movie Night), offered first in the picker. New profiles
  get one by default.
- **HDR on or off** under Picture in the player, remembered per device, on
  browsers that support it (Chrome 136+, Safari 26+). The resolution badge
  shows HDR or Dolby Vision when the file states it.
- **New Series** row on Home.
- A play button on the loading screen when the browser refuses to start
  playback by itself.

### Changed
- Home, Movies and Shows no longer list anime; it has its own section, which
  now includes Chinese and Korean animation. Anime reaches Home only through
  Continue Watching and "Because you watched".
- Home leads with Trending Movies, Trending Series, New Movies and New Series.
- Seven of the older illustration sets are no longer offered; profiles using
  one keep it.
- The container runs a real init process, caps its logs, and its image no
  longer includes database backups or runtime data.

### Fixed
- Dark scenes in HDR titles were washed out: a brightness and contrast filter
  applied to HDR video raised black to grey. The picture is no longer filtered.
- Dolby Vision files without an HDR10 layer (profile 5) played green and
  purple. They are now sent as Dolby Vision to browsers that decode it and
  skipped elsewhere.
- The loading screen could stay flat, most often on tablets: its scene waited
  on the GPU with nothing behind it. A backdrop in the title's colours now
  animates from the first frame on every device, and the scene fades in over it.
- My List had no navigation bar or dock.
- A watch page opened directly on a phone or tablet could wait on the loading
  screen forever.

## [2.3.0] - 2026-10-07

### Added
- **Sleep timer:** a moon button in the player (and a row in its Settings
  menu, or press Z). Pause after 15 minutes to 2 hours of playing time, or at
  the end of this episode, the film, or after 2 or 3 episodes. A chip shows the
  time left, the last minute brings a card to add 15 minutes or watch one more
  episode, the sound fades out over the last 30 seconds, and a dark sleep
  screen that dims itself offers to pick up exactly where it stopped.
- **Profile pictures:** 140-odd illustrations in thirteen styles (adventurers,
  toons, robots, pixel art, sketches and more), any emoji, famous faces from
  TMDB, or your own photo (cropped to a square around the face). Sixteen
  colours plus any colour you like.
- **Make it yours:** twelve accent colours or any custom one; interface size
  (Default, Large, Larger); subtitle colour, font and an extra-large size with
  a live preview; skip step (5, 10, 15 or 30 seconds); skip intros
  automatically (with a button to watch them after all); when to ask "Still
  watching?"; turn off the rotating home banner; choose which rows Home shows.
- **Continue Watching moves on:** finishing an episode puts the show's next
  episode in Continue Watching ("Up next · S2 E5") instead of an older
  half-watched one. Season pages and the player's episode list tick off
  watched episodes and show progress bars for the rest.
- Player comforts: "Resumed at 42:10 · Start over", lock-screen and
  media-key controls with artwork (Control Centre, headphones, keyboards),
  keys S (skip intro), P (picture in picture), < and > (speed) and ? (all
  shortcuts), and the episode list opens on the episode playing.
- Search shows every result ("Show more results" and loading as you scroll)
  instead of the first twenty; press / anywhere to search. My List remembers
  its sort and filter.

### Changed
- Home loads its banner and rails in one request instead of about twenty,
  and the server keeps those lists fresh in the background.
- The home and browse banners no longer jump as slides change (layout shift
  went from 0.44 to 0.004), and tall title logos fit their space.
- The player no longer redraws itself on every time update, captures each
  seek-bar preview frame once instead of five times over, and compiles the
  loading scene's shaders without freezing the page as the video starts.
- Back from the player leaves the player, even after several episodes in a row.
- Season pages show the synopsis in three lines (with More) and no longer jump
  as they load.

### Fixed
- Downloads stopped after 30 seconds, and failed for titles with accents or
  non-Latin characters.
- The subtitle routes worked without signing in and could be pointed at any
  address; a trailing dot in a page address skipped the sign-in check; IPv6
  forms of private addresses passed the proxy's address check.
- Pausing while the video was buffering switched to another server and
  started playing again; choosing a server, quality or audio track while
  paused started playback.
- Switching the audio track of a 4K file dropped that server 25 seconds later.
- 4K files would not play on older iPads, iPhones and TV browsers.
- Subtitles could show twice on some streams; remembered subtitle languages
  did not match between three- and two-letter codes; real dialogue containing
  words like "advertisement" was removed from downloaded subtitles.
- The up-next countdown could fire after replaying or going back an episode,
  offered episodes that have not aired, and jumped from Specials to Season 1.
- Later episodes stopped looking for extra servers 30 seconds after the page
  opened.
- Resume could start from the beginning when the player opened before the
  saved position had arrived.
- Only a show's most recent episode resumed; any half-watched episode now
  picks up where it was left.
- Saved titles carried " · S1E3", which showed up in "Because you watched…".
- Missing titles showed "check the TMDB API key" instead of saying the title
  isn't in the catalog; bad ids looped between redirects; dates were a day (or year) early
  west of UTC; the Director was missing from some films.
- Seek-bar previews showed frames from elsewhere in the film; the mute button
  was wrong after the next episode; Space on a focused button paused instead
  of pressing it; arrows on a TV remote both seeked and moved focus; player
  menus overflowed on a phone held sideways.
- Search lost characters typed while results loaded; sign-in links lost their
  "&"; the setup screen could stick on "Checking…".
- One profile's recent searches and watched list showed in another's on a
  shared device.
- Server caches, read-ahead buffers and remux work for players that had hung
  up kept growing; sign-ups were not throttled and a burst of junk sign-ins
  could reset a locked profile's lockout.

## [2.2.0] - 2026-09-25

### Added
- **Loading scenes:** six live scenes chosen by the film's genre and painted in
  its poster colours: a ray-traced black hole, a warp through a nebula, northern
  lights over a lake, rain on a window at night, drifting embers, and ribbons of
  light, with bloom and film grain. The loading screen now shows only the title.
- Episodes button next to Settings for shows.

### Changed
- 4K first: with Best or 4K quality the player waits for the 4K search instead
  of starting the first 1080p it finds, and the search tries far more 4K
  releases, so every episode that has 4K plays in 4K.
- 4K releases are ranked by bitrate: smooth-streaming encodes come before
  80 Mbps remuxes that play a little, load a little.
- One clear glass material for every player control and menu.

### Fixed
- Seeking far ahead no longer abandons a server that was playing: the jump gets
  up to 30 seconds and is retried on the same server instead of re-searching.
- Subtitles for anime and foreign-language audio are always on, prefer the
  file's own English track, and switch to a server that has them if needed.
- Downloaded subtitles went blank on HLS servers.
- A brief Torrentio outage no longer hides Real-Debrid results for half an hour.

## [2.1.0] - 2026-09-24

### Added
- **Anime:** an Anime section, Popular Anime on Home, episodes found by Kitsu so
  differently numbered seasons play the right episode, subtitles and all audio
  tracks from inside the file, and Skip Intro / Skip Credits (AniSkip).
- **Profiles:** 26 illustrated avatars, one-tap profiles with an optional PIN,
  and theme, subtitle style and autoplay saved per profile.
- Top 10 Today, Play Something, film collections on movie pages, "Still
  watching?", and audio/subtitle choices remembered per show.
- Player: Picture fit (Fit / Fill / Stretch), one settings menu, a loading
  screen that shows each step, double-tap to seek on touch screens.
- Ready-made images for Intel/AMD and ARM, and `run.sh` / `run.ps1` that start
  everything and print the address.

### Fixed
- Play-pause-play buffering on slow servers (the server now reads ahead), and
  servers that keep rebuffering are swapped at the same spot.
- Resume starts where you left off instead of the beginning.
- Tapping or clicking the picture no longer pauses; only the play button does.
- The next episode keeps full screen.
- More Real-Debrid results for MKV releases, and 10-bit H.264 files (which no
  browser plays) are skipped.

## [2.0.0] - 2026-09-24

### Added
- **Seekable 4K for every browser.** A new remuxer turns MKV releases into keyframe-exact
  HLS: the full timeline is available immediately, seeking anywhere starts in about three
  seconds, and video is never re-encoded.
- **"Who's watching?" profile picker** with avatar colours, a PIN pad, and switching
  profiles from the navigation bar.
- **Free sign-up.** A profile needs only a name and a PIN. Admins can turn off open sign-up
  or hide the picker.
- **Rebuilt Settings** that save instantly: Profile, Playback, Appearance, Library and App
  for everyone; Connections, Profiles and System for admins.
- **Clear and Solid themes** (Clear glass by default) with six accent colours.
- Autoplay-next-episode toggle, a Download menu in the player, and remuxer status in
  System health.

### Changed
- **New player.** A small state machine decides what plays: it never switches a source
  that is playing, retries a dropped connection on the same server first, and fails over
  only when a server cannot keep up. One glass settings menu replaces the duplicated panels.
- **Faster cold starts.** Sources reach the player as soon as the server finds them, and
  the player waits briefly for a better one instead of committing to a weak first result.
- Error messages, empty states and notifications use the glass theme.
- Playback quality choices are simpler: Best, 4K, 1080p, 720p, Saver.

### Removed
- Invite codes (`REGISTRATION_INVITE_CODE`), the separate 4K-startup option, the
  transcoder service and its `TRANSCODER_*` settings, DASH playback, and the light theme.

## [1.0.0] - 2026-09-24

First public release as Absolute Cinema.
