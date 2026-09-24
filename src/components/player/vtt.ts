export interface TimedCue {
  start: number;
  end: number;
  text: string;
}

const TIMING = /^((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})\s+-->\s+((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})/;

function seconds(stamp: string): number {
  const parts = stamp.replace(",", ".").split(":").map(Number);
  return parts.reduce((total, part) => total * 60 + part, 0);
}

/** WebVTT (or SRT-shaped) text to cues in time order, markup stripped. */
export function parseVtt(source: string): TimedCue[] {
  const cues: TimedCue[] = [];
  const blocks = source.replace(/\r\n?/g, "\n").split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n");
    const at = lines.findIndex((line) => TIMING.test(line));
    if (at < 0) continue;
    const match = lines[at]!.match(TIMING)!;
    const text = lines
      .slice(at + 1)
      .join("\n")
      .replace(/<[^>]+>/g, "")
      .replace(/\{\\[^}]*\}/g, "")
      .trim();
    if (text) cues.push({ start: seconds(match[1]!), end: seconds(match[2]!), text });
  }
  return cues.sort((a, b) => a.start - b.start);
}
