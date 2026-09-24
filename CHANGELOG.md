# Changelog

All notable changes to Absolute Cinema. Versions follow [Semantic Versioning](https://semver.org).

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
