# Changelog

All notable changes to Absolute Cinema. Versions follow [Semantic Versioning](https://semver.org).

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
