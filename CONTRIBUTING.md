# Contributing

Thanks for helping improve Absolute Cinema.

## Getting set up

Follow the [Development](README.md#development) section of the README. You will need a TMDB
key; a Real-Debrid token is only needed to work on the debrid tier.

## Before opening a pull request

```bash
bun run typecheck
bun run lint
bun run test
bun run build
```

CI runs the same four steps on every pull request.

## Guidelines

- **Keep pull requests focused.** One fix or feature per PR is much easier to review.
- **Add tests for behaviour.** Playback decisions (ranking, failover, source memory) live in
  pure modules under `src/lib/playback/` so they can be unit tested without a browser.
- **Never log or return secrets.** API tokens stay server-side. Any URL that can carry a
  debrid token must pass through `src/lib/playback/debrid/token-safety.ts`.
- **New outbound fetches** from the HLS proxy must go through the existing SSRF guard in
  `src/lib/hls-proxy.ts`; run `bun run check:ssrf` after touching it.
- **UI changes:** include a before/after screenshot, and check a phone-width viewport.

## Reporting bugs

Use the bug report template. For playback problems, include the browser, the title and
episode, and whether Real-Debrid is connected. **Settings → Server → Provider health** shows
which sources were tried.

## Security issues

Please do not open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).
