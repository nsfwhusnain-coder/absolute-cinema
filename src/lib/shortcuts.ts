/** Player keyboard shortcuts, as handled in components/player/Player.tsx. */
export const PLAYER_SHORTCUTS: { key: string; desc: string }[] = [
  { key: "Space / K", desc: "Play or pause" },
  { key: "← / J", desc: "Skip back (10 s, or your skip step)" },
  { key: "→ / L", desc: "Skip forward" },
  { key: "↑ / ↓", desc: "Volume" },
  { key: "M", desc: "Mute" },
  { key: "F", desc: "Full screen" },
  { key: "C", desc: "Subtitles on or off" },
  { key: "S", desc: "Skip intro, recap or credits" },
  { key: "N", desc: "Next episode" },
  { key: "< / >", desc: "Slower / faster" },
  { key: "P", desc: "Picture in picture" },
  { key: "Z", desc: "Sleep timer" },
  { key: "0 – 9", desc: "Jump to 0% – 90%" },
  { key: "?", desc: "Show these shortcuts" },
  { key: "Esc", desc: "Close menu, then leave the player" },
];

/** What each remote button does in the player on a television, as decided in components/player/remote-control.ts. */
export const REMOTE_BUTTONS: { key: string; desc: string }[] = [
  { key: "OK", desc: "Play or pause, or press the highlighted control" },
  { key: "◀ / ▶", desc: "Skip back or forward (hold to keep going)" },
  { key: "▲ / ▼", desc: "Show the controls, then move between them" },
  { key: "Back", desc: "Close the menu, hide the controls, then leave" },
  { key: "⏯  ⏪  ⏩", desc: "Play or pause, rewind, fast-forward" },
  { key: "⏭ / ⏮", desc: "Next episode / start over" },
  { key: "Stop", desc: "Leave the player" },
  { key: "Red", desc: "Subtitles" },
  { key: "Green", desc: "Audio" },
  { key: "Yellow", desc: "Episodes" },
  { key: "Blue", desc: "Settings" },
];
