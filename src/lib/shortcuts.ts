/** Player keyboard shortcuts, as handled in components/player/Player.tsx. */
export const PLAYER_SHORTCUTS: { key: string; desc: string }[] = [
  { key: "Space / K", desc: "Play or pause" },
  { key: "← / J", desc: "Back 10 seconds" },
  { key: "→ / L", desc: "Forward 10 seconds" },
  { key: "↑ / ↓", desc: "Volume" },
  { key: "M", desc: "Mute" },
  { key: "F", desc: "Full screen" },
  { key: "C", desc: "Subtitles on or off" },
  { key: "N", desc: "Next episode" },
  { key: "0 – 9", desc: "Jump to 0% – 90%" },
  { key: "Esc", desc: "Close menu, then leave the player" },
];
