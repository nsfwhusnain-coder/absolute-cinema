# Changelog

All notable changes to Absolute Cinema. Versions follow [Semantic Versioning](https://semver.org).

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
