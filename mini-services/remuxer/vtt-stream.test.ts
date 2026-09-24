import { describe, expect, it } from "bun:test";
import { VttStreamParser, parseVttTimestamp } from "./vtt-stream";

describe("parseVttTimestamp", () => {
  it("reads both hour and minute forms", () => {
    expect(parseVttTimestamp("01:02:03.500")).toBeCloseTo(3723.5);
    expect(parseVttTimestamp("02:03.250")).toBeCloseTo(123.25);
  });
});

describe("VttStreamParser", () => {
  it("returns cues only once they are complete, across chunk boundaries", () => {
    const parser = new VttStreamParser();
    expect(parser.push("WEBVTT\n\n00:00:01.000 --> 00:00:02")).toEqual([]);
    const cues = parser.push(".500\nHello <i>there</i>\n\n00:10.000 --> 00:12.000 line:90%\nSecond\nline\n\n");
    expect(cues).toEqual([
      { start: 1, end: 2.5, text: "Hello there" },
      { start: 10, end: 12, text: "Second\nline" },
    ]);
  });

  it("handles CRLF, cue identifiers and a final unterminated cue", () => {
    const parser = new VttStreamParser();
    expect(parser.push("WEBVTT\r\n\r\n1\r\n00:00:05.000 --> 00:00:06.000\r\nA &amp; B\r\n\r\n")).toEqual([
      { start: 5, end: 6, text: "A & B" },
    ]);
    parser.push("00:00:07.000 --> 00:00:08.000\nLast");
    expect(parser.flush()).toEqual([{ start: 7, end: 8, text: "Last" }]);
  });
});
