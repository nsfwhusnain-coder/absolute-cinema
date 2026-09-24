/**
 * Incremental WebVTT reader for ffmpeg's `-f webvtt` output. Text arrives in
 * arbitrary chunks as the run progresses; complete cues (terminated by a blank
 * line) are returned as soon as they are whole.
 */

export interface VttCue {
  /** Seconds on the source timeline (the runs use -copyts). */
  start: number;
  end: number;
  text: string;
}

const TIMING = /^((?:\d+:)?\d{1,2}:\d{2}\.\d{3})\s+-->\s+((?:\d+:)?\d{1,2}:\d{2}\.\d{3})/;

export function parseVttTimestamp(value: string): number {
  const parts = value.split(":").map(Number);
  const seconds = parts.pop() ?? 0;
  const minutes = parts.pop() ?? 0;
  const hours = parts.pop() ?? 0;
  return hours * 3600 + minutes * 60 + seconds;
}

/** Tags ffmpeg keeps (<i>, <b>, <c.x>...) are dropped; the player draws plain lines. */
function plainText(lines: string[]): string {
  return lines
    .map((line) => line.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim())
    .filter(Boolean)
    .join("\n");
}

export class VttStreamParser {
  private buffer = "";

  push(chunk: string): VttCue[] {
    this.buffer += chunk.replace(/\r\n?/g, "\n");
    const cues: VttCue[] = [];
    let blank = this.buffer.indexOf("\n\n");
    while (blank !== -1) {
      const block = this.buffer.slice(0, blank);
      this.buffer = this.buffer.slice(blank + 2);
      const cue = parseBlock(block);
      if (cue) cues.push(cue);
      blank = this.buffer.indexOf("\n\n");
    }
    return cues;
  }

  /** Whatever is left when the stream ends. */
  flush(): VttCue[] {
    const cue = parseBlock(this.buffer);
    this.buffer = "";
    return cue ? [cue] : [];
  }
}

function parseBlock(block: string): VttCue | null {
  const lines = block.split("\n");
  const timingAt = lines.findIndex((line) => TIMING.test(line));
  if (timingAt === -1) return null;
  const match = lines[timingAt]!.match(TIMING)!;
  const text = plainText(lines.slice(timingAt + 1));
  if (!text) return null;
  return { start: parseVttTimestamp(match[1]!), end: parseVttTimestamp(match[2]!), text };
}
