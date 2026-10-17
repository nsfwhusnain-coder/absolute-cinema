/** How the live dashboard writes its numbers: short, and the same everywhere on it. */

export function mbps(bps: number | null | undefined): string {
  if (bps === null || bps === undefined || !Number.isFinite(bps)) return "—";
  const m = bps / 1e6;
  if (m >= 100) return `${Math.round(m)} Mbit/s`;
  if (m >= 10) return `${m.toFixed(0)} Mbit/s`;
  return `${m.toFixed(1)} Mbit/s`;
}

export function gigabytes(bytes: number | null | undefined): string {
  if (!bytes || !Number.isFinite(bytes)) return "—";
  const g = bytes / 1024 ** 3;
  return g >= 10 ? `${g.toFixed(0)} GB` : `${g.toFixed(1)} GB`;
}

/** 1:04:06, or 4:06 under an hour. */
export function clock(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "—";
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}

/** "just now", "12 s ago", "4 min ago", "2 h ago". */
export function ago(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 3) return "just now";
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

/** A length of time: "45 s", "12 min", "1 h 05 min". */
export function span(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${Math.floor(s / 3600)} h ${String(Math.round((s % 3600) / 60)).padStart(2, "0")} min`;
}

export function percent(share: number | null | undefined, digits = 0): string {
  if (share === null || share === undefined || !Number.isFinite(share)) return "—";
  return `${(share * 100).toFixed(digits)}%`;
}

/** How a remuxed stream's sound is carried, in words. */
export function audioWords(delivery: string | null | undefined): string {
  switch (delivery) {
    case "copy":
      return "original sound";
    case "eac3":
      return "sound converted to Dolby Digital Plus";
    case "aac51":
      return "sound converted to 5.1 AAC";
    case "aac20":
      return "sound converted to stereo";
    default:
      return delivery ?? "—";
  }
}

export function deliveryWords(delivery: string | null | undefined): string {
  switch (delivery) {
    case "remux":
      return "Remux";
    case "hls":
    case "web":
      return "Web stream";
    case "file":
    case "direct":
      return "Direct file";
    default:
      return delivery ?? "—";
  }
}

export function rangeWords(range: string | null | undefined): string | null {
  switch (range) {
    case "DV":
      return "Dolby Vision";
    case "PQ":
      return "HDR10";
    case "HLG":
      return "HLG";
    default:
      return null;
  }
}
